/** A file in a Report section. `path` is relative to the drive root, using `/`. */
export interface FileEntry {
  path: string;
  size: number;
}

/** The files of a section that sit directly in one folder. */
export interface FolderGroup<F extends FileEntry = FileEntry> {
  /** Folder path relative to the drive root, using `/`. `""` is the top level of the drive. */
  folder: string;
  count: number;
  totalSize: number;
  files: F[];
}

/** How many files, and their total size in bytes. */
export interface Totals {
  count: number;
  totalSize: number;
}

/** One kind of difference, e.g. new files. */
export interface Section<F extends FileEntry = FileEntry> extends Totals {
  /** Every file in the section, in path order. */
  files: F[];
  /** The same files grouped by the folder they sit directly in, in folder order. */
  folders: FolderGroup<F>[];
}

/**
 * A file whose size and date match on both drives but whose contents, read in full by a Deep
 * verify, do not. Sizes are the Primary's.
 */
export interface ContentMismatch extends FileEntry {
  /**
   * Set when the Replica's copy could not be read in full, so its contents could not be confirmed:
   * why, e.g. "the drive could not read it (EIO)".
   */
  replicaUnreadable?: string;
}

/**
 * Anomalies: differences that should not occur if the Replica is only ever changed by Updates.
 */
export interface Anomalies {
  /**
   * Changed files whose Replica copy is newer than the Primary's. Each is also in \`changed\`, so the
   * copies Approval replaces it with the Primary's: the Primary still wins. Sizes are the Primary's.
   */
  replicaNewer: Section;
  /**
   * Content mismatches, found only by a Deep verify. They are in no other section: an Update leaves
   * each alone unless the owner chooses, for that file, to overwrite the Replica's copy.
   */
  contentMismatch: Section<ContentMismatch>;
}

/** Something on the Primary that could not be read, so it was left out of the comparison. */
export interface Unreadable {
  /** Path relative to the drive root, using `/`, exactly as stored on the drive. */
  path: string;
  /** Whether it is a folder, whose contents could not be listed. */
  folder: boolean;
  /** Why it could not be read, e.g. "permission denied". */
  reason: string;
}

/** What differs between the Primary and the Replica. */
export interface Report {
  /** Files on the Primary that are not on the Replica. Sizes are the Primary's. */
  new: Section;
  /** Files on both drives that a Quick compare judges different. Sizes are the Primary's. */
  changed: Section;
  /** Anomalies: Replica copies newer than the Primary's, and (with Deep verify) content mismatches. */
  anomalies: Anomalies;
  /**
   * Files moved or renamed on the Primary, confirmed by checksum: an Update with the moves Approval
   * renames them on the Replica. They are in neither \`new\` nor \`deleted\`.
   */
  moves: MovesSection;
  /** Files on the Replica that are no longer on the Primary. Sizes are the Replica's. */
  deleted: Section;
  /**
   * Unreadable: what could not be read on the Primary, in path order. Each is left out of the other
   * sections, and the Replica files at or under its path are never treated as deleted.
   */
  unreadable: Unreadable[];
  /** The Replica's contents for comparison, not counting sync-drive's own folders. */
  replica: Totals;
  /** Whether the Safety stop applies to this report's deleted files (ADR 0008). */
  safetyStop: boolean;
}

/** Builds a section from its files, in any order. */
export function makeSection<F extends FileEntry>(files: F[]): Section<F> {
  const sorted = [...files].sort((a, b) => byCodeUnit(a.path, b.path));
  const groups = new Map<string, FolderGroup<F>>();
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
 * The folder a move belongs to, on each drive: the folder that was moved or renamed. Folders the file
 * sits in that are the same at the end of both paths are the moved folder's own contents. Below what
 * is left of the two paths:
 * - two folders side by side in one parent were renamed: `Photos/Iceland/Day 1/a.jpg` →
 *   `Photos/Islande/Day 1/a.jpg` is `Photos/Iceland` renamed to `Photos/Islande`;
 * - otherwise the outermost shared folder was moved: `Photos/Iceland/Day 1/a.jpg` →
 *   `Photos/2026/Iceland/Day 1/a.jpg` is `Photos/Iceland` moved to `Photos/2026/Iceland`.
 * A file moved on its own belongs to the folders it sits directly in.
 */
function movedFolder(move: Move): { from: string; to: string } {
  const from = move.from.split("/").slice(0, -1);
  const to = move.to.split("/").slice(0, -1);
  let shared = 0;
  while (shared < from.length && shared < to.length && from[from.length - 1 - shared] === to[to.length - 1 - shared]) {
    shared += 1;
  }
  const fromRest = from.slice(0, from.length - shared);
  const toRest = to.slice(0, to.length - shared);
  const renamedInPlace =
    fromRest.length > 0 && fromRest.length === toRest.length && fromRest.slice(0, -1).join("/") === toRest.slice(0, -1).join("/");
  const keep = shared > 0 && !renamedInPlace ? 1 : 0;
  return {
    from: from.slice(0, fromRest.length + keep).join("/"),
    to: to.slice(0, toRest.length + keep).join("/"),
  };
}

/** Plain code-unit ordering, so the order never depends on the machine's locale. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
