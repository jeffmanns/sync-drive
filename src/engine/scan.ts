import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isAlwaysSkipped } from "./always-skipped.ts";
import { HOLDING_AREA } from "./holding-area.ts";
import { isSyncDriveFolder } from "./sync-drive-folders.ts";

/**
 * What a file system entry is. Shortcuts (symbolic links) are never followed: their own
 * size and date are used. `"other"` covers sockets, pipes and devices.
 */
export type EntryKind = "file" | "symlink" | "other";

/** What a Quick compare knows about one file. */
export interface ScannedFile {
  /** Path relative to the drive root, using `/`, exactly as stored on the drive. */
  path: string;
  kind: EntryKind;
  size: number;
  /** Modification date in nanoseconds since the epoch, at the file system's full precision. */
  mtimeNs: bigint;
}

/**
 * Lists every file under the `role` drive's `root`, skipping macOS system files and, on the Replica,
 * sync-drive's own folders (the Incoming folder and the Holding area), keyed by `matchKey` of its path
 * relative to `root`. Reads only. Rejects if two paths differ only by letter case, or if the Primary
 * holds a top-level item with the name of one of sync-drive's own folders.
 */
export async function scan(
  role: "Primary" | "Replica",
  root: string,
): Promise<Map<string, ScannedFile>> {
  const files = new Map<string, ScannedFile>();
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const path = prefix + entry.name;
        if (isAlwaysSkipped(path)) return;
        // sync-drive's own folders: the Incoming folder and the Holding area.
        if (isSyncDriveFolder(path)) {
          if (role === "Replica") return;
          // An Update would copy it into sync-drive's own folder on the Replica, where a later Update would
          // delete it, so a backup that looked made would be lost (ADR 0007).
          const howToFix =
            path.toLowerCase() === HOLDING_AREA.toLowerCase()
              ? `If you restored files by copying the whole Holding area, rename that folder on the Primary (e.g. to "Restored files"), then compare again.`
              : `Rename it on the Primary, then compare again.`;
          throw new Error(
            `The Primary has an item named "${path}" at its top level. sync-drive keeps that name for its own folder ` +
              `on the Replica, so it cannot back the item up. ${howToFix}`,
          );
        }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, path + "/");
        } else {
          const stats = await lstat(full, { bigint: true });
          const key = matchKey(path);
          const clash = files.get(key);
          if (clash !== undefined) {
            // Only possible on a case-sensitive drive. Pairing either one would hide the other.
            throw new Error(
              `The ${role} holds ${clash.path} and ${path}, which differ only by letter case. ` +
                `sync-drive matches files regardless of case, so it cannot compare them safely.`,
            );
          }
          files.set(key, {
            path,
            kind: entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
            size: Number(stats.size),
            mtimeNs: stats.mtimeNs,
          });
        }
      }),
    );
  }
  await walk(root, "");
  return files;
}

/**
 * The key that pairs a file on the Primary with its counterpart on the Replica. Letter case is
 * ignored, so `Photo.JPG` and `photo.jpg` are the same file. Unicode forms are not unified: a
 * name stored in two different forms counts as two different files.
 */
function matchKey(path: string): string {
  return path.toLowerCase();
}
