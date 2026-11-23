import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { exclusionMatcher } from "./exclusions.ts";
import { Sha256Hasher, type Hasher } from "./hashing.ts";
import { findMoveCandidates } from "./moves.ts";
import { reporter, type CompareProgress } from "./progress.ts";
import { makeMovesSection, makeSection, type FileEntry, type Report } from "./report.ts";
import { sameDate } from "./same-date.ts";
import { safetyStopApplies } from "./safety-stops.ts";
import { matchKey, readFailure, scan, type ScannedFile } from "./scan.ts";
import type { ItemCounter } from "./volumes.ts";

/** Options for a comparison. Quick compare is currently the only kind; Deep verify will be added here. */
export interface CompareOptions {
  /**
   * The owner's Exclusions: path patterns left out on both drives, as `exclusions.ts` describes. What
   * they match is never reported, so never copied, moved or deleted. Each must pass `checkExclusion`.
   */
  exclusions?: readonly string[];
  /** Confirms move candidates by checksum. Defaults to SHA-256 (ADR 0010). */
  hasher?: Hasher;
  /**
   * Gives each drive's item count before scanning, for `onProgress`. Without it, scanning progress
   * has no total. Called with the folders given to `compare`.
   */
  itemCounter?: ItemCounter;
  /** Called as the comparison goes on, with how far it has got. What it throws is ignored. */
  onProgress?: (progress: CompareProgress) => void;
}

/**
 * Compares the Primary with the Replica by Quick compare, leaving out on both what the Exclusions
 * match. Files moved on the Primary are reported as moves once their contents are confirmed
 * identical by checksum; that reads both copies of each in full. Shortcuts are compared as
 * shortcuts, never followed. What cannot be read on the Primary is listed in `unreadable` and left
 * out, and its Replica copies are never reported as deleted. Reads both drives; writes nothing to
 * either. Rejects if either folder is missing or is not a folder, or
 * if anything on the Replica cannot be read. Reports its progress to `options.onProgress`: items
 * scanned out of both drives' item counts, then bytes read to confirm moves.
 */
export async function compare(
  primary: string,
  replica: string,
  options: CompareOptions = {},
): Promise<Report> {
  const isExcluded = exclusionMatcher(options.exclusions ?? []);
  const tellProgress = reporter(options.onProgress);
  const [, , total] = await Promise.all([
    assertFolder("Primary", primary),
    assertFolder("Replica", replica),
    itemTotal(options.itemCounter, primary, replica),
  ]);
  let scanned = 0;
  const scanning = () => tellProgress({ phase: "scanning", scanned, ...(total === undefined ? {} : { total }) });
  scanning();
  const onListed = (items: number) => {
    scanned += items;
    scanning();
  };
  const [{ files: primaryFiles, unreadable }, { files: replicaFiles }] = await Promise.all([
    scan("Primary", primary, isExcluded, onListed),
    scan("Replica", replica, isExcluded, onListed),
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
  const candidates = findMoveCandidates(primaryOnly, movable).filter((candidate) => !cannotRead.has(candidate.primary));
  // Each candidate is read in full on both drives.
  const totalBytes = candidates.reduce((total, candidate) => total + 2 * candidate.primary.size, 0);
  /** Bytes of the candidates already checked, whether or not they could be read in full. */
  let checkedBefore = 0;
  if (candidates.length > 0) tellProgress({ phase: "checking moves", checkedBytes: 0, totalBytes });
  for (const candidate of candidates) {
    const bytes = 2 * candidate.primary.size;
    let read = 0;
    const onRead = (chunk: number) => {
      read += chunk;
      // A file that grew since it was scanned must not take the bar past this candidate.
      tellProgress({ phase: "checking moves", checkedBytes: checkedBefore + Math.min(read, bytes), totalBytes });
    };
    // One at a time: reading many files at once makes a spinning drive seek back and forth.
    const [primarySum, replicaSum] = await Promise.allSettled([
      hasher.checksum(join(primary, candidate.primary.path), onRead),
      hasher.checksum(join(replica, candidate.replica.path), onRead),
    ]);
    checkedBefore += bytes;
    // Not read in full (unreadable, or changed since the scan): the bar still moves past it.
    if (read !== bytes) tellProgress({ phase: "checking moves", checkedBytes: checkedBefore, totalBytes });
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

/** Both drives' item counts together, or `undefined` without a counter or when either has no usable count. */
async function itemTotal(counter: ItemCounter | undefined, primary: string, replica: string): Promise<number | undefined> {
  if (counter === undefined) return undefined;
  const count = (root: string) => counter.itemCount(root).catch(() => undefined);
  const [onPrimary, onReplica] = await Promise.all([count(primary), count(replica)]);
  return onPrimary === undefined || onReplica === undefined ? undefined : onPrimary + onReplica;
}

async function assertFolder(role: "Primary" | "Replica", path: string): Promise<void> {
  const stats = await stat(path).catch((error: NodeJS.ErrnoException) => {
    throw new Error(`The ${role} folder ${path} cannot be read (${error.code ?? error.message})`, {
      cause: error,
    });
  });
  if (!stats.isDirectory()) throw new Error(`The ${role} ${path} is not a folder`);
}
