import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { FileEntry, Report } from "./report.ts";
import { HOLDING_AREA, HOLDING_AREA_README, holdingAreaReadme } from "./holding-area.ts";
import { INCOMING_FOLDER } from "./incoming.ts";
import { checkFreeSpace } from "./safety-stops.ts";
import { isSyncDriveFolder } from "./sync-drive-folders.ts";

/** What the user has approved for an Update. Nothing is written without `update`. */
export interface Approvals {
  /** The main approval: copy the report's new and changed files to the Replica. */
  update: boolean;
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
  /** When the Update runs, for the Holding area's `READ ME.txt`. Defaults to now. */
  now?: Date;
}

/** A file the Update did not copy or move, and why. */
export interface FailedFile extends FileEntry {
  reason: string;
}

/**
 * What an Update did. Every new and changed file in the report ends up in exactly one of `copied`
 * and `failed`; with deletions confirmed, every deleted file ends up in exactly one of `moved` and
 * `notMoved`.
 */
export interface UpdateResult {
  copied: FileEntry[];
  failed: FailedFile[];
  /** Deleted files moved into the Holding area. */
  moved: FileEntry[];
  /** Deleted files left where they were on the Replica. */
  notMoved: FailedFile[];
}

/** Copying shortcuts as shortcuts, and special files, comes later (#10). Until then they are never followed. */
const NOT_A_FILE = "it is a shortcut (symbolic link) or special file, which Update does not copy yet";

/**
 * Brings the Replica up to date with `report`. If `approvals.deletions` is
 * also given and the report has deleted files, empties the previous Holding area and moves them into
 * it. Then copies the new and changed files from the Primary. Writes nothing unless `approvals.update` is given. Never writes to
 * the Primary. Rejects, having written nothing, when the Safety stop applies without
 * `approvals.overrideSafetyStop`, or when the Replica lacks the free space for the copies (ADR 0008).
 */
export async function update(report: Report, approvals: Approvals, setup: UpdateSetup): Promise<UpdateResult> {
  const result: UpdateResult = { copied: [], failed: [], moved: [], notMoved: [] };
  if (!approvals.update) return result;
  await assertSeparate(setup.primary, setup.replica);
  const files = [...report.new.files, ...report.changed.files];
  const deletions = approvals.deletions ? report.deleted.files : [];
  for (const file of [...files, ...deletions]) assertInsideDrive(file.path);
  if (report.safetyStop && !approvals.overrideSafetyStop) {
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
      await mkdir(dirname(destination), { recursive: true });
      // rename replaces whatever is at the destination, so make sure nothing is.
      if (await exists(destination)) throw new Error("the Holding area already holds a file at that path");
      await rename(join(setup.replica, file.path), destination);
      result.moved.push(file);
    } catch (error) {
      result.notMoved.push({ ...file, reason: (error as Error).message });
    }
  }
  for (const file of result.moved) await removeEmptiedFolders(file.path, setup);
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
      await setup.copier.copy(source, temporary);
      const [after, copy] = await Promise.all([lstat(source, { bigint: true }), lstat(temporary, { bigint: true })]);
      if (!sameVersion(before, after)) throw new Error("it changed on the Primary while it was being copied");
      if (!sameVersion(before, copy)) throw new Error("the copy's size or dates do not match the Primary");
      await mkdir(dirname(destination), { recursive: true });
      await rename(temporary, destination);
      result.copied.push(file);
    } catch (error) {
      await rm(temporary, { force: true });
      result.failed.push({ ...file, reason: (error as Error).message });
    }
  }
  await rm(incoming, { recursive: true, force: true });
  return result;
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
