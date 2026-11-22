import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Sha256Hasher, type Hasher } from "./hashing.ts";
import { findMoveCandidates } from "./moves.ts";
import { makeMovesSection, makeSection, type FileEntry, type Report } from "./report.ts";
import { safetyStopApplies } from "./safety-stops.ts";
import { scan, type ScannedFile } from "./scan.ts";

/**
 * Options for a comparison. Quick compare is currently the only kind; Deep verify and
 * user Exclusions will be added here.
 */
export interface CompareOptions {
  /** Confirms move candidates by checksum. Defaults to SHA-256 (ADR 0010). */
  hasher?: Hasher;
}

/**
 * Compares the Primary with the Replica by Quick compare. Files moved on the Primary are reported as
 * moves once their contents are confirmed identical by checksum; that reads both copies of each in
 * full. Reads both drives; writes nothing to either. Rejects if either folder is missing or is not
 * a folder.
 */
export async function compare(
  primary: string,
  replica: string,
  options: CompareOptions = {},
): Promise<Report> {
  await Promise.all([assertFolder("Primary", primary), assertFolder("Replica", replica)]);
  const [primaryFiles, replicaFiles] = await Promise.all([
    scan("Primary", primary),
    scan("Replica", replica),
  ]);
  const primaryOnly: ScannedFile[] = [];
  const changed: FileEntry[] = [];
  for (const [key, file] of primaryFiles) {
    const counterpart = replicaFiles.get(key);
    if (counterpart === undefined) primaryOnly.push(file);
    else if (!quickEqual(file, counterpart)) changed.push({ path: file.path, size: file.size });
  }
  const replicaOnly: ScannedFile[] = [];
  const replicaTotals = { count: replicaFiles.size, totalSize: 0 };
  for (const [key, file] of replicaFiles) {
    replicaTotals.totalSize += file.size;
    if (!primaryFiles.has(key)) replicaOnly.push(file);
  }
  const hasher = options.hasher ?? new Sha256Hasher();
  const moves = [];
  for (const candidate of findMoveCandidates(primaryOnly, replicaOnly, sameDate)) {
    // One at a time: reading many files at once makes a spinning drive seek back and forth.
    const [primarySum, replicaSum] = await Promise.all([
      hasher.checksum(join(primary, candidate.primary.path)),
      hasher.checksum(join(replica, candidate.replica.path)),
    ]);
    // Contents that differ are not the same file moved: it stays a new file and a deleted file.
    if (primarySum === replicaSum) moves.push(candidate);
  }
  const movedPrimary = new Set(moves.map((move) => move.primary));
  const movedReplica = new Set(moves.map((move) => move.replica));
  const entry = (file: ScannedFile): FileEntry => ({ path: file.path, size: file.size });
  const deletedSection = makeSection(replicaOnly.filter((file) => !movedReplica.has(file)).map(entry));
  return {
    new: makeSection(primaryOnly.filter((file) => !movedPrimary.has(file)).map(entry)),
    changed: makeSection(changed),
    moves: makeMovesSection(moves.map(({ primary, replica }) => ({ from: replica.path, to: primary.path, size: primary.size }))),
    deleted: deletedSection,
    replica: replicaTotals,
    safetyStop: safetyStopApplies(deletedSection, replicaTotals),
  };
}

/**
 * How far apart two modification dates may be and still count as the same: under a hundredth of
 * a second. Absorbs tiny date differences a copy can introduce, without missing real edits.
 */
const SAME_DATE_TOLERANCE_NS = 10_000_000n;

/**
 * Quick compare: two files are equal when they are the same kind of entry, their sizes match, and
 * their modification dates are less than `SAME_DATE_TOLERANCE_NS` apart. Contents are not read.
 */
function quickEqual(a: ScannedFile, b: ScannedFile): boolean {
  return a.kind === b.kind && a.size === b.size && sameDate(a.mtimeNs, b.mtimeNs);
}

/** Whether two modification dates, in nanoseconds, count as the same: less than `SAME_DATE_TOLERANCE_NS` apart. */
export function sameDate(a: bigint, b: bigint): boolean {
  return (a > b ? a - b : b - a) < SAME_DATE_TOLERANCE_NS;
}

async function assertFolder(role: "Primary" | "Replica", path: string): Promise<void> {
  const stats = await stat(path).catch((error: NodeJS.ErrnoException) => {
    throw new Error(`The ${role} folder ${path} cannot be read (${error.code ?? error.message})`, {
      cause: error,
    });
  });
  if (!stats.isDirectory()) throw new Error(`The ${role} ${path} is not a folder`);
}
