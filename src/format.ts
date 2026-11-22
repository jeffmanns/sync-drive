/** Wording for counts and sizes, shared by every front end. Pure, so the app's screens can use it too. */

/** "1 file", "2 files", "1,234 files". */
export function fileCount(count: number): string {
  return count === 1 ? "1 file" : `${count.toLocaleString("en-US")} files`;
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
