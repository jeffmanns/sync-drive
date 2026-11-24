/**
 * What the app's screens see and send, and the few rules the flow and the screens share. The state
 * is plain data only, so it crosses from Electron's main process to the screens unchanged. Imports
 * nothing from Node, so the screens can use it too.
 */
import type { PairedDrives, Pairing } from "../engine/pairing.ts";
import type { CompareProgress, FilesDone, UpdateProgress } from "../engine/progress.ts";
import type { Anomalies, ContentMismatch, FileEntry, Move, MoveGroup, MovesSection, Section, Totals, Unreadable } from "../engine/report.ts";
import { SAFETY_STOP_PERCENT } from "../engine/safety-stop-limits.ts";
import { fileCount, formatDay, formatSize, howLongAgo } from "../format.ts";

/** Which screen the app is on. */
export type Step = FlowState["step"];

/** Everything a screen needs to show, for the step the app is on. */
export type FlowState =
  | PairingState
  | StartState
  | ComparingState
  | RefusedState
  | CopiesState
  | AnomaliesState
  | MovesState
  | DeletionsState
  | SummaryState
  | UpdatingState
  | ResultState;

/** Choosing the top level of each drive. Shown only when no Pairing is saved, or when re-pairing. */
export interface PairingState {
  step: "pairing";
  /** The drive chosen as the Primary so far, by its top level. */
  primary?: string;
  /** The drive chosen as the Replica so far, by its top level. */
  replica?: string;
  /** Set when re-pairing over a saved Pairing: it is replaced only once the owner confirms. */
  replacing?: { pairing?: Pairing; confirmed: boolean };
  /** Why the last attempt to pair did not work, or why a new Pairing is needed. */
  error?: string;
}

/** The paired drives, before a comparison. */
export interface StartState {
  step: "start";
  pairing: Pairing;
  /** The owner's Exclusions, in the order they were added: left out of every comparison. */
  exclusions: string[];
  /**
   * The folder the next comparison and Update are limited to (relative to the top of the Primary,
   * using `/`), or none for the whole drive. Kept in memory only, until changed or the app quits.
   */
  only?: string;
  /**
   * Whether the next comparison is a Deep verify, reading every file the Quick compare judges equal in
   * full on both drives. Kept in memory only, until changed or the app quits.
   */
  deep: boolean;
  /** When the Replica was last updated, as its last-updated marker says. Absent until it has been read. */
  lastUpdated?: ReplicaLastUpdated;
  /** Why the last pattern was not added or removed, or why the saved Exclusions cannot be used. */
  exclusionProblem?: string;
  /** Why the last comparison did not happen or was discarded. */
  error?: string;
  /** Something worth knowing that is not a problem, such as the drives already matching. */
  notice?: string;
}

/**
 * When the Replica was last updated, from its last-updated marker: of the whole drive, and of each
 * folder updated on its own since (ADR 0019). Or, when that cannot be known, why.
 */
export type ReplicaLastUpdated =
  | { known: true; wholeDrive?: string; folders: FolderUpdated[] }
  | { known: false; reason: string };

/** When an Update limited to `folder` last finished (an ISO 8601 date). The engine's `FolderUpdated`, restated so the screens need nothing from Node. */
export interface FolderUpdated {
  folder: string;
  updated: string;
}

/**
 * What the Holding area holds, not counting its `READ ME.txt`, and the day it was last added to as
 * the `READ ME.txt` gives it. The engine's `HoldingAreaContents`, restated so the screens need nothing from Node.
 */
export interface HoldingArea extends Totals {
  lastAddedOn?: string;
}

/** Comparing the drives. */
export interface ComparingState {
  step: "comparing";
  pairing: Pairing;
  /** Whether it is a Deep verify, which has a checksum phase. */
  deep: boolean;
  /** How far the comparison has got. Absent until it has read the drives' item counts. */
  progress?: CompareProgress;
}

/**
 * The Update is refused, after Comparing and before any Approval, with nothing written: the Safety
 * stop applies, or the Replica lacks the free space for the copies, or both (ADR 0008). Only the
 * Safety stop can be overridden, by typing the number of deletions, and only when it is the sole
 * refusal (ADR 0009).
 */
export interface RefusedState {
  step: "refused";
  /** The comparison that was refused, which the override goes on to review. */
  review: Review;
  /** Set when the Safety stop applies. */
  safetyStop?: SafetyStopRefusal;
  /** Set when the Replica lacks the free space for the copies. There is no override. */
  freeSpace?: FreeSpaceRefusal;
}

/** Why the Safety stop applies: the deleted files' share of the Replica. */
export interface SafetyStopRefusal {
  /** The files only on the Replica, which approving the deletions would move into the Holding area. */
  deleted: Totals;
  /**
   * The Replica's contents for comparison: the Holding area and the Incoming folder are not counted.
   * Only the folder's contents when the run is limited to one.
   */
  replica: Totals;
  /** The folder the run is limited to, if any: the share is of its contents. */
  only?: string;
  /** Why the last number typed did not override it. */
  error?: string;
}

/** Why the Replica lacks room for the copies. */
export interface FreeSpaceRefusal {
  /** Bytes the new and changed files need on the Replica. */
  needed: number;
  /** Bytes free on the Replica. */
  free: number;
  /** What the Holding area on the Replica holds, which the owner could delete to free space. */
  holdingArea: Totals;
}

/**
 * The current comparison and the owner's decisions on it. Decisions belong to this comparison
 * only: a new compare, a drive disconnecting or quitting discards them.
 */
export interface Review {
  pairing: Pairing;
  /** Where the paired drives were connected when compared. */
  drives: PairedDrives;
  /** The Exclusions the comparison left out, which Apply is held to. */
  exclusions: string[];
  /** The folder the comparison was limited to, if any, which Apply is held to. */
  only?: string;
  /** Whether the comparison was a Deep verify, which compared contents by checksum. */
  deep: boolean;
  /** Files on the Primary that are not on the Replica. */
  new: Section;
  /** Files on both drives that a Quick compare judges different. */
  changed: Section;
  /**
   * Anomalies: changed files whose Replica copy is newer (also in `changed`, so the copies Approval
   * replaces them), and content mismatches (in no other section), which only a per-file choice changes.
   */
  anomalies: Anomalies;
  /**
   * The owner's per-file choices on the content mismatches, by path: keep the Replica's copy, or
   * overwrite it with the Primary's. A mismatch with no choice is left alone. These are not Approvals.
   */
  mismatchChoices: Record<string, MismatchChoice>;
  /** Files only on the Replica, which the deletions Approval moves into the Holding area. */
  deleted: Section;
  /** Files moved or renamed on the Primary, confirmed by checksum, which the moves Approval renames on the Replica. */
  moves: MovesSection;
  /**
   * Unreadable: what could not be read on the Primary, in path order. Each is skipped, and what the
   * Replica holds at or under its path stays there, whatever is approved.
   */
  unreadable: Unreadable[];
  /** The one all-or-nothing Approval for copying the new and changed files. */
  copiesApproved: boolean;
  /**
   * The one all-or-nothing Approval for the moves, separate from the others: rename the moved files
   * on the Replica. Without it they stay at their old paths and nothing is copied to the new ones.
   */
  movesApproved: boolean;
  /**
   * What the Holding area on the Replica held when compared, which the deletions Approval deletes
   * permanently. Read only when there are deletions; otherwise none.
   */
  holdingArea: Totals;
  /**
   * The one all-or-nothing Approval for the deletions, separate from the copies Approval: empty the
   * Holding area, then move the deleted files into it (ADR 0006).
   */
  deletionsApproved: boolean;
  /**
   * Whether the owner typed the number of deletions on the refusal screen, overriding the Safety
   * stop for this comparison only (ADR 0009). Never remembered beyond it.
   */
  safetyStopOverridden: boolean;
}

/** Reviewing the new and changed files, and approving the copies. */
export interface CopiesState {
  step: "copies";
  review: Review;
}

/** What the owner chose for one content mismatch: keep the Replica's copy, or overwrite it with the Primary's. */
export type MismatchChoice = "keep" | "overwrite";

/**
 * Choosing, file by file, what to do with the content mismatches a Deep verify found. Comes after
 * Copies and before Moves, and only when there are content mismatches.
 */
export interface AnomaliesState {
  step: "anomalies";
  review: Review;
}

/**
 * Reviewing the files moved on the Primary, and approving their renames on the Replica. Comes after
 * Copies, and only when something was moved.
 */
export interface MovesState {
  step: "moves";
  review: Review;
}

/**
 * Reviewing the files only on the Replica, and approving the deletions. Comes after Copies and
 * Moves, and only when there is something to delete.
 */
export interface DeletionsState {
  step: "deletions";
  review: Review;
}

/** Exactly what Apply will do with the decisions made. */
export interface SummaryState {
  step: "summary";
  review: Review;
  apply: {
    /** The files Apply copies to the Replica: none unless the copies are approved. */
    copy: Totals;
    /** The content mismatches whose Replica copy Apply overwrites with the Primary's, as chosen. */
    overwrite: Totals;
    /** The content mismatches whose Replica copy Apply keeps, as chosen. */
    keep: Totals;
    /** The content mismatches with no choice, which Apply leaves as they are. */
    leaveUndecided: Totals;
    /** The moved files Apply renames on the Replica: none unless the moves are approved. */
    renameOnReplica: Totals;
    /** The moved files Apply leaves at their old paths on the Replica: all of them unless the moves are approved. */
    leaveAtOldPaths: Totals;
    /** The files only on the Replica that Apply moves into the Holding area: none unless the deletions are approved. */
    moveToHoldingArea: Totals;
    /**
     * What the Holding area held when compared, which Apply deletes permanently before moving the
     * new deletions in: none unless the deletions are approved (ADR 0006).
     */
    deleteFromHoldingArea: Totals;
    /** The files only on the Replica that Apply leaves where they are: all of them unless the deletions are approved. */
    leaveOnReplica: Totals;
  };
}

/** Applying the Update. There is no going back from here. */
export interface UpdatingState {
  step: "updating";
  copying: Totals;
  /** The content mismatches whose Replica copy is being overwritten with the Primary's, as chosen. */
  overwriting: Totals;
  /** The moved files being renamed on the Replica: none unless the moves are approved. */
  renaming: Totals;
  /** The deleted files being moved into the Holding area: none unless the deletions are approved. */
  moving: Totals;
  /**
   * What is happening to the Primary: it is remounted read-only before anything is written, so
   * that macOS itself keeps it from being written to, then remounted normally once the Update ends.
   */
  primary: PrimaryMountState;
  /** How far the Update has got. Absent until the Primary is read-only and the Update has passed its checks. */
  progress?: UpdateProgress;
}

/** The Primary's mount during an Update. */
export type PrimaryMountState = "remounting read-only" | "read-only" | "remounting normally";

/** What the Update did. */
export interface ResultState {
  step: "result";
  pairing: Pairing;
  /** The folder the Update was limited to, if any. */
  only?: string;
  /** What could not be read on the Primary when compared, and so was skipped. What the Replica holds there was left alone. */
  unreadable: Unreadable[];
  /** Every file copied, including the content mismatches overwritten. */
  copied: FileEntry[];
  /** The content mismatches whose Replica copy was overwritten with the Primary's: also in `copied`. */
  overwritten: FileEntry[];
  /** Every file that was not copied, and why. The Replica keeps its earlier version of each, if any. */
  failed: FailedFile[];
  /** Moved files renamed to their new paths on the Replica. */
  renamed: Move[];
  /** Every moved file that was not renamed, and why. Each is still at its old path on the Replica. */
  notRenamed: FailedMove[];
  /**
   * The moved files left at their old paths that are not in `notRenamed`: all of them unless the
   * moves were approved, and any the Update stopped before reaching.
   */
  movesLeftAtOldPaths: Totals;
  /** Deleted files moved into the Holding area. */
  moved: FileEntry[];
  /** Every deleted file that was not moved into the Holding area, and why. Each is still where it was on the Replica. */
  notMoved: FailedFile[];
  /**
   * The files only on the Replica that were left where they were and are not in `notMoved`: all of
   * them unless the deletions were approved, and any the Update stopped before reaching.
   */
  leftOnReplica: Totals;
  /**
   * What the Holding area on the Replica holds after the Update, from this Update or an earlier one,
   * and when it was last added to. Absent if it could not be read.
   */
  holdingArea?: HoldingArea;
  /** Why the Holding area could not be read after the Update, if it could not. */
  holdingAreaProblem?: string;
  /** Where on the Mac this Update is logged. */
  updateLog?: string;
  /** Why this Update could not be logged on the Mac, if it could not. */
  updateLogProblem?: string;
  /** Why the Update stopped before it finished, if it did. `copied`, `failed`, `moved` and `notMoved` still say what it did first. */
  error?: string;
  /** Why the Primary could not be remounted normally after the Update, if it could not. It is still read-only. */
  primaryStillReadOnly?: string;
}

/** A file that was not copied or moved, and why. The engine's `FailedFile`, restated so the screens need nothing from Node. */
export interface FailedFile extends FileEntry {
  reason: string;
}

/** A moved file that was not renamed, and why. The engine's `FailedMove`, restated so the screens need nothing from Node. */
export interface FailedMove extends Move {
  reason: string;
}

/** Everything the screens can ask for. The main process carries each out on the flow. */
export type Action =
  /** Opens the folder chooser for one role on Pairing. */
  | { type: "choose"; role: "primary" | "replica" }
  | { type: "pair" }
  | { type: "beginRepair" }
  | { type: "confirmReplace"; confirmed: boolean }
  | { type: "cancelRepair" }
  | { type: "compare" }
  /** On Start: a pattern as the owner typed it, to add to the Exclusions. */
  | { type: "addExclusion"; typed: string }
  /** On Start: a saved Exclusion to remove. */
  | { type: "removeExclusion"; pattern: string }
  /** On Start: opens the folder chooser on the Primary, to limit the run to one folder. */
  | { type: "chooseOnlyFolder" }
  /** On Start: compares the whole drive again. */
  | { type: "wholeDrive" }
  /** On Start: chooses a Deep verify, or a Quick compare, for the next comparison. */
  | { type: "deepVerify"; on: boolean }
  /** On the refusal screen: the number of deletions as the owner typed it. */
  | { type: "overrideSafetyStop"; typed: string }
  | { type: "approveCopies"; approved: boolean }
  | { type: "approveMoves"; approved: boolean }
  /** On Anomalies: the owner's choice for one content mismatch. */
  | { type: "chooseForMismatch"; path: string; choice: MismatchChoice }
  | { type: "approveDeletions"; approved: boolean }
  | { type: "next" }
  | { type: "back" }
  | { type: "restart" }
  | { type: "apply" };

/** What the preload script gives the screens, as `window.syncDrive`. */
export interface SyncDriveBridge {
  state(): Promise<FlowState>;
  send(action: Action): Promise<void>;
  /** Calls `listener` with every new state. Returns a function that stops the calls. */
  onState(listener: (state: FlowState) => void): () => void;
}

/** No files at all. */
export const NO_FILES: Totals = { count: 0, totalSize: 0 };

/** How many files there are in all of `parts` together, and their total size, as plain Totals. */
export function totalsOf(...parts: Totals[]): Totals {
  return parts.reduce<Totals>((all, part) => ({ count: all.count + part.count, totalSize: all.totalSize + part.totalSize }), NO_FILES);
}

/** How many `moves` there are, and their total size. */
export function totalsOfMoves(moves: Move[]): Totals {
  return { count: moves.length, totalSize: moves.reduce((total, move) => total + move.size, 0) };
}

/** The content mismatches in `review` the owner gave `choice`, or no choice when it is `undefined`. */
export function mismatchesChosen(review: Review, choice: MismatchChoice | undefined): ContentMismatch[] {
  return review.anomalies.contentMismatch.files.filter((file) => review.mismatchChoices[file.path] === choice);
}

/** Whether Apply, as the Summary shows it, would write anything to the Replica. */
export function writesAnything(apply: SummaryState["apply"]): boolean {
  return apply.copy.count + apply.overwrite.count + apply.renameOnReplica.count + apply.moveToHoldingArea.count > 0;
}

/** How many `files` there are, and their total size. */
export function totalsOfFiles(files: FileEntry[]): Totals {
  return { count: files.length, totalSize: files.reduce((total, file) => total + file.size, 0) };
}

/**
 * The review steps for `review`, in order: Anomalies only when there are content mismatches, Moves and
 * Deletions only when there is something to move or delete.
 */
export function reviewSteps(review: Review): ReviewStep[] {
  return [
    "copies",
    ...(review.anomalies.contentMismatch.count > 0 ? (["anomalies"] as const) : []),
    ...(review.moves.count > 0 ? (["moves"] as const) : []),
    ...(review.deleted.count > 0 ? (["deletions"] as const) : []),
    "summary",
  ];
}

/** The steps on which the owner reviews the comparison and makes the decisions. */
export type ReviewStep = "copies" | "anomalies" | "moves" | "deletions" | "summary";

/**
 * Whether the refusal can be overridden: only when the Safety stop is the sole refusal. The
 * free-space check never can be (ADR 0009).
 */
export function canOverrideSafetyStop(state: RefusedState): state is RefusedState & { safetyStop: SafetyStopRefusal } {
  return state.safetyStop !== undefined && state.freeSpace === undefined;
}

/**
 * What Start says about when the Replica was last updated, as of `now`: how long ago, and on which
 * day. A folder updated on its own since is listed apart, as the rest of the Replica was not updated
 * with it (ADR 0019).
 */
export function lastUpdatedLines(lastUpdated: ReplicaLastUpdated, now: Date): string[] {
  if (!lastUpdated.known) return [lastUpdated.reason];
  const when = (iso: string) => `${howLongAgo(new Date(iso), now)}, on ${formatDay(new Date(iso))}`;
  const { wholeDrive, folders } = lastUpdated;
  return [
    wholeDrive === undefined ? "sync-drive has not updated the whole Replica yet." : `Replica last updated ${when(wholeDrive)}.`,
    ...folders.map(({ folder, updated }) =>
      `${wholeDrive === undefined ? "Only" : "Since then, only"} the folder "${folder}" was updated: ${when(updated)}.`,
    ),
  ];
}

/**
 * What the Result says about the Holding area: what it holds and when it was last added to, which may
 * be by an earlier Update (ADR 0006), and how to restore a file from it.
 */
export function holdingAreaReminder(held: HoldingArea): string[] {
  if (held.count === 0) return ["The Holding area on the Replica is empty."];
  const when = held.lastAddedOn === undefined ? "" : `, last added to by the Update on ${held.lastAddedOn}`;
  return [
    `The Holding area on the Replica holds ${fileCount(held.count)} (${formatSize(held.totalSize)})${when}.`,
    "They stay there until an Update whose deletions you approve, which deletes them for good.",
    "To restore a file, copy it from the Holding area back to the Primary, into its original folder. " +
      "Do not move it back on the Replica: the next Update would treat it as deleted again.",
  ];
}

/**
 * What the refusal screen says about the Safety stop: the deleted files' share of the Replica, or of
 * the folder the run is limited to, by count and by size.
 */
export function safetyStopExplanation({ deleted, replica, only }: SafetyStopRefusal): string {
  const share =
    only === undefined
      ? `That is ${deleted.count.toLocaleString("en-US")} of the Replica's ${fileCount(replica.count)} (${percent(deleted.count, replica.count)}) ` +
        `and ${formatSize(deleted.totalSize)} of its ${formatSize(replica.totalSize)} (${percent(deleted.totalSize, replica.totalSize)}), ` +
        `more than ${SAFETY_STOP_PERCENT}% of the Replica.`
      : `That is ${deleted.count.toLocaleString("en-US")} of the ${fileCount(replica.count)} in "${only}" on the Replica (${percent(deleted.count, replica.count)}) ` +
        `and ${formatSize(deleted.totalSize)} of their ${formatSize(replica.totalSize)} (${percent(deleted.totalSize, replica.totalSize)}), ` +
        `more than ${SAFETY_STOP_PERCENT}% of the folder.`;
  return (
    `The Safety stop applies: ${fileCount(deleted.count)} (${formatSize(deleted.totalSize)}) are no longer on the Primary. ` +
    `${share} That often means something is wrong with the Primary: ` +
    `it is failing, was only partly read, or was erased. Check the Primary first.`
  );
}

/**
 * What the review steps, the Summary and the Result say about a run limited to the folder `only`:
 * what it leaves alone, and that a file moved across its edge cannot be recognised as a move.
 */
export function onlyFolderNote(only: string): string {
  return (
    `Limited to the folder "${only}": nothing outside it is compared, copied, moved or deleted. ` +
    `Files moved into or out of it since the last Update cannot be recognised as moves, so they appear as new or deleted.`
  );
}

/**
 * The warning on Deletions in a run limited to the folder `only`: a file moved out of it shows as
 * deleted, and if it cannot be read where it now is on the Primary, the Replica's copy may be its only
 * backup. A whole-drive comparison would keep that copy; this one cannot see it (ADR 0017).
 */
export function onlyFolderDeletionsWarning(only: string): string {
  return (
    `Files moved out of "${only}" on the Primary show here as deleted. If any of them cannot be read on the Primary where they are now, ` +
    `the copy here may be their only backup. If you are unsure, leave the deletions unapproved until an Update of the whole drive.`
  );
}

/** What the refusal screen says about the free space: what is needed and free, and what the Holding area holds. */
export function freeSpaceExplanation({ needed, free, holdingArea }: FreeSpaceRefusal): string {
  return (
    `The Replica has ${formatSize(free)} free, but the new and changed files need ${formatSize(needed)}. ` +
    (holdingArea.count > 0
      ? `The Holding area on the Replica holds ${formatSize(holdingArea.totalSize)} from the previous Update. Deleting it frees that space, ` +
        `but its files are then gone for good, so first copy back to the Primary any you want to keep. `
      : `The Replica needs a larger drive, or files other than those copied from the Primary removed from it. `) +
    `Then compare again.`
  );
}

/**
 * A progress bar: how full it is, from 0 to 1, and what it says. Without `fraction` it is a moving
 * bar with no percentage, for work whose total is not known.
 */
export interface ProgressBar {
  fraction?: number;
  label: string;
}

/**
 * The fullest the Comparing bar gets before the comparison finishes. The item counts are only an
 * estimate, so the bar must not claim to be done before it is.
 */
const COMPARING_MOST = 0.99;

/**
 * The Comparing bar: items scanned out of the drives' item counts, then with Deep verify (`deep`)
 * bytes read to verify contents, then bytes read to confirm moves. A moving bar when a drive has no
 * usable count, or before the counts are read. Its label names the stage, so the bar starting again
 * for a later stage does not look like going backwards.
 */
export function comparingBar(progress: CompareProgress | undefined, deep = false): ProgressBar {
  const capped = (part: number, whole: number) => (whole > 0 ? { fraction: Math.min(part / whole, COMPARING_MOST) } : {});
  const stages = deep ? 3 : 2;
  const reading = `Step 1 of ${stages}, reading both drives`;
  if (progress === undefined) return { label: `${reading}: counting their items` };
  if (progress.phase === "verifying" || progress.phase === "checking moves") {
    const [stage, what] = progress.phase === "verifying" ? [2, "verifying contents by checksum"] : [stages, "confirming moved files by checksum"];
    return {
      ...capped(progress.checkedBytes, progress.totalBytes),
      label: `Step ${stage} of ${stages}, ${what}: ${formatSize(progress.checkedBytes)} of ${formatSize(progress.totalBytes)}`,
    };
  }
  const scanned = progress.scanned.toLocaleString("en-US");
  if (progress.total === undefined || progress.total === 0) return { label: `${reading}: ${scanned} items` };
  return { ...capped(progress.scanned, progress.total), label: `${reading}: ${scanned} of about ${progress.total.toLocaleString("en-US")} items` };
}

/**
 * What the Updating screen says above its bar, in the order the Update does them: deleted files
 * moved into the Holding area, then moves renamed. Only for what was approved.
 */
export function updatingLines(progress: UpdateProgress | undefined): string[] {
  if (progress === undefined) return [];
  const line = (what: string, { done, total }: FilesDone) =>
    total > 0 ? [`${what}: ${done.toLocaleString("en-US")} of ${fileCount(total)}`] : [];
  return [...line("Moved into the Holding area", progress.deletions), ...line("Renamed on the Replica", progress.moves)];
}

/** The Updating bar: bytes copied out of the approved total. None when nothing is copied, or before the Update starts. */
export function updatingBar(progress: UpdateProgress | undefined): ProgressBar | undefined {
  if (progress === undefined || progress.copies.totalBytes === 0) return undefined;
  const { copiedBytes, notCopiedBytes, totalBytes } = progress.copies;
  return {
    fraction: (copiedBytes + notCopiedBytes) / totalBytes,
    label:
      `Copied ${formatSize(copiedBytes)} of ${formatSize(totalBytes)}` +
      (notCopiedBytes > 0 ? ` (${formatSize(notCopiedBytes)} could not be copied)` : ""),
  };
}

/** `part` as a share of `whole`, to one decimal place: "50.5%". */
function percent(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(1)}%`;
}

/** The IPC channels between the main process and the screens. */
export const CHANNELS = { state: "flow:state", action: "flow:action" } as const;

export type { CompareProgress, UpdateProgress };
export type { Anomalies, ContentMismatch, FileEntry, Move, MoveGroup, MovesSection, PairedDrives, Pairing, Section, Totals, Unreadable };
