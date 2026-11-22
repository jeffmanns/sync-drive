import { rename } from "node:fs/promises";
import type { Remounter, Volume } from "../../src/engine/index.ts";

/**
 * Stands in for macOS's remounting in tests. Keeps a log of what it was asked to do, says whether
 * the Primary is read-only now, and can be told to fail either way.
 */
export class FakeRemounter implements Remounter {
  /** Each remount asked for, in order, e.g. `read-only /tmp/x` or `normally /tmp/x`. */
  readonly log: string[] = [];
  /** Mount points currently mounted read-only. */
  readonly #readOnly = new Set<string>();
  /** When set, `readOnly()` rejects with this, leaving the drive mounted normally. */
  failReadOnly: Error | undefined;
  /** When set, `normally()` rejects with this, leaving the drive read-only. */
  failNormally: Error | undefined;
  /**
   * When set, `readOnly()` mounts the drive here instead, as macOS does when its mount point is
   * taken, and `normally()` puts it back where it was.
   */
  remountAt: string | undefined;
  /** Where each drive moved by `remountAt` was mounted before. */
  readonly #originalMountPoint = new Map<string, string>();

  isReadOnly(mountPoint: string): boolean {
    return this.#readOnly.has(mountPoint);
  }

  async readOnly(volume: Volume): Promise<Volume> {
    this.log.push(`read-only ${volume.mountPoint}`);
    if (this.failReadOnly !== undefined) throw this.failReadOnly;
    let { mountPoint } = volume;
    if (this.remountAt !== undefined) {
      await rename(mountPoint, this.remountAt);
      this.#originalMountPoint.set(this.remountAt, mountPoint);
      mountPoint = this.remountAt;
    }
    this.#readOnly.add(mountPoint);
    return { ...volume, mountPoint };
  }

  async normally(volume: Volume): Promise<Volume> {
    this.log.push(`normally ${volume.mountPoint}`);
    if (this.failNormally !== undefined) throw this.failNormally;
    this.#readOnly.delete(volume.mountPoint);
    const original = this.#originalMountPoint.get(volume.mountPoint);
    if (original === undefined) return volume;
    await rename(volume.mountPoint, original);
    this.#originalMountPoint.delete(volume.mountPoint);
    return { ...volume, mountPoint: original };
  }
}
