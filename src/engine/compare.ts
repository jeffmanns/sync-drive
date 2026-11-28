import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import { exclusionMatcher } from "./exclusions.ts";
import { Sha256Hasher, type Hasher } from "./hashing.ts";
import { findMoveCandidates } from "./moves.ts";
import { reporter, type CompareProgress } from "./progress.ts";
import { makeMovesSection, makeSection, type ContentMismatch, type FileEntry, type Report } from "./report.ts";
import { sameDate } from "./same-date.ts";
import { safetyStopApplies } from "./safety-stops.ts";
import { checkOnlyFolder, findOnlyFolder } from "./only-folder.ts";
import { matchKey, readFailure, scan, type ScannedFile } from "./scan.ts";
import { readLimitsFor, type ReadLimits } from "./reads-at-once.ts";
import type { DriveKind, ItemCounter } from "./volumes.ts";

/** Options for a comparison: a Quick compare unless `deep` is given. */
export interface CompareOptions {
  /**
   * Deep verify: files a Quick compare judges equal are also read in full on both drives, and
   * judged equal only if their checksums match. Those that do not are content mismatches.
   */
  deep?: boolean;
  /**
   * The owner's Exclusions: path patterns left out on both drives, as `exclusions.ts` describes. What
   * they match is never reported, so never copied, moved or deleted. Each must pass `checkExclusion`.
   */
  exclusions?: readonly string[];
  /**
   * Limits the comparison to this folder (relative to the top of the drives, using `/`): nothing
   * outside it is scanned or reported, and the Replica's totals for the Safety stop are the folder's.
   * Found on each drive regardless of letter case; a folder not yet on the Replica is empty there.
   * Must pass `checkOnlyFolder`. Without it, the whole drives are compared.
   */
  only?: string;
  /** Confirms move candidates, and with `deep` every file, by checksum. Defaults to SHA-256 (ADR 0010). */
  hasher?: Hasher;
  /**
   * Gives each drive's item count before scanning, for `onProgress`. Without it, scanning progress
   * has no total. Called with the folders given to `compare`.
   */
  itemCounter?: ItemCounter;
  /**
   * Tells whether each drive is solid state, to choose how many files to read from it at once for
   * Deep verify and to confirm moves (`readsAtOnce`). Without it, one at a time from each. Called
   * with the folders given to `compare`. Never changes the Report.
   */
  driveKind?: DriveKind;
  /** Called as the comparison goes on, with how far it has got. What it throws is ignored. */
  onProgress?: (progress: CompareProgress) => void;
}

/**
 * Compares the Primary with the Replica by Quick compare, leaving out on both what the Exclusions
 * match. With `options.deep` (Deep verify), files the Quick compare judges equal are also read in full
 * on both drives: those whose checksums differ are content mismatches, reported only in
 * `anomalies.contentMismatch`. A Primary file that cannot be read in full then is unreadable; a
 * Replica copy the drive cannot read (EIO) is a content mismatch, saying why. Changed files whose
 * Replica copy is newer are also flagged in `anomalies.replicaNewer`, by either kind of comparison.
 * Files moved on the Primary are reported as moves once their contents are confirmed
 * identical by checksum; that reads both copies of each in full. Shortcuts are compared as
 * shortcuts, never followed. What cannot be read on the Primary is listed in `unreadable` and left
 * out, and its Replica copies are never reported as deleted. With `options.only`, compares that
 * folder alone (ADR 0017). Reads both drives; writes nothing to
 * either. Rejects if either folder is missing or is not a folder, if
 * anything else on the Replica cannot be read, or if `options.only` cannot be compared on its own (see
 * `findOnlyFolder`). Reports its progress to `options.onProgress`: items
 * scanned out of both drives' item counts, then with Deep verify bytes read to verify contents, then
 * bytes read to confirm moves.
 */
export async function compare(
  primary: string,
  replica: string,
  options: CompareOptions = {},
): Promise<Report> {
  const isExcluded = exclusionMatcher(options.exclusions ?? []);
  const { only } = options;
  if (only !== undefined) checkOnlyFolder(only, isExcluded);
  const tellProgress = reporter(options.onProgress);
  // Deep verify always reads files, so asked while the drives are scanned (it never rejects). A Quick
  // compare asks only if it has moves to confirm.
  const earlyReadLimits = options.deep === true ? readLimitsFor(options.driveKind, primary, replica) : undefined;
  const readLimits = () => earlyReadLimits ?? readLimitsFor(options.driveKind, primary, replica);
  const [, , total] = await Promise.all([
    assertFolder("Primary", primary),
    assertFolder("Replica", replica),
    // The item counts are for whole drives, so a comparison of one folder has no total.
    only === undefined ? itemTotal(options.itemCounter, primary, replica) : undefined,
  ]);
  // The folder as stored on each drive. Not yet on the Replica: nothing there to compare with.
  // Found on both drives at once; when both fail, the Primary's reason is the one given.
  const [primaryFolder, replicaFolder] =
    only === undefined
      ? ["", ""]
      : await Promise.allSettled([findOnlyFolder("Primary", primary, only), findOnlyFolder("Replica", replica, only)]).then(
          ([onPrimary, onReplica]) => {
            if (onPrimary.status === "rejected") throw onPrimary.reason;
            if (onReplica.status === "rejected") throw onReplica.reason;
            return [onPrimary.value, onReplica.value] as const;
          },
        );
  let scanned = 0;
  const scanning = () => tellProgress({ phase: "scanning", scanned, ...(total === undefined ? {} : { total }) });
  scanning();
  const onListed = (items: number) => {
    scanned += items;
    scanning();
  };
  const [{ files: primaryFiles, unreadable }, { files: replicaFiles }] = await Promise.all([
    scan("Primary", primary, isExcluded, onListed, primaryFolder),
    replicaFolder === undefined ? { files: new Map<string, ScannedFile>() } : scan("Replica", replica, isExcluded, onListed, replicaFolder),
  ]);
  const primaryOnly: ScannedFile[] = [];
  const changed: ScannedFile[] = [];
  /** Files a Quick compare judges equal, with their Replica copies: what a Deep verify reads. */
  const quickEqualPairs: Array<{ primary: ScannedFile; replica: ScannedFile }> = [];
  for (const [key, file] of primaryFiles) {
    const counterpart = replicaFiles.get(key);
    if (counterpart === undefined) primaryOnly.push(file);
    else if (!quickEqual(file, counterpart)) changed.push(file);
    else quickEqualPairs.push({ primary: file, replica: counterpart });
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
  const hasher = options.hasher ?? new Sha256Hasher();
  const contentMismatch: ContentMismatch[] = [];
  if (options.deep === true) {
    const verified = await verifyContents(quickEqualPairs, { primary, replica, hasher, limits: await readLimits(), tellProgress });
    // Read in full just now, so these need no access check like the changed files above.
    changed.push(...verified.changedWhileRead);
    contentMismatch.push(...verified.contentMismatch);
    for (const { file, reason } of verified.unreadable) {
      cannotRead.add(file);
      unreadable.push({ path: file.path, folder: false, reason });
    }
  }
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
  // Each candidate is read in full on both drives, several at once where the drives allow.
  const sums =
    candidates.length === 0
      ? []
      : await readPairs(candidates, { phase: "checking moves", primary, replica, hasher, limits: await readLimits(), tellProgress }, (read) => read());
  // Taken in the candidates' order, so the Report is the same however the reads finished.
  for (const [i, candidate] of candidates.entries()) {
    const [primarySum, replicaSum] = sums[i]!;
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
    anomalies: {
      replicaNewer: makeSection(changed.filter((file) => readable(file) && replicaNewer(file, replicaFiles)).map(entry)),
      contentMismatch: makeSection(contentMismatch),
    },
    moves: makeMovesSection(moves.map(({ primary, replica }) => ({ from: replica.path, to: primary.path, size: primary.size }))),
    deleted: deletedSection,
    unreadable: unreadable.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    replica: replicaTotals,
    safetyStop: safetyStopApplies(deletedSection, replicaTotals),
  };
}

/** What a Deep verify found among the files a Quick compare judges equal. */
interface Verified {
  /** Files whose size or date changed on either drive while they were read: a Quick compare would now call them changed. */
  changedWhileRead: ScannedFile[];
  contentMismatch: ContentMismatch[];
  /** Primary files that could not be read in full, and why. */
  unreadable: Array<{ file: ScannedFile; reason: string }>;
}

/**
 * Deep verify: reads each pair in `quickEqualPairs` (files a Quick compare judges equal) in full on
 * both drives, several at once where the drives allow (`readPairs`), and reports each regular file
 * whose checksums differ as a content mismatch. A Replica copy the drive could not read (EIO) is a
 * content mismatch too, saying why. Rejects on any other failure to read a Replica copy, as for
 * anything else on the Replica (ADR 0015).
 */
async function verifyContents(
  quickEqualPairs: ReadonlyArray<{ primary: ScannedFile; replica: ScannedFile }>,
  reading: Omit<PairReading, "phase">,
): Promise<Verified> {
  const { primary, replica } = reading;
  const verified: Verified = { changedWhileRead: [], contentMismatch: [], unreadable: [] };
  const files = quickEqualPairs.filter((pair) => pair.primary.kind === "file");
  const outcomes = await readPairs(files, { ...reading, phase: "verifying" }, async (read, pair) => {
    const [primarySum, replicaSum] = await read();
    if (replicaSum.status === "rejected") {
      const error = replicaSum.reason as NodeJS.ErrnoException;
      // Anything but the drive failing to read it (a missing file, no permission, a lost drive) stops
      // the comparison, as on the rest of the Replica (ADR 0015): it says nothing about the copy.
      if (error.code !== "EIO") {
        throw new Error(`The Replica's copy of ${pair.replica.path} could not be read (${readFailure(error)})`, { cause: error });
      }
    }
    // Looked at after reading, so an edit made meanwhile is not taken for damage.
    const differ = primarySum.status === "fulfilled" && replicaSum.status === "fulfilled" && primarySum.value !== replicaSum.value;
    const changedMeanwhile = differ && (!(await unchanged(primary, pair.primary)) || !(await unchanged(replica, pair.replica)));
    return { primarySum, replicaSum, differ, changedMeanwhile };
  });
  // Taken in the files' order, so the Report is the same however the reads finished.
  for (const [i, pair] of files.entries()) {
    const { primarySum, replicaSum, differ, changedMeanwhile } = outcomes[i]!;
    if (primarySum.status === "rejected") {
      // Damage a Quick compare cannot see: skipped like anything else unreadable (ADR 0015).
      verified.unreadable.push({ file: pair.primary, reason: readFailure(primarySum.reason as NodeJS.ErrnoException) });
    } else if (replicaSum.status === "rejected") {
      // The Replica's copy itself is damaged: what Deep verify is for. Left to the owner's choice, like any
      // other copy whose contents do not match.
      const replicaReadFailure = readFailure(replicaSum.reason as NodeJS.ErrnoException);
      verified.contentMismatch.push({ path: pair.primary.path, size: pair.primary.size, replicaReadFailure });
    } else if (changedMeanwhile) {
      verified.changedWhileRead.push(pair.primary);
    } else if (differ) {
      verified.contentMismatch.push({ path: pair.primary.path, size: pair.primary.size });
    }
  }
  return verified;
}

/** What `readPairs` needs: the drives, how to read them, and the phase whose progress it reports. */
interface PairReading {
  phase: Exclude<CompareProgress["phase"], "scanning">;
  primary: string;
  replica: string;
  hasher: Hasher;
  limits: ReadLimits;
  tellProgress: (progress: CompareProgress) => void;
}

/** Both checksums of a pair of files, each as read or why it could not be. */
type PairSums = [PromiseSettledResult<string>, PromiseSettledResult<string>];

/**
 * Reads each of `pairs` (a Primary file and a Replica file) in full on both drives with `hasher`, as
 * many pairs at once as `limits` allows and no more files from either drive than it reads at once.
 * `check` is given each pair and a `read` that checksums both its files, and resolves with what was
 * found; the results come in the order of `pairs`, however the reads finished. Reports bytes read
 * out of each Primary file's size on both drives, as `phase`, from 0 to the total and never back.
 * Once `check` rejects, no more pairs are started: it waits for those being read, then rejects as
 * the first rejecting pair in order did, as reading them one at a time would have.
 */
async function readPairs<P extends { primary: ScannedFile; replica: ScannedFile }, R>(
  pairs: readonly P[],
  { phase, primary, replica, hasher, limits, tellProgress }: PairReading,
  check: (read: () => Promise<PairSums>, pair: P) => Promise<R>,
): Promise<R[]> {
  const totalBytes = pairs.reduce((total, pair) => total + 2 * pair.primary.size, 0);
  /** Bytes read of each pair, counting no more than its size on both drives, and all of it once done. */
  let checkedBytes = 0;
  tellProgress({ phase, checkedBytes, totalBytes });
  const results: R[] = [];
  const failures = new Map<number, unknown>();
  let next = 0;
  const checkOne = async (pair: P): Promise<R> => {
    const bytes = 2 * pair.primary.size;
    let read = 0;
    const onRead = (chunk: number) => {
      // A file that grew since it was scanned must not take the bar past this pair.
      const counted = Math.min(read + chunk, bytes) - Math.min(read, bytes);
      read += chunk;
      checkedBytes += counted;
      tellProgress({ phase, checkedBytes, totalBytes });
    };
    try {
      return await check(
        () =>
          Promise.allSettled([
            limits.primary(() => hasher.checksum(join(primary, pair.primary.path), onRead)),
            limits.replica(() => hasher.checksum(join(replica, pair.replica.path), onRead)),
          ]) as Promise<PairSums>,
        pair,
      );
    } finally {
      // Not read in full (unreadable, or changed since the scan): the bar still moves past it.
      if (read < bytes) {
        checkedBytes += bytes - read;
        tellProgress({ phase, checkedBytes, totalBytes });
      }
    }
  };
  const worker = async () => {
    while (next < pairs.length && failures.size === 0) {
      const i = next++;
      try {
        results[i] = await checkOne(pairs[i]!);
      } catch (error) {
        failures.set(i, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limits.pairsAtOnce, pairs.length) }, worker));
  if (failures.size > 0) throw failures.get(Math.min(...failures.keys()));
  return results;
}

/**
 * Whether the Replica's copy of the Primary file `file` is newer than it, by a date that does not
 * count as the same (`sameDate`). An Anomaly: an Update never makes a Replica copy newer.
 */
function replicaNewer(file: ScannedFile, replicaFiles: Map<string, ScannedFile>): boolean {
  const copy = replicaFiles.get(matchKey(file.path));
  return copy !== undefined && copy.mtimeNs > file.mtimeNs && !sameDate(copy.mtimeNs, file.mtimeNs);
}

/**
 * Whether `file` under `root` still has the size and date it was scanned with. One that cannot be
 * looked at now has changed.
 */
async function unchanged(root: string, file: ScannedFile): Promise<boolean> {
  const now = await lstat(join(root, file.path), { bigint: true }).catch(() => undefined);
  return now !== undefined && now.isFile() && Number(now.size) === file.size && sameDate(now.mtimeNs, file.mtimeNs);
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
