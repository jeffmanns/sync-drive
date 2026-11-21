import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * The visible folder at the top level of the Replica where an Update moves files that are no
 * longer on the Primary, keeping their folder paths. They stay there until the next Update whose
 * deletions are confirmed, which empties it first (ADR 0006). It never appears in a comparison.
 */
export const HOLDING_AREA = "sync-drive Holding Area";

/** The note inside the Holding area that tells whoever opens it what it is. */
export const HOLDING_AREA_README = "READ ME.txt";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** The text of `READ ME.txt` for the Holding area filled by the Update on `date`. */
export function holdingAreaReadme(date: Date): string {
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  return [
    "sync-drive Holding Area",
    "",
    `These files were moved here by the sync-drive Update on ${day}, because they`,
    "were no longer on the Primary drive. They keep their original folder paths.",
    "",
    "They will be permanently deleted at the next Update whose deletions you confirm.",
    "",
    "To restore a file, copy it back to the Primary drive, into its original folder.",
    "Do not move it back on this drive: the next Update would treat it as deleted again.",
    "",
  ].join("\n");
}

/** The files an earlier Update left in the Holding area, not counting its `READ ME.txt`. */
export interface HoldingAreaContents {
  count: number;
  totalSize: number;
}

/**
 * What the Holding area at the top level of `replica` holds. Reads only; shortcuts are not
 * followed. An absent Holding area holds nothing.
 */
export async function readHoldingArea(replica: string): Promise<HoldingAreaContents> {
  const root = join(replica, HOLDING_AREA);
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const contents: HoldingAreaContents = { count: 0, totalSize: 0 };
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const full = join(entry.parentPath, entry.name);
    if (full === join(root, HOLDING_AREA_README)) continue;
    contents.count += 1;
    contents.totalSize += (await lstat(full)).size;
  }
  return contents;
}
