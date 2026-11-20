import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { FileEntry, Report } from "./report.ts";
import { INCOMING_FOLDER } from "./incoming.ts";

/** What the user has approved for an Update. Nothing is written without `update`. */
export interface Approvals {
  /** The main approval: copy the report's new and changed files to the Replica. */
  update: boolean;
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
export interface UpdateTarget {
  /** The top level of the Primary. Read only. */
  primary: string;
  /** The top level of the Replica. */
  replica: string;
  copier: FileCopier;
}

/** A file the Update did not copy, and why. */
export interface FailedFile extends FileEntry {
  reason: string;
}

/** What an Update did. Every new and changed file in the report ends up in exactly one list. */
export interface UpdateResult {
  copied: FileEntry[];
  failed: FailedFile[];
}

/** Copying shortcuts as shortcuts, and special files, comes later (#10). Until then they are never followed. */
const NOT_A_FILE = "it is a shortcut (symbolic link) or special file, which Update does not copy yet";

/**
 * Brings the Replica up to date with `report`: copies its new and changed files from the Primary.
 * Writes nothing unless `approvals.update` is given. Never writes to the Primary.
 */
export async function update(report: Report, approvals: Approvals, target: UpdateTarget): Promise<UpdateResult> {
  const result: UpdateResult = { copied: [], failed: [] };
  if (!approvals.update) return result;
  await assertSeparate(target.primary, target.replica);
  const files = [...report.new.files, ...report.changed.files];
  for (const file of files) assertInsideDrive(file.path);
  const incoming = join(target.replica, INCOMING_FOLDER);
  // Anything already here is a temporary copy left by an interrupted Update.
  await rm(incoming, { recursive: true, force: true });
  await mkdir(incoming);
  for (const file of files) {
    // Copied under a temporary name first, so an interrupted copy never sits under a real name.
    const temporary = join(incoming, randomUUID());
    const destination = join(target.replica, file.path);
    const source = join(target.primary, file.path);
    try {
      const before = await lstat(source, { bigint: true });
      if (!before.isFile()) throw new Error(NOT_A_FILE);
      await target.copier.copy(source, temporary);
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

/** Rejects a report path that is not plainly a path inside the drive, such as one with `..` in it. */
function assertInsideDrive(path: string): void {
  const parts = path.split("/");
  if (isAbsolute(path) || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`"${path}" is not a path inside the drive; nothing was written`);
  }
}
