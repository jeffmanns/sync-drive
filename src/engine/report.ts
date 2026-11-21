/** A file in a Report section. `path` is relative to the drive root, using `/`. */
export interface FileEntry {
  path: string;
  size: number;
}

/** The files of a section that sit directly in one folder. */
export interface FolderGroup {
  /** Folder path relative to the drive root, using `/`. `""` is the top level of the drive. */
  folder: string;
  count: number;
  totalSize: number;
  files: FileEntry[];
}

/** How many files, and their total size in bytes. */
export interface Totals {
  count: number;
  totalSize: number;
}

/** One kind of difference, e.g. new files. */
export interface Section extends Totals {
  /** Every file in the section, in path order. */
  files: FileEntry[];
  /** The same files grouped by the folder they sit directly in, in folder order. */
  folders: FolderGroup[];
}

/** What differs between the Primary and the Replica. */
export interface Report {
  /** Files on the Primary that are not on the Replica. Sizes are the Primary's. */
  new: Section;
  /** Files on both drives that a Quick compare judges different. Sizes are the Primary's. */
  changed: Section;
  /** Files on the Replica that are no longer on the Primary. Sizes are the Replica's. */
  deleted: Section;
  /** The Replica's contents for comparison, not counting sync-drive's own folders. */
  replica: Totals;
  /** Whether the Safety stop applies to this report's deleted files (ADR 0008). */
  safetyStop: boolean;
}

/** Builds a section from its files, in any order. */
export function makeSection(files: FileEntry[]): Section {
  const sorted = [...files].sort((a, b) => byCodeUnit(a.path, b.path));
  const groups = new Map<string, FolderGroup>();
  for (const file of sorted) {
    const folder = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
    let group = groups.get(folder);
    if (group === undefined) {
      group = { folder, count: 0, totalSize: 0, files: [] };
      groups.set(folder, group);
    }
    group.count += 1;
    group.totalSize += file.size;
    group.files.push(file);
  }
  return {
    count: sorted.length,
    totalSize: sorted.reduce((total, file) => total + file.size, 0),
    files: sorted,
    folders: [...groups.values()].sort((a, b) => byCodeUnit(a.folder, b.folder)),
  };
}

/** Plain code-unit ordering, so the order never depends on the machine's locale. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
