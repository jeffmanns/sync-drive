/**
 * What the app's screens see and send, and the few rules the flow and the screens share. The state
 * is plain data only, so it crosses from Electron's main process to the screens unchanged. Imports
 * nothing from Node, so the screens can use it too.
 */
import type { PairedDrives, Pairing } from "../engine/pairing.ts";
import type { FileEntry, Move, MoveGroup, MovesSection, Section, Totals, Unreadable } from "../engine/report.ts";
import { SAFETY_STOP_PERCENT } from "../engine/safety-stop-limits.ts";
import { fileCount, formatSize } from "../format.ts";

/** Which screen the app is on. */
export type Step = FlowState["step"];

/** Everything a screen needs to show, for the step the app is on. */
export type FlowState =
  | PairingState
  | StartState
  | ComparingState
  | RefusedState
  | CopiesState
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
  /** Why the last pattern was not added or removed, or why the saved Exclusions cannot be used. */
  exclusionProblem?: string;
  /** Why the last comparison did not happen or was discarded. */
  error?: string;
  /** Something worth knowing that is not a problem, such as the drives already matching. */
  notice?: string;
}

/** Comparing the drives. */
export interface ComparingState {
  step: "comparing";
  pairing: Pairing;
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
  /** The Replica's contents for comparison: the Holding area and the Incoming folder are not counted. */
  replica: Totals;
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
  /** Files on the Primary that are not on the Replica. */
  new: Section;
  /** Files on both drives that a Quick compare judges different. */
  changed: Section;
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
  /** The moved files being renamed on the Replica: none unless the moves are approved. */
  renaming: Totals;
  /** The deleted files being moved into the Holding area: none unless the deletions are approved. */
  moving: Totals;
  /**
   * What is happening to the Primary: it is remounted read-only before anything is written, so
   * that macOS itself keeps it from being written to, then remounted normally once the Update ends.
   */
  primary: PrimaryMountState;
}

/** The Primary's mount during an Update. */
export type PrimaryMountState = "remounting read-only" | "read-only" | "remounting normally";

/** What the Update did. */
export interface ResultState {
  step: "result";
  pairing: Pairing;
  /** What could not be read on the Primary when compared, and so was skipped. What the Replica holds there was left alone. */
  unreadable: Unreadable[];
  copied: FileEntry[];
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
  /** On the refusal screen: the number of deletions as the owner typed it. */
  | { type: "overrideSafetyStop"; typed: string }
  | { type: "approveCopies"; approved: boolean }
  | { type: "approveMoves"; approved: boolean }
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

/** How many `files` there are, and their total size. */
export function totalsOfFiles(files: FileEntry[]): Totals {
  return { count: files.length, totalSize: files.reduce((total, file) => total + file.size, 0) };
}

/** The review steps for `review`, in order: Moves and Deletions only when there is something to move or delete. */
export function reviewSteps(review: Review): ReviewStep[] {
  return [
    "copies",
    ...(review.moves.count > 0 ? (["moves"] as const) : []),
    ...(review.deleted.count > 0 ? (["deletions"] as const) : []),
    "summary",
  ];
}

/** The steps on which the owner reviews the comparison and makes the decisions. */
export type ReviewStep = "copies" | "moves" | "deletions" | "summary";

/**
 * Whether the refusal can be overridden: only when the Safety stop is the sole refusal. The
 * free-space check never can be (ADR 0009).
 */
export function canOverrideSafetyStop(state: RefusedState): state is RefusedState & { safetyStop: SafetyStopRefusal } {
  return state.safetyStop !== undefined && state.freeSpace === undefined;
}

/** What the refusal screen says about the Safety stop: the deleted files' share of the Replica, by count and by size. */
export function safetyStopExplanation({ deleted, replica }: SafetyStopRefusal): string {
  return (
    `The Safety stop applies: ${fileCount(deleted.count)} (${formatSize(deleted.totalSize)}) are no longer on the Primary. ` +
    `That is ${deleted.count.toLocaleString("en-US")} of the Replica's ${fileCount(replica.count)} (${percent(deleted.count, replica.count)}) ` +
    `and ${formatSize(deleted.totalSize)} of its ${formatSize(replica.totalSize)} (${percent(deleted.totalSize, replica.totalSize)}), ` +
    `more than ${SAFETY_STOP_PERCENT}% of the Replica. That often means something is wrong with the Primary: ` +
    `it is failing, was only partly read, or was erased. Check the Primary first.`
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

/** `part` as a share of `whole`, to one decimal place: "50.5%". */
function percent(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(1)}%`;
}

/** The IPC channels between the main process and the screens. */
export const CHANNELS = { state: "flow:state", action: "flow:action" } as const;

export type { FileEntry, Move, MoveGroup, MovesSection, PairedDrives, Pairing, Section, Totals, Unreadable };
