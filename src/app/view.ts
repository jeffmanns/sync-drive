/**
 * What the app's screens see and send, and the few rules the flow and the screens share. The state
 * is plain data only, so it crosses from Electron's main process to the screens unchanged. Imports
 * nothing from Node, so the screens can use it too.
 */
import type { PairedDrives, Pairing } from "../engine/pairing.ts";
import type { FileEntry, Section, Totals } from "../engine/report.ts";

/** Which screen the app is on. */
export type Step = FlowState["step"];

/** Everything a screen needs to show, for the step the app is on. */
export type FlowState =
  | PairingState
  | StartState
  | ComparingState
  | RefusedState
  | CopiesState
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
 * The Update is refused, before any Approval and with nothing written: the Safety stop applies,
 * or the Replica lacks the free space for the copies (ADR 0008). There is no way past it here.
 */
export interface RefusedState {
  step: "refused";
  pairing: Pairing;
  /** Each refusal, explained. */
  reasons: string[];
}

/**
 * The current comparison and the owner's decisions on it. Decisions belong to this comparison
 * only: a new compare, a drive disconnecting or quitting discards them.
 */
export interface Review {
  pairing: Pairing;
  /** Where the paired drives were connected when compared. */
  drives: PairedDrives;
  /** Files on the Primary that are not on the Replica. */
  new: Section;
  /** Files on both drives that a Quick compare judges different. */
  changed: Section;
  /** Files only on the Replica, which the deletions Approval moves into the Holding area. */
  deleted: Section;
  /** The one all-or-nothing Approval for copying the new and changed files. */
  copiesApproved: boolean;
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
}

/** Reviewing the new and changed files, and approving the copies. */
export interface CopiesState {
  step: "copies";
  review: Review;
}

/**
 * Reviewing the files only on the Replica, and approving the deletions. Comes after Copies, and
 * only when there is something to delete.
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
  /** The deleted files being moved into the Holding area: none unless the deletions are approved. */
  moving: Totals;
}

/** What the Update did. */
export interface ResultState {
  step: "result";
  pairing: Pairing;
  copied: FileEntry[];
  /** Every file that was not copied, and why. The Replica keeps its earlier version of each, if any. */
  failed: FailedFile[];
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
}

/** A file that was not copied or moved, and why. The engine's `FailedFile`, restated so the screens need nothing from Node. */
export interface FailedFile extends FileEntry {
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
  | { type: "approveCopies"; approved: boolean }
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

/** How many `files` there are, and their total size. */
export function totalsOfFiles(files: FileEntry[]): Totals {
  return { count: files.length, totalSize: files.reduce((total, file) => total + file.size, 0) };
}

/** Whether the review has a Deletions step: only when there is something to delete. */
export function hasDeletionsStep(review: Review): boolean {
  return review.deleted.count > 0;
}

/** The IPC channels between the main process and the screens. */
export const CHANNELS = { state: "flow:state", action: "flow:action" } as const;

export type { FileEntry, PairedDrives, Pairing, Section, Totals };
