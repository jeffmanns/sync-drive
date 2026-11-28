import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Pairing } from "./pairing.ts";
import type { DriveKind, VolumeIdentity } from "./volumes.ts";

/** Where the Solid-state marks are stored: beside the Pairing stored in `pairingFile` (ADR 0025). */
export function solidStateMarksFileBeside(pairingFile: string): string {
  return join(dirname(pairingFile), "solid-state-marks.json");
}

/**
 * The Volume IDs of the drives the owner marked as solid state, as stored in `file`. None when the
 * file is missing, damaged or cannot be read: a mark only changes how fast a drive is read, so
 * losing it must never stop a comparison (ADR 0025). Never rejects.
 */
export async function readSolidStateMarks(file: string): Promise<string[]> {
  try {
    const data: unknown = JSON.parse(await readFile(file, "utf8"));
    const marks = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as { solidState?: unknown }).solidState : undefined;
    return Array.isArray(marks) && marks.every((id) => typeof id === "string") ? (marks as string[]) : [];
  } catch {
    return [];
  }
}

/** Stores `marks`, the Volume IDs of the drives marked as solid state, in `file`, replacing the earlier ones. A half-written file is never left behind. */
export async function writeSolidStateMarks(file: string, marks: readonly string[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const partial = `${file}.partial`;
  await writeFile(partial, JSON.stringify({ solidState: marks }, null, 2) + "\n");
  await rename(partial, file);
}

/** Whether the drive with a Volume ID is marked as solid state: one of `marks`, and in `pairing`. A mark on any other drive is ignored. */
export function markedIn(pairing: Pairing | undefined, marks: readonly string[]): (id: string) => boolean {
  return (id) => pairing !== undefined && (pairing.primary.id === id || pairing.replica.id === id) && marks.includes(id);
}

/** What a drive's kind is taken to be, and whether that comes from the owner's mark. */
export interface KindOf {
  /** Whether the drive is taken to be solid state, or `undefined` when that cannot be told. */
  solidState: boolean | undefined;
  /** Whether `solidState` comes from the owner's mark, because macOS cannot tell. */
  marked: boolean;
}

/**
 * macOS's word on whether a drive is solid state (`macOS`), with the owner's Solid-state mark filling
 * in only where macOS cannot tell (ADR 0025). A clear answer from macOS is always used, so a drive it
 * reports as spinning is never read several files at a time. Every comparison and Update is given
 * this, so the mark is applied in one place. Only for how many files are read at once, never for
 * what a comparison finds (ADR 0022).
 */
export class MarkedDriveKind implements DriveKind {
  readonly #macOS: DriveKind;
  readonly #volumes: VolumeIdentity;
  readonly #marked: (id: string) => boolean;

  /** `marked` says whether the drive with a Volume ID is marked, asked each time, so a change to the marks counts at once. */
  constructor(macOS: DriveKind, volumes: VolumeIdentity, marked: (id: string) => boolean) {
    this.#macOS = macOS;
    this.#volumes = volumes;
    this.#marked = marked;
  }

  async isSolidState(mountPoint: string): Promise<boolean | undefined> {
    return (await this.kindOf(mountPoint)).solidState;
  }

  /** What the drive whose top level is `mountPoint` is taken to be, and whether from the owner's mark. Never rejects. */
  async kindOf(mountPoint: string): Promise<KindOf> {
    const told = await Promise.resolve()
      .then(() => this.#macOS.isSolidState(mountPoint))
      .catch(() => undefined);
    if (told !== undefined) return { solidState: told, marked: false };
    const marked = await this.#volumes.volumeAt(mountPoint).then(
      (volume) => this.#marked(volume.id),
      () => false,
    );
    return marked ? { solidState: true, marked } : { solidState: undefined, marked };
  }
}
