/** Wording for counts and sizes, shared by every front end. Pure, so the app's screens can use it too. */

/** "1 file", "2 files", "1,234 files". */
export function fileCount(count: number): string {
  return count === 1 ? "1 file" : `${count.toLocaleString("en-US")} files`;
}

/** "1 item", "3 items". */
export function itemCount(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "item" : "items"}`;
}

/** "3 files (1.5 MB)". */
export function describeFiles(totals: { count: number; totalSize: number }): string {
  return `${fileCount(totals.count)} (${formatSize(totals.totalSize)})`;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Formats a byte count in decimal units, as Finder does (1 KB = 1000 bytes). */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  // 999.95 rather than 1000, so a value that would round up to "1000.0" moves to the next unit.
  while (value >= 999.95 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** The day of `date` on this Mac, as the owner writes it: "24 November 2026". */
export function formatDay(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** The time of day of `date` on this Mac, to the second, with `separator` between: "10:30:05". */
export function formatTime(date: Date, separator = ":"): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(two).join(separator);
}

/**
 * How long before `now` the day of `then` was, by this Mac's calendar: "today", "yesterday", "23 days
 * ago", then whole months ("1 month ago", up to "23 months ago"), then whole years ("2 years ago").
 * A `then` after `now`, as when the Mac's clock was wrong, is "today".
 */
export function howLongAgo(then: Date, now: Date): string {
  const dayOf = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
  const days = dayOf(now) - dayOf(then);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  const months = (now.getFullYear() - then.getFullYear()) * 12 + now.getMonth() - then.getMonth() - (now.getDate() < then.getDate() ? 1 : 0);
  if (months < 1) return `${days} days ago`;
  if (months < 24) return months === 1 ? "1 month ago" : `${months} months ago`;
  return `${Math.floor(months / 12)} years ago`;
}
