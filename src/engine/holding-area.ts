import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { formatDay } from "../format.ts";

/**
 * The visible folder at the top level of the Replica where an Update moves files that are no
 * longer on the Primary, keeping their folder paths. They stay there until the next Update whose
 * deletions are confirmed, which empties it first (ADR 0006). It never appears in a comparison.
 */
export const HOLDING_AREA = "sync-drive Holding Area";

/** The note inside the Holding area that tells whoever opens it what it is. */
export const HOLDING_AREA_README = "READ ME.txt";

/** The text of `READ ME.txt` for the Holding area last added to by the Update on `date`. */
export function holdingAreaReadme(date: Date): string {
  const day = formatDay(date);
  return [
    "sync-drive Holding Area",
    "",
    `These files were moved here by sync-drive, most recently by the Update on ${day}.`,
    "Each was either no longer on the Primary drive, or the Replica's copy of a file",
    "whose contents differed, which you chose to overwrite with the Primary's copy.",
    "They keep their original folder paths.",
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
  /**
   * The day the Holding area was last added to, as its `READ ME.txt` gives it ("24 November 2026").
   * Absent when the `READ ME.txt` is missing or gives no date.
   */
  lastAddedOn?: string;
}

/**
 * The day in a `READ ME.txt` written by `holdingAreaReadme`, or by an earlier sync-drive, which said
 * "moved here by the sync-drive Update on <day>" before the Holding area also kept overwritten copies.
 */
const README_DAY = /(?:most recently by the Update on|by the sync-drive Update on) (\d{1,2} [A-Z][a-z]+ \d{4})/;

/**
 * What the Holding area at the top level of `replica` holds, and when it was last added to. Reads
 * only; shortcuts are not followed. An absent Holding area holds nothing.
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
  const readme = await readFile(join(root, HOLDING_AREA_README), "utf8").catch(() => "");
  const day = README_DAY.exec(readme)?.[1];
  return day === undefined ? contents : { ...contents, lastAddedOn: day };
}
