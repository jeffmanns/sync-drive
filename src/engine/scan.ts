import { lstat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { isAlwaysSkipped } from "./always-skipped.ts";
import type { ExclusionMatcher } from "./exclusions.ts";
import { HOLDING_AREA } from "./holding-area.ts";
import type { Unreadable } from "./report.ts";
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
  /** For a shortcut, the path it points to, exactly as stored. Never followed. */
  target?: string;
}

/** What a scan found: every file, and on the Primary, what could not be read. */
export interface Scanned {
  /** Every file, keyed by `matchKey` of its path. */
  files: Map<string, ScannedFile>;
  /** What could not be read below the top level. Always empty on the Replica, which rejects instead. */
  unreadable: Unreadable[];
}

/**
 * Lists every file under the `role` drive's `root`, skipping macOS system files, what `isExcluded`
 * leaves out (an excluded folder is not read at all), and, on the Replica, sync-drive's own folders
 * (the Incoming folder and the Holding area), keyed by `matchKey` of its path relative to `root`. On the Primary, a folder or entry below the top level that cannot be read is
 * listed in `unreadable` and the scan carries on; on the Replica it rejects. Shortcuts are never
 * followed. Reads only. Rejects if two paths differ only by letter case, or if the Primary holds a
 * top-level item with the name of one of sync-drive's own folders. Calls `onListed` with the number
 * of items (files plus folders, skipped or not) in each folder it lists, for progress. With `from`
 * (a folder below `root`, as stored on the drive), lists only what is in it, still keyed by its path
 * from `root`; that folder failing to be read rejects, like the top level.
 */
export async function scan(
  role: "Primary" | "Replica",
  root: string,
  isExcluded: ExclusionMatcher = () => false,
  onListed: (items: number) => void = () => {},
  from = "",
): Promise<Scanned> {
  const files = new Map<string, ScannedFile>();
  const unreadable: Unreadable[] = [];
  /** Runs `read`; on the Primary, a failure lists `path` as unreadable and gives `undefined`. */
  async function orUnreadable<T>(path: string, folder: boolean, read: () => Promise<T>): Promise<T | undefined> {
    try {
      return await read();
    } catch (error) {
      if (role === "Replica" || path === from) throw error;
      unreadable.push({ path, folder, reason: readFailure(error as NodeJS.ErrnoException) });
      return undefined;
    }
  }
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await orUnreadable(prefix.slice(0, -1), true, () => readdir(dir, { withFileTypes: true }));
    if (entries === undefined) return;
    onListed(entries.length);
    await Promise.all(
      entries.map(async (entry) => {
        const path = prefix + entry.name;
        if (isAlwaysSkipped(path)) return;
        // sync-drive's own folders: the Incoming folder and the Holding area. Checked before the
        // Exclusions, so the Primary still cannot hide such an item behind one (ADR 0007).
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
        if (isExcluded(path)) return;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, path + "/");
        } else {
          const kind = entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other";
          const read = await orUnreadable(path, false, async () => ({
            stats: await lstat(full, { bigint: true }),
            target: kind === "symlink" ? await readlink(full) : undefined,
          }));
          if (read === undefined) return;
          const { stats, target } = read;
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
            kind,
            size: Number(stats.size),
            mtimeNs: stats.mtimeNs,
            ...(target === undefined ? {} : { target }),
          });
        }
      }),
    );
  }
  await walk(join(root, from), from === "" ? "" : `${from}/`);
  return { files, unreadable };
}

/**
 * Why something could not be read, in words, from the error reading it. A cause without words of its
 * own is still named, so it can be looked up, but never shown bare.
 */
export function readFailure(error: NodeJS.ErrnoException): string {
  if (error.code === "EACCES" || error.code === "EPERM") return "permission denied";
  if (error.code === "EIO") return "the drive could not read it (EIO)";
  return `unexpected reason: ${error.code ?? error.message}`;
}

/**
 * The key that pairs a file on the Primary with its counterpart on the Replica. Letter case is
 * ignored, so `Photo.JPG` and `photo.jpg` are the same file. Unicode forms are not unified: a
 * name stored in two different forms counts as two different files.
 */
export function matchKey(path: string): string {
  return path.toLowerCase();
}
