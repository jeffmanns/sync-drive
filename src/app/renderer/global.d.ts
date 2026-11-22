import type { SyncDriveBridge } from "../view.ts";

declare global {
  interface Window {
    /** Given by the preload script. */
    syncDrive: SyncDriveBridge;
  }
}
