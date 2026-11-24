import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describeFiles, fileCount, formatDay, formatSize, formatTime, itemCount } from "../format.ts";
import { notRecordedWarning, totalsOfFiles, totalsOfMoves, type FileEntry, type Move, type ResultState, type Totals } from "./view.ts";

/** Where the Update logs are kept on the Mac: a folder beside the Pairing stored in `pairingFile`. */
export function updateLogFolderBeside(pairingFile: string): string {
  return join(dirname(pairingFile), "Update logs");
}

/** A content mismatch the Update left as it was, and why. */
export interface MismatchLeft extends FileEntry {
  why: "kept, as chosen" | "no choice was made";
}

/**
 * Everything an Update log records about one Update: what the Result shows, but for the Holding area
 * and the log itself, and these.
 */
export type UpdateLogEntry = Omit<ResultState, "step" | "holdingArea" | "holdingAreaProblem" | "updateLog" | "updateLogProblem"> & {
  /** When the Update ended, finished or not. */
  ended: Date;
  /** Whether the comparison was a Deep verify. */
  deep: boolean;
  mismatchesLeft: MismatchLeft[];
  /** What the Holding area held before the Update and was deleted for good, as the deletions were approved. */
  deletedFromHoldingArea: Totals;
};

/**
 * Writes the log of one Update, as plain text, into `folder` on the Mac: one new file per Update,
 * named by when it ended, never replacing an earlier one. Resolves with its path.
 */
export async function writeUpdateLog(folder: string, entry: UpdateLogEntry): Promise<string> {
  await mkdir(folder, { recursive: true });
  const { ended } = entry;
  const day = [ended.getFullYear(), ended.getMonth() + 1, ended.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
  const stamp = `${day} ${formatTime(ended, ".")}`;
  for (let attempt = 1; ; attempt += 1) {
    const path = join(folder, `${stamp}${attempt === 1 ? "" : ` (${attempt})`} Update.txt`);
    try {
      // "wx": never over an earlier log.
      await writeFile(path, updateLogText(entry), { flag: "wx" });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** The text of the Update log for `entry`. */
export function updateLogText(entry: UpdateLogEntry): string {
  const { ended, pairing } = entry;
  const overwritten = new Set(entry.overwritten.map((file) => file.path));
  const copied = entry.copied.filter((file) => !overwritten.has(file.path));
  const lines = [
    "sync-drive Update log",
    `Finished: ${formatDay(ended)} at ${formatTime(ended)}`,
    `Primary: "${pairing.primary.name}" (volume ID ${pairing.primary.id})`,
    `Replica: "${pairing.replica.name}" (volume ID ${pairing.replica.id})`,
    ...(entry.only === undefined ? [] : [`Limited to the folder: "${entry.only}"`]),
    `Compared by: ${entry.deep ? "Deep verify" : "Quick compare"}`,
    ...(entry.error === undefined ? [] : [`Stopped before it finished: ${entry.error}`]),
    ...(entry.primaryStillReadOnly === undefined ? [] : [`The Primary may still be read-only: ${entry.primaryStillReadOnly}`]),
    ...(entry.notRecorded === undefined ? [] : [notRecordedWarning(entry.notRecorded)]),
    "",
  ];
  /** A section listing `items`, each on its own line. Left out when empty, unless `always`. */
  const section = (title: string, heading: string, items: string[], always = false) => {
    if (items.length === 0 && !always) return;
    lines.push(`${title}: ${items.length === 0 ? "none" : heading}`, ...items.map((item) => `  ${item}`), "");
  };
  /** A line giving only how many, for what is too plain to list. Left out when there are none. */
  const total = (title: string, totals: Totals) => {
    if (totals.count > 0) lines.push(`${title}: ${describeFiles(totals)}`, "");
  };
  const sized = (file: FileEntry) => `${file.path} (${formatSize(file.size)})`;
  const move = (m: Move) => `${m.from} → ${m.to}`;
  section("Copied", describeFiles(totalsOfFiles(copied)), copied.map(sized), true);
  section("Content mismatches overwritten with the Primary's copy", describeFiles(totalsOfFiles(entry.overwritten)), entry.overwritten.map(sized));
  section("Not copied", fileCount(entry.failed.length), entry.failed.map((file) => `${file.path}: ${file.reason}`));
  section("Content mismatches left as they are", describeFiles(totalsOfFiles(entry.mismatchesLeft)), entry.mismatchesLeft.map((file) => `${sized(file)}: ${file.why}`));
  section("Renamed", describeFiles(totalsOfMoves(entry.renamed)), entry.renamed.map(move), true);
  section("Not renamed", fileCount(entry.notRenamed.length), entry.notRenamed.map((m) => `${move(m)}: ${m.reason}`));
  total("Moved on the Primary, left at their old paths on the Replica", entry.movesLeftAtOldPaths);
  total("Deleted for good from the Holding area, before the new deletions were moved in", entry.deletedFromHoldingArea);
  section("Moved into the Holding area", describeFiles(totalsOfFiles(entry.moved)), entry.moved.map(sized), true);
  section("Not moved into the Holding area", fileCount(entry.notMoved.length), entry.notMoved.map((file) => `${file.path}: ${file.reason}`));
  total("No longer on the Primary, left on the Replica", entry.leftOnReplica);
  section(
    "Could not be read on the Primary, so skipped",
    itemCount(entry.unreadable.length),
    entry.unreadable.map((item) => `${item.folder ? `${item.path}/ (folder)` : item.path}: ${item.reason}`),
  );
  return lines.join("\n");
}
