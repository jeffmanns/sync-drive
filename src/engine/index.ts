export { compare, type CompareOptions } from "./compare.ts";
export { readHoldingArea, type HoldingAreaContents } from "./holding-area.ts";
export {
  findPairedDrives,
  pair,
  type PairedDrives,
  type PairedVolume,
  type Pairing,
} from "./pairing.ts";
export { readPairing, writePairing } from "./pairing-file.ts";
export type { FileEntry, FolderGroup, Report, Section, Totals } from "./report.ts";
export {
  checkFreeSpace,
  safetyStopApplies,
  SAFETY_STOP_MIN_FILES,
  SAFETY_STOP_PERCENT,
  type FreeSpace,
} from "./safety-stops.ts";
export {
  update,
  type Approvals,
  type FailedFile,
  type FileCopier,
  type UpdateResult,
  type UpdateSetup,
} from "./update.ts";
export type { Volume, VolumeIdentity } from "./volumes.ts";
