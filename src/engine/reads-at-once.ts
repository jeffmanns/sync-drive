import type { DriveKind } from "./volumes.ts";

/**
 * Files read at once from a solid-state drive: enough to keep it busy, as it reads several places
 * as fast as one. Measured with `scripts/benchmark.ts` (ADR 0022).
 */
export const SOLID_STATE_READS = 8;

/**
 * How many files to read at once from the drive whose top level is `mountPoint`: several from a
 * solid-state drive, one from a spinning drive, so it is not made to seek between them. One, as safe
 * on any drive, when `driveKind` cannot tell or there is none (ADR 0022).
 */
export async function readsAtOnce(driveKind: DriveKind | undefined, mountPoint: string): Promise<number> {
  // Asked inside a promise, so a DriveKind that throws rather than rejects cannot stop a comparison either.
  const solidState = await Promise.resolve()
    .then(() => driveKind?.isSolidState(mountPoint))
    .catch(() => undefined);
  return solidState === true ? SOLID_STATE_READS : 1;
}

/** Runs a task under a `readLimiter`, resolving or rejecting as it does. */
export type ReadLimiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Runs the tasks given to it with no more than `atOnce` running at a time, starting each in the
 * order given, as soon as one before it has finished. One per drive keeps that drive's reads within
 * `readsAtOnce`.
 */
export function readLimiter(atOnce: number): ReadLimiter {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    if (running >= atOnce) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    // A waiting task takes over the slot of the one that finished, so `running` stays as it was.
    try {
      return await task();
    } finally {
      if (waiting.length > 0) waiting.shift()!();
      else running--;
    }
  };
}

/** How many files to read at once from a Primary and a Replica, and the limiter that holds each to it. */
export interface ReadLimits {
  /** Pairs of files in flight (a Primary file with its Replica copy): as many as the faster drive reads at once. */
  pairsAtOnce: number;
  primary: ReadLimiter;
  replica: ReadLimiter;
}

/** The `ReadLimits` for the Primary at `primary` and the Replica at `replica`, as `driveKind` tells their kinds. Never rejects. */
export async function readLimitsFor(driveKind: DriveKind | undefined, primary: string, replica: string): Promise<ReadLimits> {
  const [onPrimary, onReplica] = await Promise.all([readsAtOnce(driveKind, primary), readsAtOnce(driveKind, replica)]);
  return { pairsAtOnce: Math.max(onPrimary, onReplica), primary: readLimiter(onPrimary), replica: readLimiter(onReplica) };
}
