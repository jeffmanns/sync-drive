/**
 * How far apart two modification dates may be and still count as the same: under a hundredth of
 * a second. Absorbs tiny date differences a copy can introduce, without missing real edits (ADR 0002).
 */
const SAME_DATE_TOLERANCE_NS = 10_000_000n;

/** Whether two modification dates, in nanoseconds, count as the same: less than `SAME_DATE_TOLERANCE_NS` apart. */
export function sameDate(a: bigint, b: bigint): boolean {
  return (a > b ? a - b : b - a) < SAME_DATE_TOLERANCE_NS;
}
