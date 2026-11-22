import {
  checkFreeSpace,
  compare,
  findPairedDrives,
  pair,
  readHoldingArea,
  readPairing,
  SAFETY_STOP_PERCENT,
  update,
  writePairing,
  type FileCopier,
  type PairedDrives,
  type Pairing,
  type Report,
  type VolumeIdentity,
} from "../engine/index.ts";
import { fileCount, formatSize } from "../format.ts";
import type { FlowState, Review, SummaryState, Totals } from "./view.ts";

/** What the flow needs from the Mac it runs on. */
export interface FlowDeps {
  volumes: VolumeIdentity;
  /** Where the Pairing is stored. */
  pairingFile: string;
  /** Copies files to the Replica with all their metadata. */
  copier: FileCopier;
}

/**
 * The app's step logic: which step comes next, Back and Next, the decisions kept between steps,
 * and what Apply passes to `update()`. Runs the engine itself; the screens only show `state`
 * and call these methods. A method called on a step it does not belong to does nothing.
 */
export class Flow {
  readonly #deps: FlowDeps;
  #state: FlowState = { step: "pairing" };
  readonly #listeners = new Set<(state: FlowState) => void>();
  /** Counts comparisons, so the result of one that has since been discarded is ignored. */
  #comparisonGeneration = 0;
  /** The Report of the comparison under review, exactly as `compare()` returned it, for Apply. */
  #report: Report | undefined;

  constructor(deps: FlowDeps) {
    this.#deps = deps;
  }

  /** What the screens show now. */
  get state(): FlowState {
    return this.#state;
  }

  /** Calls `listener` with every new state. Returns a function that stops the calls. */
  onChange(listener: (state: FlowState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(state: FlowState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  /** Opens the app: on Pairing when no Pairing is saved, otherwise on Start. */
  async open(): Promise<void> {
    let pairing: Pairing | undefined;
    try {
      pairing = await readPairing(this.#deps.pairingFile);
    } catch {
      // A damaged Pairing is replaced like any other: only after the extra confirmation.
      this.#set({
        step: "pairing",
        replacing: { confirmed: false },
        error: "The saved Pairing is damaged. Choose the drives again to replace it.",
      });
      return;
    }
    this.#set(pairing === undefined ? { step: "pairing" } : { step: "start", pairing });
  }

  /** On Start: the deliberate Re-pair, e.g. after replacing a drive. Nothing changes until it is confirmed. */
  beginRepair(): void {
    const state = this.#state;
    if (state.step !== "start") return;
    this.#set({ step: "pairing", replacing: { pairing: state.pairing, confirmed: false } });
  }

  /** On Pairing while re-pairing: the extra confirmation that the saved Pairing may be replaced. */
  confirmReplace(confirmed: boolean): void {
    const state = this.#state;
    if (state.step !== "pairing" || state.replacing === undefined) return;
    const { error: _, ...rest } = state;
    this.#set({ ...rest, replacing: { ...state.replacing, confirmed } });
  }

  /** On Pairing while re-pairing: back to Start with the saved Pairing unchanged. */
  cancelRepair(): void {
    const state = this.#state;
    if (state.step !== "pairing" || state.replacing?.pairing === undefined) return;
    this.#set({ step: "start", pairing: state.replacing.pairing });
  }

  /** On Pairing: chooses the top level of the drive for one role. */
  choose(role: "primary" | "replica", path: string): void {
    const state = this.#state;
    if (state.step !== "pairing") return;
    const { error: _, ...rest } = state;
    this.#set({ ...rest, [role]: path });
  }

  /** On Pairing: pairs the chosen drives and saves the Pairing, then moves on to Start. */
  async pair(): Promise<void> {
    const state = this.#state;
    if (state.step !== "pairing" || state.primary === undefined || state.replica === undefined) return;
    if (state.replacing !== undefined && !state.replacing.confirmed) {
      this.#set({ ...state, error: "Confirm that the saved Pairing should be replaced." });
      return;
    }
    try {
      const pairing = await pair(state.primary, state.replica, this.#deps.volumes);
      await writePairing(this.#deps.pairingFile, pairing);
      this.#set({ step: "start", pairing });
    } catch (error) {
      this.#set({ ...state, error: (error as Error).message });
    }
  }

  /** On Start: finds the paired drives and compares them, then moves on to Copies. */
  async compare(): Promise<void> {
    const state = this.#state;
    if (state.step !== "start") return;
    const { pairing } = state;
    this.#discardComparison();
    const comparison = this.#comparisonGeneration;
    this.#set({ step: "comparing", pairing });
    try {
      const drives = await findPairedDrives(pairing, this.#deps.volumes);
      const report = await compare(drives.primary.mountPoint, drives.replica.mountPoint);
      if (comparison !== this.#comparisonGeneration) return;
      const { new: newFiles, changed, deleted } = report;
      if (newFiles.count + changed.count + deleted.count === 0) {
        this.#set({ step: "start", pairing, notice: "The Replica matches the Primary. Nothing to update." });
        return;
      }
      // Both stops are checked before any Approval, so a refused Update asks nothing (ADR 0008).
      const reasons = await refusals(report, drives);
      if (comparison !== this.#comparisonGeneration) return;
      if (reasons.length > 0) {
        this.#set({ step: "refused", pairing, reasons });
        return;
      }
      this.#report = report;
      this.#set({
        step: "copies",
        review: {
          pairing,
          drives,
          new: newFiles,
          changed,
          deleted: { count: deleted.count, totalSize: deleted.totalSize },
          copiesApproved: false,
        },
      });
    } catch (error) {
      if (comparison !== this.#comparisonGeneration) return;
      this.#set({ step: "start", pairing, error: (error as Error).message });
    }
  }

  /** On Copies: gives or withdraws the one all-or-nothing Approval for the copies. */
  approveCopies(approved: boolean): void {
    const state = this.#state;
    if (state.step !== "copies") return;
    this.#set({ step: "copies", review: { ...state.review, copiesApproved: approved } });
  }

  /** Moves on to the next review step, keeping the decisions made. */
  next(): void {
    const state = this.#state;
    if (state.step === "copies") this.#set(summaryOf(state.review));
  }

  /** Goes back to the previous review step, keeping the decisions made. */
  back(): void {
    const state = this.#state;
    if (state.step === "summary") this.#set({ step: "copies", review: state.review });
  }

  /**
   * From a review step or the Result: back to Start, discarding the comparison and its decisions.
   * Not during Comparing or Updating.
   */
  restart(): void {
    const state = this.#state;
    if (state.step === "copies" || state.step === "summary") {
      this.#discardComparison();
      this.#set({ step: "start", pairing: state.review.pairing });
    } else if (state.step === "result" || state.step === "refused") {
      this.#set({ step: "start", pairing: state.pairing });
    }
  }

  /**
   * Call when drives are connected or disconnected. While a comparison is running or under
   * review, discards it and its decisions, back on Start, if a paired drive has gone.
   */
  async drivesChanged(): Promise<void> {
    const state = this.#state;
    let pairing: Pairing;
    let drives: PairedDrives | undefined;
    if (state.step === "comparing" || state.step === "refused") pairing = state.pairing;
    else if (state.step === "copies" || state.step === "summary") ({ pairing, drives } = state.review);
    else return;
    const comparison = this.#comparisonGeneration;
    const gone = await this.#whyDrivesGone(pairing, drives);
    if (gone === undefined || comparison !== this.#comparisonGeneration) return;
    this.#discardForGoneDrives(pairing, gone);
  }

  /** Discards the comparison and its decisions because of `gone`, back on Start. */
  #discardForGoneDrives(pairing: Pairing, gone: string): void {
    this.#discardComparison();
    this.#set({
      step: "start",
      pairing,
      error: `${gone} The comparison and its decisions were discarded. Compare again once both drives are connected.`,
    });
  }

  /**
   * Why the paired drives can no longer be used for a comparison made of `drives` (or, without
   * `drives`, for a new one), or `undefined` if they can.
   */
  async #whyDrivesGone(pairing: Pairing, drives?: PairedDrives): Promise<string | undefined> {
    let now: PairedDrives;
    try {
      now = await findPairedDrives(pairing, this.#deps.volumes);
    } catch (error) {
      return (error as Error).message;
    }
    if (drives !== undefined && (now.primary.mountPoint !== drives.primary.mountPoint || now.replica.mountPoint !== drives.replica.mountPoint)) {
      return "The paired drives were disconnected and connected again.";
    }
    return undefined;
  }

  /** Forgets the current comparison and its decisions, and ignores any comparison still running. */
  #discardComparison(): void {
    this.#comparisonGeneration += 1;
    this.#report = undefined;
  }

  /**
   * On Summary: applies the Update exactly as summarised. Copies are written only with the copies
   * approved; deleted files are never moved, and the Safety stop is never overridden.
   */
  async apply(): Promise<void> {
    const state = this.#state;
    const report = this.#report;
    if (state.step !== "summary" || state.apply.copy.count === 0 || report === undefined) return;
    const { review } = state;
    // Apply writes only to the drives that were compared: check they are still the ones connected.
    const gone = await this.#whyDrivesGone(review.pairing, review.drives);
    if (this.#state !== state) return;
    if (gone !== undefined) return this.#discardForGoneDrives(review.pairing, gone);
    this.#discardComparison();
    this.#set({ step: "updating", copying: state.apply.copy });
    const base = { step: "result", pairing: review.pairing, leftOnReplica: review.deleted } as const;
    try {
      const result = await update(report, { update: true, deletions: false }, {
        primary: review.drives.primary.mountPoint,
        replica: review.drives.replica.mountPoint,
        copier: this.#deps.copier,
      });
      this.#set({ ...base, copied: result.copied, failed: result.failed });
    } catch (error) {
      this.#set({ ...base, copied: [], failed: [], error: (error as Error).message });
    }
  }
}

/** Why an Update of `report` must be refused, if it must: the Safety stop, and the free-space check. */
async function refusals(report: Report, drives: PairedDrives): Promise<string[]> {
  const reasons: string[] = [];
  const { deleted } = report;
  if (report.safetyStop) {
    reasons.push(
      `The Safety stop applies: ${fileCount(deleted.count)} (${formatSize(deleted.totalSize)}) would go into the Holding area, ` +
        `more than ${SAFETY_STOP_PERCENT}% of the Replica. That often means something is wrong with the Primary: ` +
        `it is failing, was only partly read, or was erased. Check the Primary first. ` +
        `This version of the app cannot go past the Safety stop.`,
    );
  }
  if (report.new.count + report.changed.count > 0) {
    const replica = drives.replica.mountPoint;
    const space = await checkFreeSpace(report, replica);
    if (!space.enough) {
      const held = await readHoldingArea(replica);
      reasons.push(
        `The Replica has ${formatSize(space.free)} free, but the new and changed files need ${formatSize(space.needed)}. ` +
          (held.count > 0
            ? `The Holding area on the Replica holds ${formatSize(held.totalSize)} from the previous Update. Deleting it frees that space, ` +
              `but its files are then gone for good, so first copy back to the Primary any you want to keep. `
            : `The Replica needs a larger drive, or files other than those copied from the Primary removed from it. `) +
          `Then compare again.`,
      );
    }
  }
  return reasons;
}

/** The Summary for the decisions in `review`. */
function summaryOf(review: Review): SummaryState {
  const copy: Totals = review.copiesApproved
    ? { count: review.new.count + review.changed.count, totalSize: review.new.totalSize + review.changed.totalSize }
    : { count: 0, totalSize: 0 };
  return { step: "summary", review, apply: { copy, leaveOnReplica: review.deleted } };
}
