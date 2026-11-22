import {
  checkFreeSpace,
  compare,
  findPairedDrives,
  makeSection,
  nothingDone,
  pair,
  readHoldingArea,
  readPairing,
  SAFETY_STOP_PERCENT,
  update,
  UpdateStoppedError,
  writePairing,
  type FileCopier,
  type PairedDrives,
  type Pairing,
  type Remounter,
  type Report,
  type UpdateResult,
  type Volume,
  type VolumeIdentity,
} from "../engine/index.ts";
import { fileCount, formatSize } from "../format.ts";
import {
  NO_FILES,
  reviewSteps,
  totalsOf,
  totalsOfFiles,
  totalsOfMoves,
  type CopiesState,
  type DeletionsState,
  type FlowState,
  type MovesState,
  type Review,
  type SummaryState,
} from "./view.ts";

/** What the flow needs from the Mac it runs on. */
export interface FlowDeps {
  volumes: VolumeIdentity;
  /** Where the Pairing is stored. */
  pairingFile: string;
  /** Copies files to the Replica with all their metadata. */
  copier: FileCopier;
  /** Remounts the Primary read-only for each Update, and normally afterwards. */
  remounter: Remounter;
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
  /** The Primary while an Update holds it read-only. */
  #readOnlyPrimary: Volume | undefined;
  /** Remounting the Primary normally, once begun: resolves with why it could not, if it could not. */
  #remountingNormally: Promise<string | undefined> | undefined;

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
      const { new: newFiles, changed, moves, deleted } = report;
      if (newFiles.count + changed.count + moves.count + deleted.count === 0) {
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
      // Read now, for the warning before the deletions Approval: approving them deletes these for good.
      const held = deleted.count > 0 ? await readHoldingArea(drives.replica.mountPoint) : NO_FILES;
      if (comparison !== this.#comparisonGeneration) return;
      this.#report = report;
      this.#set({
        step: "copies",
        review: {
          pairing,
          drives,
          new: newFiles,
          changed,
          moves,
          deleted,
          holdingArea: totalsOf(held),
          copiesApproved: false,
          movesApproved: false,
          deletionsApproved: false,
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

  /** On Moves: gives or withdraws the one all-or-nothing Approval for renaming the moved files on the Replica. */
  approveMoves(approved: boolean): void {
    const state = this.#state;
    if (state.step !== "moves") return;
    this.#set({ step: "moves", review: { ...state.review, movesApproved: approved } });
  }

  /** On Deletions: gives or withdraws the one all-or-nothing Approval for the deletions, separate from the copies. */
  approveDeletions(approved: boolean): void {
    const state = this.#state;
    if (state.step !== "deletions") return;
    this.#set({ step: "deletions", review: { ...state.review, deletionsApproved: approved } });
  }

  /**
   * Moves on to the next review step, keeping the decisions made. Moves and Deletions are skipped
   * when there is nothing to move or delete.
   */
  next(): void {
    this.#step(+1);
  }

  /** Goes back to the previous review step, keeping the decisions made. */
  back(): void {
    this.#step(-1);
  }

  /** Goes `by` review steps forward or back, staying put at either end. */
  #step(by: 1 | -1): void {
    const state = this.#state;
    if (!isReviewing(state)) return;
    const { review } = state;
    const steps = reviewSteps(review);
    const step = steps[steps.indexOf(state.step) + by];
    if (step === undefined) return;
    this.#set(step === "summary" ? summaryOf(review) : { step, review });
  }

  /**
   * From a review step or the Result: back to Start, discarding the comparison and its decisions.
   * Not during Comparing or Updating.
   */
  restart(): void {
    const state = this.#state;
    if (isReviewing(state)) {
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
    else if (isReviewing(state)) ({ pairing, drives } = state.review);
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
   * approved. Only with the deletions approved is the Holding area emptied and the deleted files
   * moved into it (ADR 0006). The Safety stop is never overridden.
   */
  async apply(): Promise<void> {
    const state = this.#state;
    const report = this.#report;
    if (state.step !== "summary" || report === undefined) return;
    const { review, apply } = state;
    if (apply.copy.count === 0 && apply.renameOnReplica.count === 0 && apply.moveToHoldingArea.count === 0) return;
    // Apply writes only to the drives that were compared: check they are still the ones connected.
    const gone = await this.#whyDrivesGone(review.pairing, review.drives);
    if (this.#state !== state) return;
    if (gone !== undefined) return this.#discardForGoneDrives(review.pairing, gone);
    if (review.deletionsApproved) {
      // Approving the deletions empties the Holding area for good: only ever what the owner was shown.
      const held = await readHoldingArea(review.drives.replica.mountPoint);
      if (this.#state !== state) return;
      if (held.count !== review.holdingArea.count || held.totalSize !== review.holdingArea.totalSize) {
        this.#discardComparison();
        this.#set({
          step: "start",
          pairing: review.pairing,
          error:
            "The Holding area on the Replica changed since the comparison, so approving the deletions would delete files you were not shown. " +
            "Nothing was written. The comparison and its decisions were discarded. Compare again.",
        });
        return;
      }
    }
    this.#discardComparison();
    const updating = { step: "updating", copying: apply.copy, renaming: apply.renameOnReplica, moving: apply.moveToHoldingArea } as const;
    // Read-only first, so that even a bug cannot write to the Primary: macOS itself refuses.
    this.#set({ ...updating, primary: "remounting read-only" });
    let primary: Volume;
    try {
      primary = await this.#deps.remounter.readOnly(review.drives.primary);
    } catch (error) {
      this.#set({
        step: "start",
        pairing: review.pairing,
        error:
          `The Update did not start, and nothing was written: the Primary could not be remounted read-only first. ${(error as Error).message} ` +
          "Close any app using the Primary, then compare again. The comparison and its decisions were discarded.",
      });
      return;
    }
    this.#readOnlyPrimary = primary;
    this.#remountingNormally = undefined;
    this.#set({ ...updating, primary: "read-only" });
    let done: UpdateResult;
    let error: string | undefined;
    try {
      done = await update(approvedPart(report, review), { update: true, moves: review.movesApproved, deletions: review.deletionsApproved }, {
        primary: primary.mountPoint,
        replica: review.drives.replica.mountPoint,
        copier: this.#deps.copier,
      });
    } catch (stopped) {
      // Stopped partway: still say exactly what it did first.
      done = stopped instanceof UpdateStoppedError ? stopped.result : nothingDone();
      error = (stopped as Error).message;
    }
    this.#set({ ...updating, primary: "remounting normally" });
    const primaryStillReadOnly = await this.#remountPrimaryNormally();
    const handled = totalsOf(totalsOfFiles(done.moved), totalsOfFiles(done.notMoved));
    const leftOnReplica = { count: review.deleted.count - handled.count, totalSize: review.deleted.totalSize - handled.totalSize };
    const renamedOrNot = totalsOf(totalsOfMoves(done.renamed), totalsOfMoves(done.notRenamed));
    const movesLeftAtOldPaths = { count: review.moves.count - renamedOrNot.count, totalSize: review.moves.totalSize - renamedOrNot.totalSize };
    this.#set({
      step: "result",
      pairing: review.pairing,
      copied: done.copied,
      failed: done.failed,
      renamed: done.renamed,
      notRenamed: done.notRenamed,
      movesLeftAtOldPaths,
      moved: done.moved,
      notMoved: done.notMoved,
      leftOnReplica,
      ...(error === undefined ? {} : { error }),
      ...(primaryStillReadOnly === undefined ? {} : { primaryStillReadOnly }),
    });
  }

  /**
   * Call before the app quits. If an Update holds the Primary read-only, remounts it normally first,
   * so that quitting partway through an Update does not leave it read-only.
   */
  async quit(): Promise<void> {
    await this.#remountPrimaryNormally();
  }

  /**
   * Remounts the Primary normally if an Update holds it read-only, only once however often it is
   * called. Resolves with why it could not, if it could not.
   */
  #remountPrimaryNormally(): Promise<string | undefined> {
    const primary = this.#readOnlyPrimary;
    if (primary === undefined) return Promise.resolve(undefined);
    this.#remountingNormally ??= this.#deps.remounter.normally(primary).then(
      () => {
        this.#readOnlyPrimary = undefined;
        return undefined;
      },
      (error: unknown) => (error as Error).message,
    );
    return this.#remountingNormally;
  }
}

/**
 * `report` cut down to the copies Approval, for `update()`. `update()` copies every new and changed
 * file in the report it is given, so without the copies approved they are left out here. The
 * deleted files stay in: `update()` moves them only when given the deletions Approval.
 */
function approvedPart(report: Report, review: Review): Report {
  if (review.copiesApproved) return report;
  const none = makeSection([]);
  return { ...report, new: none, changed: none };
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

/** Whether the app is on one of the review steps, where the owner makes the decisions. */
function isReviewing(state: FlowState): state is CopiesState | MovesState | DeletionsState | SummaryState {
  return state.step === "copies" || state.step === "moves" || state.step === "deletions" || state.step === "summary";
}

/** The Summary for the decisions in `review`. */
function summaryOf(review: Review): SummaryState {
  const copy = review.copiesApproved ? totalsOf(review.new, review.changed) : NO_FILES;
  const moves = totalsOf(review.moves);
  const renames = review.movesApproved
    ? { renameOnReplica: moves, leaveAtOldPaths: NO_FILES }
    : { renameOnReplica: NO_FILES, leaveAtOldPaths: moves };
  const deleted = totalsOf(review.deleted);
  const apply = review.deletionsApproved
    ? { copy, ...renames, moveToHoldingArea: deleted, deleteFromHoldingArea: review.holdingArea, leaveOnReplica: NO_FILES }
    : { copy, ...renames, moveToHoldingArea: NO_FILES, deleteFromHoldingArea: NO_FILES, leaveOnReplica: deleted };
  return { step: "summary", review, apply };
}
