export { compare, type CompareOptions } from "./compare.ts";
export {
  findPairedDrives,
  pair,
  type PairedDrives,
  type PairedVolume,
  type Pairing,
} from "./pairing.ts";
export { readPairing, writePairing } from "./pairing-file.ts";
export type { FileEntry, FolderGroup, Report, Section } from "./report.ts";
export {
  update,
  type Approvals,
  type FailedFile,
  type FileCopier,
  type UpdateResult,
  type UpdateTarget,
} from "./update.ts";
export type { Volume, VolumeIdentity } from "./volumes.ts";
