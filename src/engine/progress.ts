/**
 * How far a comparison or an Update has got, as the engine reports it while it runs. Plain data
 * that imports nothing from Node, so the screens can use it too. Reporting progress never changes
 * what a comparison or an Update does.
 */

/** How far a comparison has got. */
export type CompareProgress = ScanningProgress | CheckingMovesProgress;

/** Reading both drives' folders. */
export interface ScanningProgress {
  phase: "scanning";
  /** Items (files plus folders) listed so far on both drives together. */
  scanned: number;
  /**
   * Both drives' item counts together, as macOS gave them before scanning. Absent when either drive
   * has no usable count. Only an estimate: macOS counts items a comparison skips or leaves out, so
   * `scanned` can stop short of it, or pass it.
   */
  total?: number;
}

/** Reading move candidates on both drives in full, to confirm them by checksum (ADR 0011). Comes after scanning, and only when there are candidates. */
export interface CheckingMovesProgress {
  phase: "checking moves";
  /** Bytes read so far, on both drives together. */
  checkedBytes: number;
  /** Bytes to read: each candidate's size, once on each drive. */
  totalBytes: number;
}

/** How far an Update has got, in the order it does things: deletions, moves, then copies. */
export interface UpdateProgress {
  /** Deleted files dealt with (moved into the Holding area or left where they were), out of those approved. */
  deletions: { done: number; total: number };
  /** Moves dealt with (renamed or left at their old paths), out of those approved. */
  moves: { done: number; total: number };
  /** Bytes of the new and changed files, out of the approved total. */
  copies: {
    /** Bytes of the files copied and confirmed so far. */
    copiedBytes: number;
    /** Bytes of the files that could not be copied so far. */
    notCopiedBytes: number;
    totalBytes: number;
  };
}

/**
 * `listener`, made safe to call from the middle of a comparison or an Update: whatever it throws is
 * ignored, so reporting progress can never stop either one or change what it reports.
 */
export function reporter<P>(listener: ((progress: P) => void) | undefined): (progress: P) => void {
  return (progress) => {
    try {
      listener?.(progress);
    } catch {
      // Progress is for the screens only.
    }
  };
}
