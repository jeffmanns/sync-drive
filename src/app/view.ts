/**
 * What the app's screens see and send. Plain data only, so it crosses from Electron's main process
 * to the screens unchanged, and imports nothing from Node, so the screens can use it too.
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
  /** Files only on the Replica. This version never moves them: they stay where they are. */
  deleted: Totals;
  /** The one all-or-nothing Approval for copying the new and changed files. */
  copiesApproved: boolean;
}

/** Reviewing the new and changed files, and approving the copies. */
export interface CopiesState {
  step: "copies";
  review: Review;
}

/** Exactly what Apply will do with the decisions made. */
export interface SummaryState {
  step: "summary";
  review: Review;
  apply: {
    /** The files Apply copies to the Replica: none unless the copies are approved. */
    copy: Totals;
    /** The files only on the Replica, which Apply leaves where they are. */
    leaveOnReplica: Totals;
  };
}

/** Applying the Update. There is no going back from here. */
export interface UpdatingState {
  step: "updating";
  copying: Totals;
}

/** What the Update did. */
export interface ResultState {
  step: "result";
  pairing: Pairing;
  copied: FileEntry[];
  /** Every file that was not copied, and why. The Replica keeps its earlier version of each, if any. */
  failed: FailedFile[];
  /** The files only on the Replica, left where they were. */
  leftOnReplica: Totals;
  /** Why the Update stopped before copying, if it did. */
  error?: string;
}

/** A file that was not copied, and why. The engine's `FailedFile`, restated so the screens need nothing from Node. */
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

/** The IPC channels between the main process and the screens. */
export const CHANNELS = { state: "flow:state", action: "flow:action" } as const;

export type { FileEntry, PairedDrives, Pairing, Section, Totals };
