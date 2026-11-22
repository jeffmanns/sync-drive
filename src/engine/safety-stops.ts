import { statfs } from "node:fs/promises";
import type { Report, Totals } from "./report.ts";

import { SAFETY_STOP_MIN_FILES, SAFETY_STOP_PERCENT } from "./safety-stop-limits.ts";

export { SAFETY_STOP_MIN_FILES, SAFETY_STOP_PERCENT };

/**
 * Whether the Safety stop applies: the `deleted` files are more than `SAFETY_STOP_PERCENT` of the
 * `replica`'s contents for comparison, by count or by size, and more than `SAFETY_STOP_MIN_FILES`.
 */
export function safetyStopApplies(deleted: Totals, replica: Totals): boolean {
  if (deleted.count <= SAFETY_STOP_MIN_FILES) return false;
  return (
    deleted.count * 100 > replica.count * SAFETY_STOP_PERCENT ||
    deleted.totalSize * 100 > replica.totalSize * SAFETY_STOP_PERCENT
  );
}

/** Whether the Replica has room for an Update's copies. */
export interface FreeSpace {
  /** Bytes the new and changed files take up on the Replica, each rounded up to its block size. */
  needed: number;
  /** Bytes free on the Replica. */
  free: number;
  enough: boolean;
}

/**
 * Checks whether `replica` has room for every new and changed file in `report`. Cautious: space
 * the Update would free (replaced versions, an emptied Holding area) is not counted (ADR 0008).
 * Reads only.
 */
export async function checkFreeSpace(report: Report, replica: string): Promise<FreeSpace> {
  const { bsize, bavail } = await statfs(replica);
  let needed = 0;
  for (const file of [...report.new.files, ...report.changed.files]) {
    needed += Math.ceil(file.size / bsize) * bsize;
  }
  const free = bavail * bsize;
  return { needed, free, enough: needed <= free };
}
