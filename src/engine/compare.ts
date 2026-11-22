import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { Sha256Hasher, type Hasher } from "./hashing.ts";
import { findMoveCandidates } from "./moves.ts";
import { makeMovesSection, makeSection, type FileEntry, type Report } from "./report.ts";
import { sameDate } from "./same-date.ts";
import { safetyStopApplies } from "./safety-stops.ts";
import { matchKey, readFailure, scan, type ScannedFile } from "./scan.ts";

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
 * full. Shortcuts are compared as shortcuts, never followed. What cannot be read on the Primary is
 * listed in `unreadable` and left out, and its Replica copies are never reported as deleted. Reads
 * both drives; writes nothing to either. Rejects if either folder is missing or is not a folder, or
 * if anything on the Replica cannot be read.
 */
export async function compare(
  primary: string,
  replica: string,
  options: CompareOptions = {},
): Promise<Report> {
  await Promise.all([assertFolder("Primary", primary), assertFolder("Replica", replica)]);
  const [{ files: primaryFiles, unreadable }, { files: replicaFiles }] = await Promise.all([
    scan("Primary", primary),
    scan("Replica", replica),
  ]);
  const primaryOnly: ScannedFile[] = [];
  const changed: ScannedFile[] = [];
  for (const [key, file] of primaryFiles) {
    const counterpart = replicaFiles.get(key);
    if (counterpart === undefined) primaryOnly.push(file);
    else if (!quickEqual(file, counterpart)) changed.push(file);
  }
  // An Update would read these, so check now that it can. Files that match their Replica copy are
  // not read, so they are not checked: there is nothing to copy.
  const cannotRead = new Set<ScannedFile>();
  await Promise.all(
    [...primaryOnly, ...changed].map(async (file) => {
      if (file.kind !== "file") return;
      await access(join(primary, file.path), constants.R_OK).catch((error: NodeJS.ErrnoException) => {
        cannotRead.add(file);
        unreadable.push({ path: file.path, folder: false, reason: readFailure(error) });
      });
    }),
  );
  // A Replica file at or under a path that could not be read on the Primary may still be there: it is
  // never treated as deleted, nor as one end of a move.
  // Looked up by the file's path and each folder above it, so the cost is per folder level, not per
  // unreadable item.
  const unreadableKeys = new Set(unreadable.map((item) => matchKey(item.path)));
  const keptBack = (file: ScannedFile) => {
    if (unreadableKeys.size === 0) return false;
    const key = matchKey(file.path);
    for (let end = key.length; end > 0; end = key.lastIndexOf("/", end - 1)) {
      if (unreadableKeys.has(key.slice(0, end))) return true;
    }
    return false;
  };
  const replicaOnly: ScannedFile[] = [];
  const replicaTotals = { count: replicaFiles.size, totalSize: 0 };
  for (const [key, file] of replicaFiles) {
    replicaTotals.totalSize += file.size;
    if (!primaryFiles.has(key) && !keptBack(file)) replicaOnly.push(file);
  }
  const hasher = options.hasher ?? new Sha256Hasher();
  const moves = [];
  /**
   * Replica files that look like an unreadable Primary file moved (same name, size and date): kept,
   * as any of them may be its only backup. Every lookalike counts, not just a unique one.
   */
  const copiesOfUnreadable = new Set<ScannedFile>();
  const lookalikeKey = (file: ScannedFile) => `${nameOf(file.path)}\0${file.size}`;
  const unreadableByName = new Map<string, ScannedFile[]>();
  for (const file of cannotRead) unreadableByName.set(lookalikeKey(file), [...(unreadableByName.get(lookalikeKey(file)) ?? []), file]);
  for (const file of replicaOnly) {
    if (file.kind !== "file") continue;
    const unreadableFiles = unreadableByName.get(lookalikeKey(file)) ?? [];
    if (unreadableFiles.some((missing) => sameDate(missing.mtimeNs, file.mtimeNs))) copiesOfUnreadable.add(file);
  }
  // Lookalikes are never one end of a move either: a rename would take the backup from where it was.
  const movable = replicaOnly.filter((file) => !copiesOfUnreadable.has(file));
  for (const candidate of findMoveCandidates(primaryOnly, movable)) {
    if (cannotRead.has(candidate.primary)) continue;
    // One at a time: reading many files at once makes a spinning drive seek back and forth.
    const [primarySum, replicaSum] = await Promise.allSettled([
      hasher.checksum(join(primary, candidate.primary.path)),
      hasher.checksum(join(replica, candidate.replica.path)),
    ]);
    if (primarySum.status === "rejected") {
      // The Primary file cannot be read (damage, say): skipped like any other, and its copy kept.
      cannotRead.add(candidate.primary);
      copiesOfUnreadable.add(candidate.replica);
      unreadable.push({ path: candidate.primary.path, folder: false, reason: readFailure(primarySum.reason as NodeJS.ErrnoException) });
      continue;
    }
    // Contents that differ, or a Replica copy that cannot be read to confirm, are not a confirmed
    // move: it stays a new file and a deleted file, and the Update says why if the copy fails too.
    if (replicaSum.status === "fulfilled" && primarySum.value === replicaSum.value) moves.push(candidate);
  }
  const movedPrimary = new Set(moves.map((move) => move.primary));
  const movedReplica = new Set(moves.map((move) => move.replica));
  const entry = (file: ScannedFile): FileEntry => ({ path: file.path, size: file.size });
  const readable = (file: ScannedFile) => !cannotRead.has(file);
  const deletedSection = makeSection(
    replicaOnly.filter((file) => !movedReplica.has(file) && !copiesOfUnreadable.has(file)).map(entry),
  );
  return {
    new: makeSection(primaryOnly.filter((file) => !movedPrimary.has(file) && readable(file)).map(entry)),
    changed: makeSection(changed.filter(readable).map(entry)),
    moves: makeMovesSection(moves.map(({ primary, replica }) => ({ from: replica.path, to: primary.path, size: primary.size }))),
    deleted: deletedSection,
    unreadable: unreadable.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    replica: replicaTotals,
    safetyStop: safetyStopApplies(deletedSection, replicaTotals),
  };
}

/**
 * Quick compare: two files are equal when they are the same kind of entry, their sizes match, and
 * their modification dates count as the same (`sameDate`). Two shortcuts must also point to the
 * same path. Contents are not read, and shortcuts are not followed.
 */
function quickEqual(a: ScannedFile, b: ScannedFile): boolean {
  return a.kind === b.kind && a.size === b.size && sameDate(a.mtimeNs, b.mtimeNs) && a.target === b.target;
}

/** The last name in `path`: the file's own name, without its folders. */
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

async function assertFolder(role: "Primary" | "Replica", path: string): Promise<void> {
  const stats = await stat(path).catch((error: NodeJS.ErrnoException) => {
    throw new Error(`The ${role} folder ${path} cannot be read (${error.code ?? error.message})`, {
      cause: error,
    });
  });
  if (!stats.isDirectory()) throw new Error(`The ${role} ${path} is not a folder`);
}
