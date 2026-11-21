import { stat } from "node:fs/promises";
import { makeSection, type FileEntry, type Report } from "./report.ts";
import { safetyStopApplies } from "./safety-stops.ts";
import { scan, type ScannedFile } from "./scan.ts";

/**
 * Options for a comparison. Quick compare is currently the only kind; Deep verify and
 * user Exclusions will be added here.
 */
export interface CompareOptions {}

/**
 * Compares the Primary with the Replica by Quick compare. Reads both drives; writes
 * nothing to either. Rejects if either folder is missing or is not a folder.
 */
export async function compare(
  primary: string,
  replica: string,
  _options: CompareOptions = {},
): Promise<Report> {
  await Promise.all([assertFolder("Primary", primary), assertFolder("Replica", replica)]);
  const [primaryFiles, replicaFiles] = await Promise.all([
    scan("Primary", primary),
    scan("Replica", replica),
  ]);
  const newFiles: FileEntry[] = [];
  const changed: FileEntry[] = [];
  const deleted: FileEntry[] = [];
  for (const [key, file] of primaryFiles) {
    const counterpart = replicaFiles.get(key);
    if (counterpart === undefined) newFiles.push({ path: file.path, size: file.size });
    else if (!quickEqual(file, counterpart)) changed.push({ path: file.path, size: file.size });
  }
  const replicaTotals = { count: replicaFiles.size, totalSize: 0 };
  for (const [key, file] of replicaFiles) {
    replicaTotals.totalSize += file.size;
    if (!primaryFiles.has(key)) deleted.push({ path: file.path, size: file.size });
  }
  const deletedSection = makeSection(deleted);
  return {
    new: makeSection(newFiles),
    changed: makeSection(changed),
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
  const dateGap = a.mtimeNs > b.mtimeNs ? a.mtimeNs - b.mtimeNs : b.mtimeNs - a.mtimeNs;
  return a.kind === b.kind && a.size === b.size && dateGap < SAME_DATE_TOLERANCE_NS;
}

async function assertFolder(role: "Primary" | "Replica", path: string): Promise<void> {
  const stats = await stat(path).catch((error: NodeJS.ErrnoException) => {
    throw new Error(`The ${role} folder ${path} cannot be read (${error.code ?? error.message})`, {
      cause: error,
    });
  });
  if (!stats.isDirectory()) throw new Error(`The ${role} ${path} is not a folder`);
}
