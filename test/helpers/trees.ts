import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

/** Default modification date for files in test trees, so trees are deterministic. */
export const DEFAULT_MTIME = new Date("2026-01-01T12:00:00Z");

export type FileSpec = string | { content: string; mtime?: Date };

/** Relative path (with `/`) → file contents, optionally with a modification date. */
export type TreeSpec = Record<string, FileSpec>;

const created: string[] = [];

/** Builds a real directory tree in a fresh temporary directory and returns its path. */
export async function makeTree(spec: TreeSpec = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sync-drive-test-"));
  created.push(root);
  for (const [path, file] of Object.entries(spec)) {
    const { content, mtime = DEFAULT_MTIME } = typeof file === "string" ? { content: file } : file;
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    await utimes(full, mtime, mtime);
  }
  return root;
}

/** Removes every tree made by `makeTree`. Call from an `after` hook. */
export async function removeTrees(): Promise<void> {
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
