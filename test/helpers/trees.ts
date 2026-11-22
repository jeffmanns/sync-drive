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

const created: string[] = [];
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
  const run = promisify(execFile);
  await run("hdiutil", ["create", "-quiet", "-size", "8m", "-fs", fileSystem, "-volname", name, image]);
  await mkdir(mountPoint);
  await run("hdiutil", ["attach", "-quiet", "-nobrowse", "-mountpoint", mountPoint, image]);
  mountedImages.push(mountPoint);
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
  for (const mountPoint of mountedImages.splice(0)) {
    await detach(mountPoint).catch((error: unknown) => failures.push(error));
  }
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (failures.length > 0) throw new AggregateError(failures, "Could not detach every test disk image");
}

/**
 * Detaches the disk image mounted at `mountPoint`. macOS (Spotlight, fseventsd) can hold a freshly
 * mounted volume for a moment, and then even a forced detach fails as busy (exit code 16), so it is
 * tried again a few times before giving up.
 */
async function detach(mountPoint: string): Promise<void> {
  const attempts = 6;
  for (let attempt = 1; ; attempt++) {
    try {
      await promisify(execFile)("hdiutil", ["detach", "-quiet", "-force", mountPoint]);
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
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
  const { stdout } = await promisify(execFile)("stat", ["-f", "%Xf", path]);
  return stdout.trim();
}

/** Every extended attribute of `path` (not following shortcuts), name → value in hex, via `xattr`. */
export async function extendedAttributes(path: string): Promise<Record<string, string>> {
  const run = promisify(execFile);
  const { stdout } = await run("xattr", ["-s", path]);
  const names = stdout.split("\n").filter((name) => name !== "").sort();
  const result: Record<string, string> = {};
  for (const name of names) {
    const { stdout: hex } = await run("xattr", ["-s", "-px", name, path]);
    result[name] = hex.replace(/\s+/g, "");
  }
  return result;
}
