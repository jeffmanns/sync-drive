import type { MovesSection, Report, Section, Unreadable } from "../engine/index.ts";
import { fileCount, formatSize } from "../format.ts";

export interface RenderOptions {
  /** Show every file under its folder, not just the folder totals. */
  list: boolean;
}

/** Renders a Report as plain text: each section grouped by folder, with counts and sizes. */
export function renderReport(report: Report, options: RenderOptions): string {
  return [
    renderSection("New", report.new, options),
    renderSection("Changed", report.changed, options),
    renderMoves(report.moves, options),
    renderSection("Deleted", report.deleted, options),
    ...(report.unreadable.length > 0 ? [renderUnreadable(report.unreadable)] : []),
    renderSafetyStop(report),
  ].join("\n\n");
}

/** The errors: everything that could not be read on the Primary, always in full, and why. */
function renderUnreadable(unreadable: Unreadable[]): string {
  return [
    `Could not be read on the Primary: ${unreadable.length} (skipped; what the Replica holds there is left as it is)`,
    ...unreadable.map((item) => `  ${item.folder ? `${item.path}/` : item.path}  ${item.reason}`),
  ].join("\n");
}

/** Whether the Safety stop applies, with the deleted files' share of the Replica by count and by size. */
function renderSafetyStop({ deleted, replica, safetyStop }: Report): string {
  const verdict = `Safety stop: ${safetyStop ? "applies" : "does not apply"}.`;
  if (deleted.count === 0) return `${verdict} Nothing would go into the Holding area.`;
  return (
    `${verdict} The deleted files are ${deleted.count.toLocaleString("en-US")} of the Replica's ` +
    `${fileCount(replica.count)} (${percent(deleted.count, replica.count)}) and ` +
    `${formatSize(deleted.totalSize)} of its ${formatSize(replica.totalSize)} (${percent(deleted.totalSize, replica.totalSize)}).`
  );
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(1)}%`;
}

/** The moves, grouped by the folder moved; with `list`, each file's old and new path. */
function renderMoves(moves: MovesSection, { list }: RenderOptions): string {
  if (moves.count === 0) return "Moved: none";
  const folder = (path: string) => (path === "" ? "(top level)" : `${path}/`);
  const rows = moves.folders.map((group) => ({
    label: `${folder(group.from)} → ${folder(group.to)}`,
    count: fileCount(group.count),
    size: formatSize(group.totalSize),
    moves: group.moves,
  }));
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const countWidth = Math.max(...rows.map((row) => row.count.length));
  const lines = [`Moved: ${fileCount(moves.count)}, ${formatSize(moves.totalSize)}`];
  for (const row of rows) {
    lines.push(`  ${row.label.padEnd(labelWidth)}  ${row.count.padEnd(countWidth)}  ${row.size}`);
    if (list) for (const move of row.moves) lines.push(`    ${move.from} → ${move.to}  ${formatSize(move.size)}`);
  }
  return lines.join("\n");
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
