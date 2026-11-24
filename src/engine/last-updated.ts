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
 * When the Replica was last updated, as its last-updated marker records it. An Update limited to one
 * folder does not bring the rest of the Replica up to date, so it is recorded apart from the whole
 * drive (ADR 0019).
 */
export interface LastUpdated {
  /** When the last Update of the whole drive finished (an ISO 8601 date), if there has been one. */
  wholeDrive?: string;
  /**
   * Each folder an Update was limited to since then, with when the last such Update of it finished,
   * in folder order. An Update of the whole drive empties it.
   */
  folders: FolderUpdated[];
}

/** When an Update limited to `folder` (relative to the top of the drive, using `/`) last finished. */
export interface FolderUpdated {
  folder: string;
  /** An ISO 8601 date. */
  updated: string;
}

/**
 * What the last-updated marker on `replica` records, or `undefined` when there is none, as on a
 * Replica sync-drive has never updated. Reads only. Rejects if the marker is damaged.
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
  if (!isLastUpdated(data)) {
    throw new Error("The record of when the Replica was last updated is damaged. The next Update replaces it.");
  }
  return {
    ...(data.wholeDrive === undefined ? {} : { wholeDrive: data.wholeDrive }),
    folders: data.folders.map(({ folder, updated }) => ({ folder, updated })),
  };
}

/**
 * Records on `replica` that an Update finished at `now`: of the whole drive, or limited to the folder
 * `only`. Written under a temporary name in `incoming` (on the Replica) and renamed into place, so a
 * half-written marker is never left behind. A damaged marker is replaced; it then knows only this Update.
 */
export async function recordUpdate(replica: string, incoming: string, now: Date, only?: string): Promise<void> {
  const previous = await readLastUpdated(replica).catch(() => undefined);
  const updated = now.toISOString();
  let record: LastUpdated;
  if (only === undefined) {
    record = { wholeDrive: updated, folders: [] };
  } else {
    const others = (previous?.folders ?? []).filter((entry) => matchKey(entry.folder) !== matchKey(only));
    record = {
      ...(previous?.wholeDrive === undefined ? {} : { wholeDrive: previous.wholeDrive }),
      folders: [...others, { folder: only, updated }].sort((a, b) => (matchKey(a.folder) < matchKey(b.folder) ? -1 : 1)),
    };
  }
  const temporary = join(incoming, randomUUID());
  await writeFile(temporary, JSON.stringify(record, null, 2) + "\n");
  await rename(temporary, join(replica, LAST_UPDATED_MARKER));
}

function isLastUpdated(value: unknown): value is LastUpdated {
  if (typeof value !== "object" || value === null) return false;
  const { wholeDrive, folders } = value as Record<string, unknown>;
  return (
    (wholeDrive === undefined || isDate(wholeDrive)) &&
    Array.isArray(folders) &&
    folders.every((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return false;
      const { folder, updated } = entry as Record<string, unknown>;
      return typeof folder === "string" && folder !== "" && isDate(updated);
    })
  );
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
