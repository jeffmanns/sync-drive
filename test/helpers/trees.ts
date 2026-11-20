import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
  for (const mountPoint of mountedImages.splice(0)) {
    await promisify(execFile)("hdiutil", ["detach", "-quiet", "-force", mountPoint]);
  }
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

/**
 * Captures everything about a tree that a write could change: every entry's path, type,
 * size, modification date (to the nanosecond) and a checksum of each file's contents.
 */
export async function snapshotTree(root: string): Promise<string[]> {
  const lines: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const stats = await lstat(full, { bigint: true });
      const path = relative(root, full);
      if (entry.isDirectory()) {
        lines.push(`dir  ${path} mtime=${stats.mtimeNs}`);
        await walk(full);
      } else {
        const hash = entry.isFile()
          ? createHash("sha256").update(await readFile(full)).digest("hex")
          : "-";
        lines.push(`file ${path} size=${stats.size} mtime=${stats.mtimeNs} sha256=${hash}`);
      }
    }
  }
  await walk(root);
  return lines.sort();
}
