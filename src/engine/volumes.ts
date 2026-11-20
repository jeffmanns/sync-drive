/** A connected drive, as the volume-identity component sees it. */
export interface Volume {
  /** The volume's unique ID (its volume UUID on macOS). Survives renaming the drive. */
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
