import type { DriveKind } from "../../src/engine/index.ts";

/**
 * Stands in for macOS's word on whether each drive is solid state, in tests. A drive is whatever
 * was set for its top level; a drive with nothing set is spinning, unless `unknown` makes it one
 * that cannot be told.
 */
export class FakeDriveKind implements DriveKind {
  readonly #kinds = new Map<string, boolean | undefined>();

  /** Calls each drive in `solidState` solid state. */
  constructor(...solidState: string[]) {
    for (const mountPoint of solidState) this.#kinds.set(mountPoint, true);
  }

  /** Makes the drive at `mountPoint` solid state (`true`), spinning (`false`), or one that cannot be told (`undefined`). */
  set(mountPoint: string, solidState: boolean | undefined): void {
    this.#kinds.set(mountPoint, solidState);
  }

  async isSolidState(mountPoint: string): Promise<boolean | undefined> {
    return this.#kinds.has(mountPoint) ? this.#kinds.get(mountPoint) : false;
  }
}
