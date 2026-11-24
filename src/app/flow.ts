import { isAbsolute, relative, sep } from "node:path";
import {
  checkExclusion,
  checkFreeSpace,
  compare,
  findPairedDrives,
  makeSection,
  nothingDone,
  pair,
  readHoldingArea,
  readExclusions,
  readLastUpdated,
  readPairing,
  sameExclusion,
  update,
  UpdateStoppedError,
  writeExclusions,
  writePairing,
  type FileCopier,
  type ItemCounter,
  type PairedDrives,
  type Pairing,
  type Remounter,
  type Report,
  type UpdateResult,
  type Volume,
  type VolumeIdentity,
} from "../engine/index.ts";
import {
  canOverrideSafetyStop,
  mismatchesChosen,
  NO_FILES,
  reviewSteps,
  totalsOf,
  totalsOfFiles,
  totalsOfMoves,
  writesAnything,
  type AnomaliesState,
  type CopiesState,
  type DeletionsState,
  type FlowState,
  type MismatchChoice,
  type MovesState,
  type ReplicaLastUpdated,
  type ResultState,
  type Review,
  type StartState,
  type SummaryState,
} from "./view.ts";
import { writeUpdateLog, type MismatchLeft } from "./update-log.ts";

/** What the flow needs from the Mac it runs on. */
export interface FlowDeps {
  volumes: VolumeIdentity;
  /** Where the Pairing is stored. */
  pairingFile: string;
  /** Where the Exclusions are stored, beside the Pairing. */
  exclusionsFile: string;
  /** The folder on the Mac where each Update is logged. */
  updateLogFolder: string;
  /** Copies files to the Replica with all their metadata. */
  copier: FileCopier;
  /** Remounts the Primary read-only for each Update, and normally afterwards. */
  remounter: Remounter;
  /** Reads each drive's item count from macOS, for the Comparing progress bar. */
  itemCounter: ItemCounter;
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
  /** The Update being applied, until it has ended and the Primary is remounted normally. */
  #applying: Promise<void> | undefined;
  /** Set once the app is quitting: no new copy starts, so the Update ends soon. */
  #quitting = false;
  /** The owner's Exclusions, as saved. */
  #exclusions: string[] = [];
  /** The folder the next run is limited to, if any. In memory only. */
  #only: string | undefined;
  /** Whether the next comparison is a Deep verify. In memory only. */
  #deep = false;
  /** Why the saved Exclusions cannot be used, if they are damaged. Nothing is compared, or saved over them, until they are fixed. */
  #exclusionsDamaged: string | undefined;
  /** When the paired Replica was last updated, as last read for Start. */
  #lastUpdated: ReplicaLastUpdated | undefined;

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

  /** Start for `pairing`, with the Exclusions as saved. */
  #start(pairing: Pairing, extra: Pick<StartState, "error" | "notice" | "exclusionProblem"> = {}): StartState {
    return {
      step: "start",
      pairing,
      exclusions: this.#exclusions,
      ...(this.#only === undefined ? {} : { only: this.#only }),
      deep: this.#deep,
      ...(this.#lastUpdated === undefined ? {} : { lastUpdated: this.#lastUpdated }),
      ...(this.#exclusionsDamaged === undefined ? {} : { exclusionProblem: this.#exclusionsDamaged }),
      ...extra,
    };
  }

  /** Opens the app: on Pairing when no Pairing is saved, otherwise on Start. */
  async open(): Promise<void> {
    try {
      this.#exclusions = await readExclusions(this.#deps.exclusionsFile);
    } catch (error) {
      this.#exclusionsDamaged = (error as Error).message;
    }
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
    if (pairing === undefined) {
      this.#set({ step: "pairing" });
      return;
    }
    this.#set(this.#start(pairing));
    await this.#readLastUpdated(pairing);
  }

  /**
   * Reads when the paired Replica was last updated from its last-updated marker, and shows it if the
   * app is still on Start for `pairing`. Reads only.
   */
  async #readLastUpdated(pairing: Pairing): Promise<void> {
    const lastUpdated = await this.#lastUpdatedOf(pairing);
    const state = this.#state;
    if (state.step !== "start" || state.pairing !== pairing) return;
    this.#lastUpdated = lastUpdated;
    this.#set({ ...state, lastUpdated });
  }

  /** When the Replica of `pairing` was last updated, or why that cannot be known. */
  async #lastUpdatedOf(pairing: Pairing): Promise<ReplicaLastUpdated> {
    try {
      const replicas = (await this.#deps.volumes.connected()).filter((volume) => volume.id === pairing.replica.id);
      // Two drives with its volume ID: either could be the wrong one, as when comparing.
      if (replicas.length !== 1) return { known: false, reason: "Connect the Replica to see when it was last updated." };
      return { known: true, folders: [], ...(await readLastUpdated(replicas[0]!.mountPoint)) };
    } catch (error) {
      return { known: false, reason: (error as Error).message };
    }
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
    this.#set(this.#start(state.replacing.pairing));
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
      this.#lastUpdated = undefined;
      this.#set(this.#start(pairing));
      await this.#readLastUpdated(pairing);
    } catch (error) {
      this.#set({ ...state, error: (error as Error).message });
    }
  }

  /**
   * On Start: adds the pattern the owner typed to the Exclusions and saves them. A pattern that
   * cannot be used, or is already listed, is not added, and Start says why.
   */
  async addExclusion(typed: string): Promise<void> {
    const state = this.#state;
    if (state.step !== "start" || this.#exclusionsDamaged !== undefined) return;
    let pattern: string;
    try {
      pattern = checkExclusion(typed);
    } catch (error) {
      this.#set(this.#start(state.pairing, { exclusionProblem: (error as Error).message }));
      return;
    }
    const listed = this.#exclusions.find((saved) => sameExclusion(saved, pattern));
    if (listed !== undefined) {
      this.#set(this.#start(state.pairing, { exclusionProblem: `"${listed}" is already in the Exclusions.` }));
      return;
    }
    await this.#saveExclusions(state.pairing, [...this.#exclusions, pattern]);
  }

  /** On Start: removes `pattern` from the Exclusions and saves them. */
  async removeExclusion(pattern: string): Promise<void> {
    const state = this.#state;
    if (state.step !== "start" || this.#exclusionsDamaged !== undefined || !this.#exclusions.includes(pattern)) return;
    await this.#saveExclusions(state.pairing, this.#exclusions.filter((saved) => saved !== pattern));
  }

  /** Saves `exclusions` and shows them on Start. If they cannot be saved, the saved ones stay in use, and Start says why. */
  async #saveExclusions(pairing: Pairing, exclusions: string[]): Promise<void> {
    try {
      await writeExclusions(this.#deps.exclusionsFile, exclusions);
      this.#exclusions = exclusions;
      if (this.#state.step === "start") this.#set(this.#start(pairing));
    } catch (error) {
      if (this.#state.step === "start") {
        this.#set(this.#start(pairing, { exclusionProblem: `The Exclusions could not be saved: ${(error as Error).message}` }));
      }
    }
  }

  /**
   * On Start: where the folder chooser for `limitTo` opens: the top of the Primary, or `undefined`
   * when it is not connected.
   */
  async primaryTop(): Promise<string | undefined> {
    if (this.#state.step !== "start") return undefined;
    return findPairedDrives(this.#state.pairing, this.#deps.volumes).then(
      (drives) => drives.primary.mountPoint,
      () => undefined,
    );
  }

  /**
   * On Start: limits the next comparison and Update to `folder`, a full path the owner chose on the
   * Primary. The top of the Primary means the whole drive. A folder elsewhere is refused, and Start
   * says why. Whether it is a folder that can be compared is checked when comparing.
   */
  async limitTo(folder: string): Promise<void> {
    const state = this.#state;
    if (state.step !== "start") return;
    const { pairing } = state;
    let top: string;
    try {
      top = (await findPairedDrives(pairing, this.#deps.volumes)).primary.mountPoint;
    } catch (error) {
      if (this.#state === state) this.#set(this.#start(pairing, { error: (error as Error).message }));
      return;
    }
    if (this.#state !== state) return;
    const route = relative(top, folder);
    if (isAbsolute(route) || route === ".." || route.startsWith("../")) {
      this.#set(this.#start(pairing, { error: `"${folder}" is not on the Primary. Choose a folder on the Primary.` }));
      return;
    }
    this.#only = route === "" ? undefined : route.split(sep).join("/");
    this.#set(this.#start(pairing));
  }

  /** On Start: compares the whole drive again, rather than one folder. */
  wholeDrive(): void {
    const state = this.#state;
    if (state.step !== "start") return;
    this.#only = undefined;
    this.#set(this.#start(state.pairing));
  }

  /** On Start: chooses a Deep verify (`on`) or a Quick compare for the next comparison, and keeps that choice until changed. */
  deepVerify(on: boolean): void {
    const state = this.#state;
    if (state.step !== "start") return;
    this.#deep = on;
    this.#set(this.#start(state.pairing));
  }

  /** On Start: finds the paired drives and compares them, leaving out the Exclusions, then moves on to Copies. */
  async compare(): Promise<void> {
    const state = this.#state;
    if (state.step !== "start") return;
    const { pairing } = state;
    if (this.#exclusionsDamaged !== undefined) {
      // Comparing without the owner's Exclusions would offer to delete or copy what they left out.
      this.#set(this.#start(pairing, { error: this.#exclusionsDamaged }));
      return;
    }
    const exclusions = this.#exclusions;
    const only = this.#only;
    const deep = this.#deep;
    this.#discardComparison();
    const comparison = this.#comparisonGeneration;
    this.#set({ step: "comparing", pairing, deep });
    try {
      const drives = await findPairedDrives(pairing, this.#deps.volumes);
      const report = await compare(drives.primary.mountPoint, drives.replica.mountPoint, {
        exclusions,
        ...(only === undefined ? {} : { only }),
        deep,
        itemCounter: this.#deps.itemCounter,
        onProgress: (progress) => {
          // Only while still on Comparing for this comparison: a discarded one must not bring it back.
          const now = this.#state;
          if (comparison === this.#comparisonGeneration && now.step === "comparing") this.#set({ ...now, progress });
        },
      });
      if (comparison !== this.#comparisonGeneration) return;
      const { new: newFiles, changed, anomalies, moves, deleted, unreadable } = report;
      // Anything unreadable is shown in the review, even with nothing else to do: it was not compared.
      if (newFiles.count + changed.count + anomalies.contentMismatch.count + moves.count + deleted.count + unreadable.length === 0) {
        const what = only === undefined ? "The Replica" : `The folder "${only}" on the Replica`;
        this.#set(this.#start(pairing, { notice: `${what} matches the Primary. Nothing to update.` }));
        return;
      }
      // Both stops are checked before any Approval, so a refused Update asks nothing (ADR 0008).
      const space = newFiles.count + changed.count > 0 ? await checkFreeSpace([...newFiles.files, ...changed.files], drives.replica.mountPoint) : undefined;
      // Read now, for the warning before the deletions Approval: approving them deletes these for good.
      // Also named when the Replica lacks room, as the space that deleting it would free.
      const noRoom = space?.enough === false;
      const held = deleted.count > 0 || noRoom ? totalsOf(await readHoldingArea(drives.replica.mountPoint)) : NO_FILES;
      if (comparison !== this.#comparisonGeneration) return;
      this.#report = report;
      const review: Review = {
        pairing,
        drives,
        exclusions,
        ...(only === undefined ? {} : { only }),
        deep,
        new: newFiles,
        changed,
        anomalies,
        mismatchChoices: {},
        moves,
        deleted,
        unreadable,
        holdingArea: held,
        copiesApproved: false,
        movesApproved: false,
        deletionsApproved: false,
        safetyStopOverridden: false,
      };
      if (report.safetyStop || noRoom) {
        this.#set({
          step: "refused",
          review,
          ...(report.safetyStop ? { safetyStop: { deleted: totalsOf(deleted), replica: report.replica, ...(only === undefined ? {} : { only }) } } : {}),
          ...(noRoom ? { freeSpace: { needed: space.needed, free: space.free, holdingArea: held } } : {}),
        });
        return;
      }
      this.#set({ step: "copies", review });
    } catch (error) {
      if (comparison !== this.#comparisonGeneration) return;
      this.#set(this.#start(pairing, { error: (error as Error).message }));
    }
  }

  /**
   * On the refusal screen: overrides the Safety stop for this comparison only, when `typed` is
   * exactly the number of deletions, and goes on to the usual Approvals (ADR 0009). Anything else
   * leaves the refusal standing. Never overrides the free-space check.
   */
  overrideSafetyStop(typed: string): void {
    const state = this.#state;
    if (state.step !== "refused" || !canOverrideSafetyStop(state)) return;
    if (!isNumberOfDeletions(typed, state.safetyStop.deleted.count)) {
      this.#set({
        ...state,
        safetyStop: { ...state.safetyStop, error: "That is not the number of deletions. Nothing is overridden." },
      });
      return;
    }
    this.#set({ step: "copies", review: { ...state.review, safetyStopOverridden: true } });
  }

  /** On Copies: gives or withdraws the one all-or-nothing Approval for the copies. */
  approveCopies(approved: boolean): void {
    const state = this.#state;
    if (state.step !== "copies") return;
    this.#set({ step: "copies", review: { ...state.review, copiesApproved: approved } });
  }

  /**
   * On Anomalies: the owner's choice for the content mismatch at `path`: keep the Replica's copy, or
   * overwrite it with the Primary's. Not an Approval. A path that is not a content mismatch is ignored.
   */
  chooseForMismatch(path: string, choice: MismatchChoice): void {
    const state = this.#state;
    if (state.step !== "anomalies" || (choice !== "keep" && choice !== "overwrite")) return;
    if (!state.review.anomalies.contentMismatch.files.some((file) => file.path === path)) return;
    const mismatchChoices = { ...state.review.mismatchChoices, [path]: choice };
    this.#set({ step: "anomalies", review: { ...state.review, mismatchChoices } });
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
   * Moves on to the next review step, keeping the decisions made. Anomalies is skipped when there are
   * no content mismatches, Moves and Deletions when there is nothing to move or delete.
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
  async restart(): Promise<void> {
    const state = this.#state;
    let pairing: Pairing;
    if (isReviewing(state) || state.step === "refused") {
      this.#discardComparison();
      pairing = state.review.pairing;
    } else if (state.step === "result") {
      pairing = state.pairing;
    } else {
      return;
    }
    this.#set(this.#start(pairing));
    // Read again: an Update has just changed it, and Start shows it before the next comparison.
    await this.#readLastUpdated(pairing);
  }

  /**
   * Call when drives are connected or disconnected. On Start, reads again when the Replica was last
   * updated. While a comparison is running or under review, discards it and its decisions, back on
   * Start, if a paired drive has gone.
   */
  async drivesChanged(): Promise<void> {
    const state = this.#state;
    let pairing: Pairing;
    let drives: PairedDrives | undefined;
    if (state.step === "start") return this.#readLastUpdated(state.pairing);
    if (state.step === "comparing") pairing = state.pairing;
    else if (isReviewing(state) || state.step === "refused") ({ pairing, drives } = state.review);
    else return;
    const comparison = this.#comparisonGeneration;
    const gone = await this.#whyDrivesGone(pairing, drives);
    if (gone === undefined || comparison !== this.#comparisonGeneration) return;
    this.#discardForGoneDrives(pairing, gone);
  }

  /** Discards the comparison and its decisions because of `gone`, back on Start. */
  #discardForGoneDrives(pairing: Pairing, gone: string): void {
    this.#discardComparison();
    this.#set(
      this.#start(pairing, {
        error: `${gone} The comparison and its decisions were discarded. Compare again once both drives are connected.`,
      }),
    );
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
   * moved into it (ADR 0006). The Safety stop is overridden only when the owner typed the number
   * of deletions on the refusal screen for this comparison (ADR 0009); `update()` checks both stops
   * again before it writes.
   */
  async apply(): Promise<void> {
    if (this.#applying !== undefined) return;
    this.#applying = this.#apply();
    try {
      await this.#applying;
    } finally {
      this.#applying = undefined;
    }
  }

  async #apply(): Promise<void> {
    const state = this.#state;
    const report = this.#report;
    if (state.step !== "summary" || report === undefined) return;
    const { review, apply } = state;
    if (!writesAnything(apply)) return;
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
        this.#set(
          this.#start(review.pairing, {
            error:
              "The Holding area on the Replica changed since the comparison, so approving the deletions would delete files you were not shown. " +
              "Nothing was written. The comparison and its decisions were discarded. Compare again.",
          }),
        );
        return;
      }
    }
    this.#discardComparison();
    const updating = {
      step: "updating",
      copying: apply.copy,
      overwriting: apply.overwrite,
      renaming: apply.renameOnReplica,
      moving: apply.moveToHoldingArea,
    } as const;
    const overwrite = overwriteChosen(review);
    const chosenToOverwrite = new Set(overwrite);
    // Read-only first, so that even a bug cannot write to the Primary: macOS itself refuses.
    this.#set({ ...updating, primary: "remounting read-only" });
    let primary: Volume;
    try {
      primary = await this.#deps.remounter.readOnly(review.drives.primary);
    } catch (error) {
      this.#set(
        this.#start(review.pairing, {
          error:
            `The Update did not start, and nothing was written: the Primary could not be remounted read-only first. ${(error as Error).message} ` +
            "Close any app using the Primary, then compare again. The comparison and its decisions were discarded.",
        }),
      );
      return;
    }
    this.#set({ ...updating, primary: "read-only" });
    let done: UpdateResult;
    let error: string | undefined;
    try {
      done = await update(approvedPart(report, review), {
          update: true,
          moves: review.movesApproved,
          deletions: review.deletionsApproved,
          overwrite,
          overrideSafetyStop: review.safetyStopOverridden,
        }, {
        primary: primary.mountPoint,
        replica: review.drives.replica.mountPoint,
        copier: this.#copier,
        exclusions: review.exclusions,
        ...(review.only === undefined ? {} : { only: review.only }),
        // The Update reports only while it runs, which is all while the Primary is read-only (ADR 0013).
        onProgress: (progress) => {
          if (this.#state.step === "updating") this.#set({ ...updating, primary: "read-only", progress });
        },
      });
    } catch (stopped) {
      // Stopped partway: still say exactly what it did first.
      done = stopped instanceof UpdateStoppedError ? stopped.result : nothingDone();
      error = (stopped as Error).message;
    }
    this.#set({ ...updating, primary: "remounting normally" });
    const primaryStillReadOnly = await this.#remountNormally(primary);
    const handled = totalsOf(totalsOfFiles(done.moved), totalsOfFiles(done.notMoved));
    const leftOnReplica = { count: review.deleted.count - handled.count, totalSize: review.deleted.totalSize - handled.totalSize };
    const renamedOrNot = totalsOf(totalsOfMoves(done.renamed), totalsOfMoves(done.notRenamed));
    const movesLeftAtOldPaths = { count: review.moves.count - renamedOrNot.count, totalSize: review.moves.totalSize - renamedOrNot.totalSize };
    const overwritten = done.copied.filter((file) => chosenToOverwrite.has(file.path));
    let updateLog: Pick<ResultState, "updateLog" | "updateLogProblem">;
    try {
      const mismatchesLeft: MismatchLeft[] = [
        ...mismatchesChosen(review, "keep").map(({ path, size }) => ({ path, size, why: "kept, as chosen" as const })),
        ...mismatchesChosen(review, undefined).map(({ path, size }) => ({ path, size, why: "no choice was made" as const })),
      ].sort((a, b) => (a.path < b.path ? -1 : 1));
      const path = await writeUpdateLog(this.#deps.updateLogFolder, {
        ended: new Date(),
        pairing: review.pairing,
        ...(review.only === undefined ? {} : { only: review.only }),
        deep: review.deep,
        copied: done.copied.filter((file) => !chosenToOverwrite.has(file.path)),
        overwritten,
        failed: done.failed,
        mismatchesLeft,
        renamed: done.renamed,
        notRenamed: done.notRenamed,
        movesLeftAtOldPaths,
        // As read at compare time, and checked again just before the Update (ADR 0006).
        deletedFromHoldingArea: done.emptiedHoldingArea ? review.holdingArea : NO_FILES,
        moved: done.moved,
        notMoved: done.notMoved,
        leftOnReplica,
        unreadable: review.unreadable,
        ...(error === undefined ? {} : { error }),
        ...(primaryStillReadOnly === undefined ? {} : { primaryStillReadOnly }),
      });
      updateLog = { updateLog: path };
    } catch (problem) {
      updateLog = { updateLogProblem: (problem as Error).message };
    }
    // Read again: it may hold files from an earlier Update as well as this one's (ADR 0006).
    const holdingArea = await readHoldingArea(review.drives.replica.mountPoint).then(
      (held) => ({ holdingArea: held }),
      (problem: Error) => ({ holdingAreaProblem: problem.message }),
    );
    this.#set({
      step: "result",
      pairing: review.pairing,
      ...(review.only === undefined ? {} : { only: review.only }),
      unreadable: review.unreadable,
      copied: done.copied,
      overwritten,
      failed: done.failed,
      renamed: done.renamed,
      notRenamed: done.notRenamed,
      movesLeftAtOldPaths,
      moved: done.moved,
      notMoved: done.notMoved,
      leftOnReplica,
      ...holdingArea,
      ...updateLog,
      ...(error === undefined ? {} : { error }),
      ...(primaryStillReadOnly === undefined ? {} : { primaryStillReadOnly }),
    });
  }

  /**
   * Call before the app quits. If an Update is running, starts no further copy, and resolves once
   * the Update has stopped and the Primary is remounted normally, so that quitting partway does not
   * leave it read-only. The copy under way is allowed to finish.
   */
  async quit(): Promise<void> {
    this.#quitting = true;
    await this.#applying;
  }

  /** The copier for an Update: no new copy starts once the app is quitting. */
  readonly #copier: FileCopier = {
    copy: (source, destination) =>
      this.#quitting ? Promise.reject(new Error("The app is quitting.")) : this.#deps.copier.copy(source, destination),
  };

  /** Remounts the Primary normally after an Update. Resolves with why it could not, if it could not. */
  async #remountNormally(primary: Volume): Promise<string | undefined> {
    try {
      await this.#deps.remounter.normally(primary);
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
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

/**
 * Whether the owner typed exactly `count`: digits only, with or without thousands separators
 * ("1234" or "1,234"), and spaces around them.
 */
function isNumberOfDeletions(typed: string, count: number): boolean {
  const text = typed.trim();
  return text === String(count) || text === count.toLocaleString("en-US");
}

/** Whether the app is on one of the review steps, where the owner makes the decisions. */
function isReviewing(state: FlowState): state is CopiesState | AnomaliesState | MovesState | DeletionsState | SummaryState {
  return state.step === "copies" || state.step === "anomalies" || state.step === "moves" || state.step === "deletions" || state.step === "summary";
}

/** The paths of the content mismatches the owner chose to overwrite with the Primary's copy. */
function overwriteChosen(review: Review): string[] {
  return mismatchesChosen(review, "overwrite").map((file) => file.path);
}

/** The Summary for the decisions in `review`. */
function summaryOf(review: Review): SummaryState {
  const copy = review.copiesApproved ? totalsOf(review.new, review.changed) : NO_FILES;
  const chosen = (choice: MismatchChoice | undefined) => totalsOfFiles(mismatchesChosen(review, choice));
  const anomalies = { overwrite: chosen("overwrite"), keep: chosen("keep"), leaveUndecided: chosen(undefined) };
  const moves = totalsOf(review.moves);
  const renames = review.movesApproved
    ? { renameOnReplica: moves, leaveAtOldPaths: NO_FILES }
    : { renameOnReplica: NO_FILES, leaveAtOldPaths: moves };
  const deleted = totalsOf(review.deleted);
  const apply = review.deletionsApproved
    ? { copy, ...anomalies, ...renames, moveToHoldingArea: deleted, deleteFromHoldingArea: review.holdingArea, leaveOnReplica: NO_FILES }
    : { copy, ...anomalies, ...renames, moveToHoldingArea: NO_FILES, deleteFromHoldingArea: NO_FILES, leaveOnReplica: deleted };
  return { step: "summary", review, apply };
}
