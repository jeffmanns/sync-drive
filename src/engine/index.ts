export { compare, type CompareOptions } from "./compare.ts";
export { exclusionsFileBeside, readExclusions, writeExclusions } from "./exclusions-file.ts";
export { checkExclusion, exclusionMatcher, sameExclusion, type ExclusionMatcher } from "./exclusions.ts";
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
  type Unreadable,
} from "./report.ts";
export {
  checkFreeSpace,
  safetyStopApplies,
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
export type { Remounter, Volume, VolumeIdentity } from "./volumes.ts";
