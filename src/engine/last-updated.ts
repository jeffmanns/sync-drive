import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { matchKey } from "./scan.ts";

/**
 * The hidden file at the top level of the Replica that records when it was last updated. It never
 * appears in a comparison.
 */
export const LAST_UPDATED_MARKER = ".sync-drive-last-updated";

/**
 * The format version of the last-updated marker this sync-drive writes. Fields may be added without
 * raising it, as readers ignore unknown ones; renaming, removing or reshaping a field raises it, and
 * this sync-drive must then still read every earlier version (ADR 0019).
 */
const MARKER_VERSION = 1;

/**
 * When the Replica was last updated, as its last-updated marker records it. An Update limited to one
 * folder does not bring the rest of the Replica up to date, so it is recorded apart from the whole
 * drive (ADR 0019).
 */
export interface LastUpdated {
  /** When the last Update of the whole drive finished, if there has been one. */
  wholeDrive?: Updated;
  /**
   * Each folder an Update was limited to since then, with when the last such Update of it finished,
   * in folder order. An Update of the whole drive empties it.
   */
  folders: FolderUpdated[];
}

/** When an Update finished, and whether it left anything undone that the owner wanted done. */
export interface Updated {
  /** An ISO 8601 date. */
  updated: string;
  /**
   * How many items the Update left undone, when it was partial: files not copied, renamed or moved
   * into the Holding area, content mismatches with no choice made, and items on the Primary that
   * could not be read. What the owner chose to leave (declined Moves or deletions, mismatches kept)
   * does not count. Absent when there were none.
   */
  leftUndone?: number;
}

/** When an Update limited to `folder` (relative to the top of the drive, using `/`) last finished. */
export interface FolderUpdated extends Updated {
  folder: string;
}

/**
 * What the last-updated marker on `replica` records, or `undefined` when there is none, as on a
 * Replica sync-drive has never updated. Reads only. Rejects if the marker is damaged, or was written by
 * a newer sync-drive in a format this one does not know.
 */
export async function readLastUpdated(replica: string): Promise<LastUpdated | undefined> {
  let text: string;
  try {
    text = await readFile(join(replica, LAST_UPDATED_MARKER), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  const version = isObject(data) ? data.version : undefined;
  if (typeof version === "number" && Number.isInteger(version) && version > MARKER_VERSION) {
    throw new Error(
      "The record of when the Replica was last updated was written by a newer version of sync-drive. " +
        "Update sync-drive to see it; an Update with this version replaces it.",
    );
  }
  if (version !== MARKER_VERSION || !isLastUpdated(data)) {
    throw new Error("The record of when the Replica was last updated is damaged. The next Update replaces it.");
  }
  return {
    ...(data.wholeDrive === undefined ? {} : { wholeDrive: updatedOf(data.wholeDrive) }),
    folders: data.folders.map((entry) => ({ folder: entry.folder, ...updatedOf(entry) })),
  };
}

/**
 * Records on `replica` that an Update finished at `now`, leaving `leftUndone` items undone: of the
 * whole drive, or limited to the folder `only`. Written under a temporary name in `incoming` (on the
 * Replica) and renamed into place, so a half-written marker is never left behind. A damaged marker, or
 * one from a newer sync-drive, is replaced; it then knows only this Update.
 */
export async function recordUpdate(replica: string, incoming: string, now: Date, leftUndone: number, only?: string): Promise<void> {
  const previous = await readLastUpdated(replica).catch(() => undefined);
  const updated: Updated = { updated: now.toISOString(), ...(leftUndone === 0 ? {} : { leftUndone }) };
  let record: LastUpdated;
  if (only === undefined) {
    record = { wholeDrive: updated, folders: [] };
  } else {
    const others = (previous?.folders ?? []).filter((entry) => matchKey(entry.folder) !== matchKey(only));
    record = {
      ...(previous?.wholeDrive === undefined ? {} : { wholeDrive: previous.wholeDrive }),
      folders: [...others, { folder: only, ...updated }].sort((a, b) => (matchKey(a.folder) < matchKey(b.folder) ? -1 : 1)),
    };
  }
  const temporary = join(incoming, randomUUID());
  await writeFile(temporary, JSON.stringify({ version: MARKER_VERSION, ...record }, null, 2) + "\n");
  await rename(temporary, join(replica, LAST_UPDATED_MARKER));
}

/** `entry`'s own `updated` and `leftUndone`, without anything else it holds. */
function updatedOf({ updated, leftUndone }: Updated): Updated {
  return { updated, ...(leftUndone === undefined ? {} : { leftUndone }) };
}

function isLastUpdated(value: unknown): value is LastUpdated {
  if (!isObject(value)) return false;
  const { wholeDrive, folders } = value;
  return (
    (wholeDrive === undefined || isUpdated(wholeDrive)) &&
    Array.isArray(folders) &&
    folders.every((entry: unknown) => isUpdated(entry) && isObject(entry) && typeof entry.folder === "string" && entry.folder !== "")
  );
}

function isUpdated(value: unknown): value is Updated {
  if (!isObject(value)) return false;
  const { updated, leftUndone } = value;
  return (
    typeof updated === "string" &&
    !Number.isNaN(Date.parse(updated)) &&
    (leftUndone === undefined || (typeof leftUndone === "number" && Number.isInteger(leftUndone) && leftUndone > 0))
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
