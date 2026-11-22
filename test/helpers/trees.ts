import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { type BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

/** Default modification date for files in test trees, so trees are deterministic. */
export const DEFAULT_MTIME = new Date("2026-01-01T12:00:00Z");

export type FileSpec = string | { content: string; mtime?: Date };

/** Relative path (with `/`) → file contents, optionally with a modification date. */
export type TreeSpec = Record<string, FileSpec>;

const run = promisify(execFile);

const created: string[] = [];
/** Device nodes (e.g. `/dev/disk5`) of the disk images mounted by `makeDiskImageTree`. */
const mountedImages: string[] = [];

/** Builds a real directory tree in a fresh temporary directory and returns its path. */
export async function makeTree(spec: TreeSpec = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sync-drive-test-"));
  created.push(root);
  await writeTree(root, spec);
  return root;
}

/**
 * Builds a tree on a freshly mounted case-sensitive APFS disk image (via `hdiutil`), for names
 * that a normal case-insensitive folder cannot hold side by side. Returns the volume's path.
 */
export async function makeCaseSensitiveTree(spec: TreeSpec): Promise<string> {
  return makeDiskImageTree(spec, { fileSystem: "Case-sensitive APFS" });
}

/**
 * Builds a tree on a freshly mounted disk image (via `hdiutil`): a real drive with its own
 * volume ID and name. Returns the volume's path.
 */
export async function makeDiskImageTree(
  spec: TreeSpec = {},
  { fileSystem = "APFS", name = "sync-drive-test" }: { fileSystem?: string; name?: string } = {},
): Promise<string> {
  const dir = await makeTree();
  const image = join(dir, "drive.dmg");
  const mountPoint = join(dir, "volume");
  await withRetries(() => run("hdiutil", ["create", "-quiet", "-size", "8m", "-fs", fileSystem, "-volname", name, image]));
  await mkdir(mountPoint);
  const { stdout } = await withRetries(() =>
    run("hdiutil", ["attach", "-nobrowse", "-mountpoint", mountPoint, image]),
  );
  mountedImages.push(deviceOf(stdout));
  await writeTree(mountPoint, spec);
  return mountPoint;
}

async function writeTree(root: string, spec: TreeSpec): Promise<void> {
  for (const [path, file] of Object.entries(spec)) {
    const { content, mtime = DEFAULT_MTIME } = typeof file === "string" ? { content: file } : file;
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    await utimes(full, mtime, mtime);
  }
}

/** Removes every tree made by `makeTree` and `makeCaseSensitiveTree`. Call from an `after` hook. */
export async function removeTrees(): Promise<void> {
  const failures: unknown[] = [];
  for (const device of mountedImages.splice(0)) {
    await detach(device).catch((error: unknown) => failures.push(error));
  }
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (failures.length > 0) throw new AggregateError(failures, "Could not detach every test disk image");
}

/** The whole-disk device node (e.g. `/dev/disk5`) in the output of `hdiutil attach`. */
function deviceOf(attachOutput: string): string {
  const device = attachOutput.match(/^\/dev\/disk\d+/m)?.[0];
  if (device === undefined) throw new Error(`hdiutil attach did not name a device:\n${attachOutput}`);
  return device;
}

/**
 * Detaches the disk image at `device`. macOS (Spotlight, fseventsd) can hold a freshly used volume
 * for a while, and on a slow CI runner even a forced detach then fails as busy. So it is retried,
 * and the last resort is to force the volume to unmount through `diskutil` before detaching again.
 */
async function detach(device: string): Promise<void> {
  try {
    await withRetries(() => run("hdiutil", ["detach", "-force", device]));
  } catch {
    await run("diskutil", ["unmountDisk", "force", device]).catch(() => undefined);
    await run("hdiutil", ["detach", "-force", device]);
  }
}

/** Runs `action`, retrying with a growing pause (about 30 s in all) while it fails. */
async function withRetries<T>(action: () => Promise<T>): Promise<T> {
  const attempts = 8;
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

/**
 * Captures everything about a tree that a write could change: every entry's path, type,
 * size, modification and creation dates (to the nanosecond), permissions, file flags,
 * extended attributes (including Finder tags) and a checksum of each file's contents.
 */
export async function snapshotTree(root: string): Promise<string[]> {
  const lines: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const stats = await lstat(full, { bigint: true });
      const path = relative(root, full);
      if (entry.isDirectory()) {
        lines.push(`dir  ${path} ${await metadataOf(full, stats)}`);
        await walk(full);
      } else {
        const hash = entry.isFile()
          ? createHash("sha256").update(await readFile(full)).digest("hex")
          : "-";
        lines.push(`file ${path} size=${stats.size} ${await metadataOf(full, stats)} sha256=${hash}`);
      }
    }
  }
  await walk(root);
  return lines.sort();
}

/** Everything but the contents that a copy must keep: dates, permissions, flags and extended attributes. */
export async function metadataOf(path: string, stats?: BigIntStats): Promise<string> {
  const s = stats ?? (await lstat(path, { bigint: true }));
  const [flags, xattrs] = await Promise.all([fileFlags(path), extendedAttributes(path)]);
  const attributes = Object.entries(xattrs).map(([name, hex]) => `${name}=${hex}`).join(",");
  return `mtime=${s.mtimeNs} birthtime=${s.birthtimeNs} mode=${s.mode.toString(8)} flags=${flags} xattrs=[${attributes}]`;
}

/** The file's BSD flags (e.g. hidden, locked) in hex, via `stat`. Shortcuts are not followed. */
async function fileFlags(path: string): Promise<string> {
  const { stdout } = await run("stat", ["-f", "%Xf", path]);
  return stdout.trim();
}

/** Every extended attribute of `path` (not following shortcuts), name → value in hex, via `xattr`. */
export async function extendedAttributes(path: string): Promise<Record<string, string>> {
  const { stdout } = await run("xattr", ["-s", path]);
  const names = stdout.split("\n").filter((name) => name !== "").sort();
  const result: Record<string, string> = {};
  for (const name of names) {
    const { stdout: hex } = await run("xattr", ["-s", "-px", name, path]);
    result[name] = hex.replace(/\s+/g, "");
  }
  return result;
}
