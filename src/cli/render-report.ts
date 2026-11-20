import type { Report, Section } from "../engine/index.ts";

export interface RenderOptions {
  /** Show every file under its folder, not just the folder totals. */
  list: boolean;
}

/** Renders a Report as plain text: each section grouped by folder, with counts and sizes. */
export function renderReport(report: Report, options: RenderOptions): string {
  return [
    renderSection("New", report.new, options),
    renderSection("Changed", report.changed, options),
    renderSection("Deleted", report.deleted, options),
  ].join("\n\n");
}

function renderSection(title: string, section: Section, { list }: RenderOptions): string {
  if (section.count === 0) return `${title}: none`;
  const rows = section.folders.map((group) => ({
    label: group.folder === "" ? "(top level)" : `${group.folder}/`,
    count: fileCount(group.count),
    size: formatSize(group.totalSize),
    files: group.files,
  }));
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const countWidth = Math.max(...rows.map((row) => row.count.length));
  const lines = [`${title}: ${fileCount(section.count)}, ${formatSize(section.totalSize)}`];
  for (const row of rows) {
    lines.push(`  ${row.label.padEnd(labelWidth)}  ${row.count.padEnd(countWidth)}  ${row.size}`);
    if (list) {
      const names = row.files.map((file) => file.path.slice(file.path.lastIndexOf("/") + 1));
      const nameWidth = Math.max(...names.map((name) => name.length));
      row.files.forEach((file, i) => {
        lines.push(`    ${names[i]!.padEnd(nameWidth)}  ${formatSize(file.size)}`);
      });
    }
  }
  return lines.join("\n");
}

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
