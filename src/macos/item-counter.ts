import { statfs } from "node:fs/promises";
import type { ItemCounter } from "../engine/index.ts";

/**
 * Reads a drive's item count from macOS: the file system's inodes in use, which on APFS and Mac OS
 * Extended are its files plus folders. Instant, as it reads no folders. Reads only; changes nothing.
 */
export class MacItemCounter implements ItemCounter {
  async itemCount(mountPoint: string): Promise<number | undefined> {
    try {
      const { files, ffree } = await statfs(mountPoint);
      // FAT and exFAT keep no count: macOS gives no free inodes (and 0 or 1 in all), not a real figure.
      if (ffree <= 0 || files < ffree) return undefined;
      return files - ffree;
    } catch {
      return undefined;
    }
  }
}
