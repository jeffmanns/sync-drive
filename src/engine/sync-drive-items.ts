import { HOLDING_AREA } from "./holding-area.ts";
import { INCOMING_FOLDER } from "./incoming.ts";
import { LAST_UPDATED_MARKER } from "./last-updated.ts";

const SYNC_DRIVE_ITEMS = new Set([INCOMING_FOLDER, HOLDING_AREA, LAST_UPDATED_MARKER].map((name) => name.toLowerCase()));

/**
 * Whether `path` (relative to the drive root, using `/`) is one of the items sync-drive keeps at the
 * top level of the Replica: the Incoming folder, the Holding area or the last-updated marker. Letter
 * case is ignored, as the drives ignore it (ADR 0002).
 */
export function isSyncDriveItem(path: string): boolean {
  return SYNC_DRIVE_ITEMS.has(path.toLowerCase());
}
