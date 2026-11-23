import type { ItemCounter } from "../../src/engine/index.ts";

/**
 * Stands in for macOS's item counts in tests. A drive's count is whatever was set for its top
 * level; a drive with none set has no usable count, as on a FAT or exFAT drive.
 */
export class FakeItemCounter implements ItemCounter {
  readonly #counts = new Map<string, number>();

  /** Gives the drive at `mountPoint` an item count of `count`. */
  set(mountPoint: string, count: number): void {
    this.#counts.set(mountPoint, count);
  }

  async itemCount(mountPoint: string): Promise<number | undefined> {
    return this.#counts.get(mountPoint);
  }
}
