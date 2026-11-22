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
  /**
   * Files moved or renamed on the Primary, confirmed by checksum: an Update with the moves Approval
   * renames them on the Replica. They are in neither \`new\` nor \`deleted\`.
   */
  moves: MovesSection;
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

/** A file moved or renamed on the Primary since the last Update: same contents, new path. */
export interface Move {
  /** Its path on the Replica, relative to the drive root, using `/`. */
  from: string;
  /** Its path on the Primary, where the Update renames it to on the Replica. */
  to: string;
  size: number;
}

/** The moves of one folder to another, e.g. `Photos/Iceland` → `Photos/2026/Iceland`. */
export interface MoveGroup extends Totals {
  /** The folder on the Replica. `""` is the top level of the drive. */
  from: string;
  /** The folder on the Primary. `""` is the top level of the drive. */
  to: string;
  moves: Move[];
}

/** The Report's moves: every Move, and the same Moves grouped by folder. */
export interface MovesSection extends Totals {
  /** Every Move, in order of its path on the Primary. */
  moves: Move[];
  /** The same Moves grouped by the folder moved, in order of the folder on the Replica. */
  folders: MoveGroup[];
}

/** Builds the moves section from its moves, in any order. */
export function makeMovesSection(moves: Move[]): MovesSection {
  const sorted = [...moves].sort((a, b) => byCodeUnit(a.to, b.to));
  const groups = new Map<string, MoveGroup>();
  for (const move of sorted) {
    const { from, to } = movedFolder(move);
    const key = `${from}\0${to}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { from, to, count: 0, totalSize: 0, moves: [] };
      groups.set(key, group);
    }
    group.count += 1;
    group.totalSize += move.size;
    group.moves.push(move);
  }
  return {
    count: sorted.length,
    totalSize: sorted.reduce((total, move) => total + move.size, 0),
    moves: sorted,
    folders: [...groups.values()].sort((a, b) => byCodeUnit(a.from, b.from) || byCodeUnit(a.to, b.to)),
  };
}

/**
 * The folder a move belongs to, on each drive. The folders the file sits in that are the same on both
 * drives are the moved folder's own contents, so all but the outermost of them are dropped:
 * `Photos/Iceland/Day 1/a.jpg` → `Photos/2026/Iceland/Day 1/a.jpg` is the folder `Photos/Iceland`
 * moved to `Photos/2026/Iceland`. A file moved on its own belongs to the folders it sits directly in.
 */
function movedFolder(move: Move): { from: string; to: string } {
  const from = move.from.split("/").slice(0, -1);
  const to = move.to.split("/").slice(0, -1);
  let shared = 0;
  while (shared < from.length && shared < to.length && from[from.length - 1 - shared] === to[to.length - 1 - shared]) {
    shared += 1;
  }
  // Keep the outermost shared folder, the one that moved, and drop the ones inside it.
  const drop = Math.max(shared - 1, 0);
  return { from: from.slice(0, from.length - drop).join("/"), to: to.slice(0, to.length - drop).join("/") };
}

/** Plain code-unit ordering, so the order never depends on the machine's locale. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
