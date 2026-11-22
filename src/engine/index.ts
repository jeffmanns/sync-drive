export { compare, type CompareOptions } from "./compare.ts";
export { Sha256Hasher, type Hasher } from "./hashing.ts";
export { readHoldingArea, type HoldingAreaContents } from "./holding-area.ts";
export {
  findPairedDrives,
  pair,
  type PairedDrives,
  type PairedVolume,
  type Pairing,
} from "./pairing.ts";
export { readPairing, writePairing } from "./pairing-file.ts";
export {
  makeMovesSection,
  makeSection,
  type FileEntry,
  type FolderGroup,
  type Move,
  type MoveGroup,
  type MovesSection,
  type Report,
  type Section,
  type Totals,
} from "./report.ts";
export {
  checkFreeSpace,
  safetyStopApplies,
  SAFETY_STOP_MIN_FILES,
  SAFETY_STOP_PERCENT,
  type FreeSpace,
} from "./safety-stops.ts";
export {
  nothingDone,
  update,
  UpdateStoppedError,
  type Approvals,
  type FailedFile,
  type FailedMove,
  type FileCopier,
  type UpdateResult,
  type UpdateSetup,
} from "./update.ts";
export type { Volume, VolumeIdentity } from "./volumes.ts";
