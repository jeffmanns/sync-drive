import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isBuiltInExclusion } from "./exclusions.ts";

/** What a Quick compare knows about one file. */
export interface ScannedFile {
  size: number;
  /** Modification date in nanoseconds since the epoch, at the file system's full precision. */
  mtimeNs: bigint;
}

/** Lists every file under `root`, skipping built-in exclusions, keyed by path relative to `root` (with `/`). Reads only. */
export async function scan(root: string): Promise<Map<string, ScannedFile>> {
  const files = new Map<string, ScannedFile>();
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const path = prefix + entry.name;
        if (isBuiltInExclusion(path)) return;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, path + "/");
        } else {
          const stats = await lstat(full, { bigint: true });
          files.set(path, { size: Number(stats.size), mtimeNs: stats.mtimeNs });
        }
      }),
    );
  }
  await walk(root, "");
  return files;
}
