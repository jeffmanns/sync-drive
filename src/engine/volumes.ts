/** A connected drive, as the volume-identity component sees it. */
export interface Volume {
  /** The drive's volume ID (macOS's Volume UUID). Survives renaming the drive. */
  id: string;
  /** The drive's current name, for messages only. Never used to recognise a drive. */
  name: string;
  /** Where the drive's top level is mounted. */
  mountPoint: string;
}

/**
 * Tells the engine which drive is which. The engine asks this for volume IDs and never calls
 * macOS directly; tests substitute a fake.
 */
export interface VolumeIdentity {
  /** The drive whose top level is `path`. Rejects if `path` is not the top level of a drive. */
  volumeAt(path: string): Promise<Volume>;
  /** Every drive currently connected. */
  connected(): Promise<Volume[]>;
}

/**
 * Reads how many items (files plus folders) a drive holds, as macOS counts them, without reading
 * its folders: for the comparison's progress bar only, never to decide anything. Tests substitute
 * a fake.
 */
export interface ItemCounter {
  /**
   * How many items the drive whose top level is `mountPoint` holds, or `undefined` when its file
   * system gives no usable count, as when the count cannot be read. Should not reject; the
   * comparison treats a rejection as no usable count all the same.
   */
  itemCount(mountPoint: string): Promise<number | undefined>;
}

/**
 * Remounts the Primary read-only for an Update, so that macOS itself, and not only sync-drive's
 * code, keeps it from being written to; and remounts it normally afterwards. Tests substitute a fake.
 */
export interface Remounter {
  /**
   * Remounts `volume` read-only, and confirms with macOS that it is. Resolves with the volume as it
   * is now mounted, whose mount point may have changed. Rejects if it cannot do either, having put
   * the volume back mounted normally wherever it can.
   */
  readOnly(volume: Volume): Promise<Volume>;
  /** Remounts `volume`, which `readOnly()` made read-only, normally again, and confirms it is. */
  normally(volume: Volume): Promise<Volume>;
}
