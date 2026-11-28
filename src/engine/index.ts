export { compare, type CompareOptions } from "./compare.ts";
export { exclusionsFileBeside, readExclusions, writeExclusions } from "./exclusions-file.ts";
export { checkExclusion, exclusionMatcher, sameExclusion, type ExclusionMatcher } from "./exclusions.ts";
export { NotReadableFromDriveError, sha256, Sha256Hasher, type Hasher } from "./hashing.ts";
export { readHoldingArea, type HoldingAreaContents } from "./holding-area.ts";
export { readLastUpdated, type FolderUpdated, type LastUpdated, type Updated } from "./last-updated.ts";
export {
  findPairedDrives,
  findPairedReplica,
  pairDrives,
  type PairedDrives,
  type PairedVolume,
  type Pairing,
} from "./pairing.ts";
export { readPairing, writePairing } from "./pairing-file.ts";
export { askSolidState, readLimiter, readsAtOnce, SOLID_STATE_READS, type ReadLimiter } from "./reads-at-once.ts";
export {
  MarkedDriveKind,
  markedIn,
  readSolidStateMarks,
  solidStateMarksFileBeside,
  writeSolidStateMarks,
  type KindOf,
} from "./solid-state-marks.ts";
export {
  makeMovesSection,
  makeSection,
  type Anomalies,
  type ContentMismatch,
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
export type { CheckingMovesProgress, CompareProgress, VerifyingProgress, FilesDone, ScanningProgress, UpdateProgress } from "./progress.ts";
export type { CandidateDrive, DriveKind, ItemCounter, Remounter, Volume, VolumeIdentity } from "./volumes.ts";
