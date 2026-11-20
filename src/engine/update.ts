import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { FileEntry, Report } from "./report.ts";
import { HOLDING_AREA, HOLDING_AREA_README, holdingAreaReadme } from "./holding-area.ts";
import { INCOMING_FOLDER } from "./incoming.ts";
import { isSyncDriveFolder } from "./sync-drive-folders.ts";

/** What the user has approved for an Update. Nothing is written without `update`. */
export interface Approvals {
  /**
   * The main approval: copy the report's new and changed files to the Replica, and empty the
   * previous Holding area.
   */
  update: boolean;
  /**
   * The separate confirmation for deletions: move the report's deleted files into the Holding area.
   * Has no effect without the main approval.
   */
  deletions: boolean;
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
 * Brings the Replica up to date with `report`: empties the previous Holding area, copies the new and
 * changed files from the Primary and, if `approvals.deletions` is also given, moves the deleted
 * files into the Holding area. Writes nothing unless `approvals.update` is given. Never writes to
 * the Primary.
 */
export async function update(report: Report, approvals: Approvals, setup: UpdateSetup): Promise<UpdateResult> {
  const result: UpdateResult = { copied: [], failed: [], moved: [], notMoved: [] };
  if (!approvals.update) return result;
  await assertSeparate(setup.primary, setup.replica);
  const files = [...report.new.files, ...report.changed.files];
  const deletions = approvals.deletions ? report.deleted.files : [];
  for (const file of [...files, ...deletions]) assertInsideDrive(file.path);
  const holdingArea = join(setup.replica, HOLDING_AREA);
  // The Update is approved, so the files kept from the previous Update are now deleted for good.
  await rm(holdingArea, { recursive: true, force: true });
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
  if (deletions.length > 0) {
    await mkdir(holdingArea);
    await writeFile(join(holdingArea, HOLDING_AREA_README), holdingAreaReadme(setup.now ?? new Date()));
  }
  for (const file of deletions) {
    try {
      // Moved, never destroyed: the rename stays on the Replica, so it is atomic and keeps all metadata.
      const destination = join(holdingArea, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await rename(join(setup.replica, file.path), destination);
      result.moved.push(file);
    } catch (error) {
      result.notMoved.push({ ...file, reason: (error as Error).message });
    }
  }
  return result;
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
