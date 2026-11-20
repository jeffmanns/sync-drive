import { stat } from "node:fs/promises";
import { makeSection, type FileEntry, type Report } from "./report.ts";
import { scan, type ScannedFile } from "./scan.ts";

/**
 * Options for a comparison. Quick compare is currently the only kind; Deep verify and
 * user Exclusions will be added here.
 */
export interface CompareOptions {}

/**
 * Compares the Primary with the Replica by Quick compare. Reads both drives; writes
 * nothing to either. Rejects if either folder is missing or is not a folder.
 */
export async function compare(
  primary: string,
  replica: string,
  _options: CompareOptions = {},
): Promise<Report> {
  await Promise.all([assertFolder("Primary", primary), assertFolder("Replica", replica)]);
  const [primaryFiles, replicaFiles] = await Promise.all([scan(primary), scan(replica)]);
  const added: FileEntry[] = [];
  const changed: FileEntry[] = [];
  const deleted: FileEntry[] = [];
  for (const [path, file] of primaryFiles) {
    const counterpart = replicaFiles.get(path);
    if (counterpart === undefined) added.push({ path, size: file.size });
    else if (!quickEqual(file, counterpart)) changed.push({ path, size: file.size });
  }
  for (const [path, file] of replicaFiles) {
    if (!primaryFiles.has(path)) deleted.push({ path, size: file.size });
  }
  return { new: makeSection(added), changed: makeSection(changed), deleted: makeSection(deleted) };
}

/** Quick compare: two files are equal when their size and modification date match. Contents are not read. */
function quickEqual(a: ScannedFile, b: ScannedFile): boolean {
  return a.size === b.size && a.mtimeNs === b.mtimeNs;
}

async function assertFolder(role: "Primary" | "Replica", path: string): Promise<void> {
  const stats = await stat(path).catch((error: NodeJS.ErrnoException) => {
    throw new Error(`The ${role} folder ${path} cannot be read (${error.code ?? error.message})`, {
      cause: error,
    });
  });
  if (!stats.isDirectory()) throw new Error(`The ${role} ${path} is not a folder`);
}
