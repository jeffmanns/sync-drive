import { HOLDING_AREA } from "./holding-area.ts";
import { INCOMING_FOLDER } from "./incoming.ts";

const SYNC_DRIVE_FOLDERS = new Set([INCOMING_FOLDER, HOLDING_AREA].map((name) => name.toLowerCase()));

/**
 * Whether `path` (relative to the drive root, using `/`) is one of the folders sync-drive keeps at
 * the top level of the Replica: the Incoming folder or the Holding area. Letter case is ignored, as
 * the drives ignore it (ADR 0002).
 */
export function isSyncDriveFolder(path: string): boolean {
  return SYNC_DRIVE_FOLDERS.has(path.toLowerCase());
}
