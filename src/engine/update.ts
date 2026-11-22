import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { FileEntry, Move, Report } from "./report.ts";
import { Sha256Hasher, type Hasher } from "./hashing.ts";
import { HOLDING_AREA, HOLDING_AREA_README, holdingAreaReadme } from "./holding-area.ts";
import { INCOMING_FOLDER } from "./incoming.ts";
import { sameDate } from "./same-date.ts";
import { checkFreeSpace, safetyStopApplies } from "./safety-stops.ts";
import { isSyncDriveFolder } from "./sync-drive-folders.ts";

/** What the user has approved for an Update. Nothing is written without `update`. */
export interface Approvals {
  /** The main approval: copy the report's new and changed files to the Replica. */
  update: boolean;
  /**
   * The separate Approval for moves: rename the report's moved files on the Replica to their new
   * paths. Has no effect without the main approval. Without it, moved files stay at their old
   * paths and nothing is copied to the new ones.
   */
  moves: boolean;
  /**
   * The separate confirmation for deletions: empty the previous Holding area, then move the
   * report's deleted files into it. Has no effect without the main approval.
   */
  deletions: boolean;
  /**
   * The explicit override of the Safety stop, for this Update only. Without it, an Update whose
   * report has the Safety stop applying writes nothing (ADR 0008).
   */
  overrideSafetyStop?: boolean;
}

/**
 * Copies one file with all its macOS metadata. The engine never copies files itself, so tests can
 * substitute a copier that fails part-way.
 */
export interface FileCopier {
  /**
   * Copies the regular file `source` to `destination`, which must not exist yet, keeping its
   * modification and creation dates, extended attributes (including Finder tags), permissions and
   * flags. Resolves only once the copy is safely on the drive. Never writes to `source`.
   */
  copy(source: string, destination: string): Promise<void>;
}

/** Where an Update reads from and writes to, and how it copies. */
export interface UpdateSetup {
  /** The top level of the Primary. Read only. */
  primary: string;
  /** The top level of the Replica. */
  replica: string;
  copier: FileCopier;
  /** Checks every copy against its Primary file before it is renamed into place. Defaults to SHA-256. */
  hasher?: Hasher;
  /** When the Update runs, for the Holding area's `READ ME.txt`. Defaults to now. */
  now?: Date;
}

/** A file the Update did not copy or move, and why. */
export interface FailedFile extends FileEntry {
  reason: string;
}

/** A moved file the Update did not rename, and why. It is still at its old path on the Replica. */
export interface FailedMove extends Move {
  reason: string;
}

/**
 * What an Update did. Every new and changed file in the report ends up in exactly one of `copied`
 * and `failed`; with deletions confirmed, every deleted file ends up in exactly one of `moved` and
 * `notMoved`; with moves approved, every move ends up in exactly one of `renamed` and `notRenamed`.
 */
export interface UpdateResult {
  copied: FileEntry[];
  failed: FailedFile[];
  /** Moved files renamed to their new paths on the Replica. */
  renamed: Move[];
  /** Moved files left at their old paths on the Replica. */
  notRenamed: FailedMove[];
  /** Deleted files moved into the Holding area. */
  moved: FileEntry[];
  /** Deleted files left where they were on the Replica. */
  notMoved: FailedFile[];
}

/** Copying shortcuts as shortcuts, and special files, comes later (#10). Until then they are never followed. */
const NOT_A_FILE = "it is a shortcut (symbolic link) or special file, which Update does not copy yet";

/**
 * Brings the Replica up to date with `report`. If `approvals.deletions` is also given and the
 * report has deleted files, empties the previous Holding area and moves them into it, each only if
 * the Primary still has no file at its path. If
 * `approvals.moves` is given, renames the report's moved files on the Replica to their new paths,
 * each only if it and its Primary file still match by size and date. Then copies
 * the new and changed files from the Primary, checking each copy against its Primary file by
 * checksum before renaming it into place; a copy that does not match is discarded and listed as
 * failed. Writes nothing unless `approvals.update` is given. Never writes to the Primary. Rejects,
 * having written nothing, when the Safety stop applies to the report's deletions (counted again
 * here, not read from `report.safetyStop`) without `approvals.overrideSafetyStop`, or
 * when the Replica lacks the free space for the copies (ADR 0008). Every rejection is an
 * `UpdateStoppedError` saying what had been done before it stopped.
 */
export async function update(report: Report, approvals: Approvals, setup: UpdateSetup): Promise<UpdateResult> {
  const result = nothingDone();
  if (!approvals.update) return result;
  try {
    await updateInto(result, report, approvals, setup);
  } catch (error) {
    throw new UpdateStoppedError(error, result);
  }
  return result;
}

/** The result of an Update that has done nothing yet. */
export function nothingDone(): UpdateResult {
  return { copied: [], failed: [], renamed: [], notRenamed: [], moved: [], notMoved: [] };
}

/**
 * An Update that stopped partway, or before writing anything. `result` holds exactly what it did
 * first: every file copied or moved before it stopped is listed there, and nothing else.
 */
export class UpdateStoppedError extends Error {
  readonly result: UpdateResult;

  constructor(cause: unknown, result: UpdateResult) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "UpdateStoppedError";
    this.result = result;
  }
}

/** Does the Update for `update()`, recording each file copied, moved or not as it goes into `result`. */
async function updateInto(result: UpdateResult, report: Report, approvals: Approvals, setup: UpdateSetup): Promise<void> {
  await assertSeparate(setup.primary, setup.replica);
  const files = [...report.new.files, ...report.changed.files];
  const deletions = approvals.deletions ? report.deleted.files : [];
  const moves = approvals.moves ? report.moves.moves : [];
  for (const file of [...files, ...deletions]) assertInsideDrive(file.path);
  for (const move of moves) {
    assertInsideDrive(move.from);
    assertInsideDrive(move.to);
  }
  // Counted again from the deletions it was handed, rather than trusting the Report's flag, so the
  // Safety stop holds whoever built the Report (ADR 0008).
  if (safetyStopApplies(report.deleted, report.replica) && !approvals.overrideSafetyStop) {
    throw new Error("The Safety stop applies and was not overridden; nothing was written");
  }
  const space = await checkFreeSpace(report, setup.replica);
  if (!space.enough) {
    throw new Error(
      `The Replica has ${space.free} bytes free but the copies need ${space.needed}; nothing was written`,
    );
  }
  const holdingArea = join(setup.replica, HOLDING_AREA);
  // Deletions first, so a path that changed between a file and a folder is free before copying.
  if (deletions.length > 0) {
    // New deletions are confirmed, so the files kept from the previous Update are now deleted for
    // good. Without that confirmation the Holding area is left untouched (ADR 0006).
    await rm(holdingArea, { recursive: true, force: true });
    await mkdir(holdingArea);
    await writeFile(join(holdingArea, HOLDING_AREA_README), holdingAreaReadme(setup.now ?? new Date()));
  }
  for (const file of deletions) {
    try {
      // Moved, never destroyed: the rename stays on the Replica, so it is atomic and keeps all metadata.
      const destination = join(holdingArea, file.path);
      // It was only on the Replica at compare time. If the Primary has anything but a folder at its
      // path now, a comparison would no longer call it deleted, so the Replica's copy is left for the
      // next one, whether or not the two match (ADR 0014).
      if (await onPrimary(setup.primary, file.path)) throw new Error("it is on the Primary again since the comparison");
      await assertNoShortcutAlong(setup.replica, file.path);
      await makeReplicaFolders(setup.replica, join(HOLDING_AREA, dirname(file.path)));
      // rename replaces whatever is at the destination, so make sure nothing is.
      if (await exists(destination)) throw new Error("the Holding area already holds a file at that path");
      await rename(join(setup.replica, file.path), destination);
      result.moved.push(file);
    } catch (error) {
      result.notMoved.push({ ...file, reason: (error as Error).message });
    }
  }
  for (const file of result.moved) await removeEmptiedFolders(file.path, setup);
  // After the deletions, so a deleted file is out of the way of a move to a folder of its name.
  for (const move of moves) {
    try {
      // A rename stays on the Replica: nothing is copied, and the file keeps all its metadata.
      // Its new path is checked as its folders are made, below.
      await assertNoShortcutAlong(setup.replica, move.from);
      const [onPrimary, onReplica] = await Promise.all([
        lstat(join(setup.primary, move.to), { bigint: true }),
        lstat(join(setup.replica, move.from), { bigint: true }),
      ]);
      // The checksums matched at compare time. If either file has changed since, it may no longer be
      // the same file, so it is left for the next comparison.
      if (!onPrimary.isFile() || !onReplica.isFile() || onPrimary.size !== onReplica.size || !sameDate(onPrimary.mtimeNs, onReplica.mtimeNs)) {
        throw new Error("it changed on the Primary or the Replica since the comparison");
      }
      const destination = join(setup.replica, move.to);
      await makeReplicaFolders(setup.replica, dirname(move.to));
      // rename replaces whatever is at the destination, so make sure nothing is.
      if (await exists(destination)) throw new Error("the Replica already has a file at its new path");
      await rename(join(setup.replica, move.from), destination);
      result.renamed.push(move);
    } catch (error) {
      result.notRenamed.push({ ...move, reason: (error as Error).message });
    }
  }
  for (const move of result.renamed) await removeEmptiedFolders(move.from, setup);
  const hasher = setup.hasher ?? new Sha256Hasher();
  const incoming = join(setup.replica, INCOMING_FOLDER);
  // Anything already here is a temporary copy left by an interrupted Update.
  await rm(incoming, { recursive: true, force: true });
  await mkdir(incoming);
  for (const file of files) {
    // Copied under a temporary name first, so an interrupted copy never sits under a real name.
    const temporary = join(incoming, randomUUID());
    const destination = join(setup.replica, file.path);
    const source = join(setup.primary, file.path);
    try {
      const before = await lstat(source, { bigint: true });
      if (!before.isFile()) throw new Error(NOT_A_FILE);
      // Checked before copying too, so no time is spent on a copy that could not be put in place.
      await assertNoShortcutAlong(setup.replica, file.path);
      await setup.copier.copy(source, temporary);
      // Read both back in full, so "copied" means confirmed identical, not just written.
      const [primarySum, copySum] = await Promise.all([hasher.checksum(source), hasher.checksum(temporary)]);
      // Looked at after hashing, so an edit during the copy or the read-back is caught as such.
      const [after, copy] = await Promise.all([lstat(source, { bigint: true }), lstat(temporary, { bigint: true })]);
      if (!sameVersion(before, after)) throw new Error("it changed on the Primary while it was being copied");
      if (!sameVersion(before, copy)) throw new Error("the copy's size or dates do not match the Primary");
      if (primarySum !== copySum) throw new Error("the copy's checksum does not match the Primary's");
      await makeReplicaFolders(setup.replica, dirname(file.path));
      await rename(temporary, destination);
      result.copied.push(file);
    } catch (error) {
      await rm(temporary, { force: true });
      result.failed.push({ ...file, reason: (error as Error).message });
    }
  }
  await rm(incoming, { recursive: true, force: true });
}

/**
 * Removes the Replica folders that held `path` (relative to the drive root) if moving it left them
 * empty and the Primary has no folder there, deepest first. `rmdir` only ever removes an empty
 * folder, so no file can be lost.
 */
async function removeEmptiedFolders(path: string, setup: UpdateSetup): Promise<void> {
  for (let folder = dirname(path); folder !== "."; folder = dirname(folder)) {
    const onPrimary = await lstat(join(setup.primary, folder)).catch(() => undefined);
    if (onPrimary?.isDirectory()) return;
    try {
      await rmdir(join(setup.replica, folder));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Already gone with an earlier file: carry on upwards. Otherwise it is not empty (it still
      // holds other files, or a .DS_Store) or cannot be removed; either way it stays, which is harmless.
      if (code !== "ENOENT") return;
    }
  }
}

/**
 * Rejects if a folder holding `path` (relative to the top of the Replica, below it) is a shortcut
 * (symbolic link), since a write through it would land wherever it points: elsewhere on the
 * Replica, or even on the Primary. sync-drive never makes shortcuts, but a Replica filled or
 * edited by another tool can have one where the Primary has a real folder. Reads only. Stops at
 * the first folder that does not exist, as nothing below it can be a shortcut. A shortcut made
 * between this check and the write is not caught; the owner is not expected to edit the Replica
 * during an Update.
 */
async function assertNoShortcutAlong(replica: string, path: string): Promise<void> {
  for (const folder of foldersAlong(dirname(path))) {
    const stats = await lstat(join(replica, folder)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stats === undefined) return;
    if (stats.isSymbolicLink()) throw new Error(shortcutReason(folder));
  }
}

/**
 * Makes `folder` (relative to the top of the Replica) and every missing folder above it, one
 * level at a time, so that no folder is ever made through a shortcut. Rejects, having made
 * nothing below it, at the first folder along the way that is a shortcut.
 */
async function makeReplicaFolders(replica: string, folder: string): Promise<void> {
  for (const route of foldersAlong(folder)) {
    const full = join(replica, route);
    try {
      await mkdir(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await lstat(full)).isSymbolicLink()) throw new Error(shortcutReason(route));
    }
  }
}

/** `folder` (relative, using `/`) and each folder above it, top first: `a/b/c` gives `a`, `a/b`, `a/b/c`. `.` gives none. */
function foldersAlong(folder: string): string[] {
  if (folder === ".") return [];
  const names = folder.split("/");
  return names.map((_, i) => names.slice(0, i + 1).join("/"));
}

/** Why nothing was written for a file whose Replica path goes through the shortcut `folder`. */
function shortcutReason(folder: string): string {
  return `the Replica folder "${folder}" is a shortcut (symbolic link), and sync-drive never writes through one`;
}

/** Whether anything, even a broken shortcut, is at `path`. */
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

/**
 * Whether the Primary has a file at `path` (relative to its top) as a comparison sees it: anything
 * but a folder, even a broken shortcut. A folder there is not one, as a Replica file in its place
 * is deleted (a file replaced by a folder of the same name). Nor is anything when a folder along
 * the way is missing or is now a file. Reads only.
 */
async function onPrimary(primary: string, path: string): Promise<boolean> {
  return lstat(join(primary, path)).then(
    (stats) => !stats.isDirectory(),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
      throw error;
    },
  );
}

/** Whether two looks at a file see the same version of it: same size, and the same dates to the nanosecond. */
function sameVersion(a: BigIntStats, b: BigIntStats): boolean {
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.birthtimeNs === b.birthtimeNs;
}

/** Rejects unless the Primary and the Replica are separate folders, neither inside the other, so no write can reach the Primary. */
async function assertSeparate(primary: string, replica: string): Promise<void> {
  const [p, r] = await Promise.all([realpath(primary), realpath(replica)]);
  if (isWithin(p, r) || isWithin(r, p)) {
    throw new Error(`The Primary ${primary} and the Replica ${replica} overlap; nothing was written`);
  }
}

/** Whether `path` is `folder` itself or somewhere inside it. */
function isWithin(folder: string, path: string): boolean {
  const route = relative(folder, path);
  return route === "" || (!isAbsolute(route) && route !== ".." && !route.startsWith("../"));
}

/**
 * Rejects a report path that is not plainly a path inside the drive, such as one with `..` in it,
 * or one inside sync-drive's own folders on the Replica.
 */
function assertInsideDrive(path: string): void {
  const parts = path.split("/");
  if (isAbsolute(path) || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`"${path}" is not a path inside the drive; nothing was written`);
  }
  if (isSyncDriveFolder(parts[0]!)) {
    throw new Error(`"${path}" is inside sync-drive's own ${parts[0]} folder; nothing was written`);
  }
}
