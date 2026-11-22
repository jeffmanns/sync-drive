import { parseArgs } from "node:util";
import {
  checkFreeSpace,
  compare,
  findPairedDrives,
  pair,
  readHoldingArea,
  readPairing,
  SAFETY_STOP_MIN_FILES,
  SAFETY_STOP_PERCENT,
  update,
  writePairing,
  type FileCopier,
  type FileEntry,
  type PairedDrives,
  type Report,
  type Volume,
  type VolumeIdentity,
} from "../engine/index.ts";
import { fileCount, formatSize } from "../format.ts";
import { renderReport } from "./render-report.ts";

export const USAGE = `Usage: sync-drive pair <primary> <replica> [--replace]
       sync-drive compare [--list]
       sync-drive update [--list] [--allow-mass-deletion]

  pair      Remembers which drive is the Primary and which is the Replica, by each
            drive's volume ID, so renaming a drive does not matter. Give the top level
            of each drive, e.g. /Volumes/Photos. --replace pairs again over an earlier
            Pairing, e.g. after replacing a drive.

  compare   Finds the paired Primary and Replica among the connected drives by volume
            ID, compares them by Quick compare (size and modification date) and
            reports new, changed and deleted files. Writes nothing to either drive.

  update    Compares like compare, shows the report and asks for approval. Once
            approved, copies new and changed files from the Primary to the Replica,
            keeping all their metadata. Files only on the Replica are moved into the
            "sync-drive Holding Area" folder on the Replica only after a separate
            confirmation, which first empties the previous Holding area; they stay
            there until the next Update whose deletions are confirmed. Never writes
            to the Primary.

            Refuses, writing nothing, when the Safety stop applies: more than ${SAFETY_STOP_PERCENT}%
            of the Replica's files or size, and more than ${SAFETY_STOP_MIN_FILES} files, would go
            into the Holding area. Also refuses when the Replica lacks free space for
            the copies.

  --list    Show every file, not just the totals for each folder.

  --allow-mass-deletion
            Go ahead with this one Update even though the Safety stop applies. You
            are still asked to approve the copies and confirm the deletions.`;

/** What the CLI needs from the Mac it runs on. */
export interface CliDeps {
  volumes: VolumeIdentity;
  /** Where the Pairing is stored. */
  pairingFile: string;
  /** Copies files to the Replica with all their metadata. */
  copier: FileCopier;
  /** Asks the user a yes/no question; resolves to whether they said yes. */
  confirm(question: string): Promise<boolean>;
  out(text: string): void;
  err(text: string): void;
}

/** Runs the CLI with `argv` (without the program name) and returns the exit code. */
export async function run(argv: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        list: { type: "boolean", default: false },
        replace: { type: "boolean", default: false },
        "allow-mass-deletion": { type: "boolean", default: false },
      },
    });
  } catch (error) {
    deps.err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const [command, ...drives] = parsed.positionals;
  const { list, replace, "allow-mass-deletion": allowMassDeletion } = parsed.values;
  try {
    if (command === "pair" && drives.length === 2 && !list && !allowMassDeletion) {
      return await runPair(drives[0]!, drives[1]!, replace, deps);
    }
    if (command === "compare" && drives.length === 0 && !replace && !allowMassDeletion) {
      return await runCompare(list, deps);
    }
    if (command === "update" && drives.length === 0 && !replace) {
      return await runUpdate(list, allowMassDeletion, deps);
    }
  } catch (error) {
    deps.err(`sync-drive: ${(error as Error).message}`);
    return 1;
  }
  deps.err(USAGE);
  return 2;
}

async function runPair(primary: string, replica: string, replace: boolean, deps: CliDeps): Promise<number> {
  // Without --replace, any existing Pairing blocks pairing again; a damaged one rejects here too.
  const existing = replace ? undefined : await readPairing(deps.pairingFile);
  if (existing !== undefined) {
    throw new Error(
      `The drives are already paired (Primary "${existing.primary.name}", Replica "${existing.replica.name}"). ` +
        `To pair again, e.g. after replacing a drive, add --replace.`,
    );
  }
  const pairing = await pair(primary, replica, deps.volumes);
  await writePairing(deps.pairingFile, pairing);
  deps.out(
    `Paired.\n` +
      `Primary: "${pairing.primary.name}" (volume ID ${pairing.primary.id})\n` +
      `Replica: "${pairing.replica.name}" (volume ID ${pairing.replica.id})`,
  );
  return 0;
}

async function runCompare(list: boolean, deps: CliDeps): Promise<number> {
  await compareAndShow(list, deps);
  return 0;
}

async function runUpdate(list: boolean, allowMassDeletion: boolean, deps: CliDeps): Promise<number> {
  const { drives, report } = await compareAndShow(list, deps);
  const copies = report.new.count + report.changed.count;
  const deletions = report.deleted.count;
  if (copies === 0 && deletions === 0) {
    deps.out("\nNothing to update.");
    return 0;
  }
  // Both stops are checked before any question, so a refused Update asks nothing and writes nothing.
  const refusals: string[] = [];
  if (report.safetyStop && !allowMassDeletion) {
    refusals.push(
      `The Safety stop applies: ${fileCount(deletions)} (${formatSize(report.deleted.totalSize)}) would go into the Holding area, ` +
        `more than ${SAFETY_STOP_PERCENT}% of the Replica. That often means something is wrong with the Primary: ` +
        `it is failing, was only partly read, or was erased. Check the Primary first. ` +
        `If you really did delete or move these files, run \`sync-drive update --allow-mass-deletion\` to go ahead with this one Update; ` +
        `you will still be asked to approve the copies and confirm the deletions.`,
    );
  }
  if (copies > 0) {
    const space = await checkFreeSpace(report, drives.replica.mountPoint);
    if (!space.enough) {
      const held = await readHoldingArea(drives.replica.mountPoint);
      refusals.push(
        `The Replica has ${formatSize(space.free)} free, but the new and changed files need ${formatSize(space.needed)}. ` +
          (held.count > 0
            ? `The Holding area on the Replica holds ${formatSize(held.totalSize)} from the previous Update. Deleting it frees that space, ` +
              `but its files are then gone for good, so first copy back to the Primary any you want to keep. `
            : `The Replica needs a larger drive, or files other than the backup removed from it. `) +
          `Then run update again.`,
      );
    }
  }
  if (refusals.length > 0) {
    deps.err(`\n${refusals.map((reason) => `sync-drive: ${reason}`).join("\n")}\nNothing was written to the Replica.`);
    return 1;
  }
  deps.out("");
  // The main approval. With nothing to copy, confirming the deletions approves the Update.
  if (copies > 0) {
    const size = formatSize(report.new.totalSize + report.changed.totalSize);
    const approved = await deps.confirm(`Copy ${copies.toLocaleString("en-US")} new and changed ${copies === 1 ? "file" : "files"} (${size}) to the Replica?`);
    if (!approved) {
      deps.out("Nothing was written to the Replica.");
      return 0;
    }
  }
  let deletionsConfirmed = false;
  if (deletions > 0) {
    await warnAboutHoldingArea(drives.replica.mountPoint, deps);
    deletionsConfirmed = await deps.confirm(
      `Move ${deletions.toLocaleString("en-US")} deleted ${deletions === 1 ? "file" : "files"} (${formatSize(report.deleted.totalSize)}) into the Holding area on the Replica?`,
    );
  }
  if (copies === 0 && !deletionsConfirmed) {
    deps.out("Nothing was written to the Replica.");
    return 0;
  }
  const result = await update(report, { update: true, deletions: deletionsConfirmed, overrideSafetyStop: allowMassDeletion }, {
    primary: drives.primary.mountPoint,
    replica: drives.replica.mountPoint,
    copier: deps.copier,
  });
  if (copies > 0) deps.out(`Copied ${fileCount(result.copied.length)}, ${formatSize(totalSize(result.copied))}.`);
  if (deletionsConfirmed) deps.out(`Moved ${fileCount(result.moved.length)}, ${formatSize(totalSize(result.moved))}, into the Holding area.`);
  else if (deletions > 0) deps.out("Deleted files were left on the Replica.");
  const problems: string[] = [];
  if (result.failed.length > 0) {
    problems.push(
      `Not copied (${result.failed.length}); the Replica keeps its earlier version of each, if any:\n` +
        result.failed.map((file) => `  ${file.path}: ${file.reason}`).join("\n"),
    );
  }
  if (result.notMoved.length > 0) {
    problems.push(
      `Not moved into the Holding area (${result.notMoved.length}):\n` +
        result.notMoved.map((file) => `  ${file.path}: ${file.reason}`).join("\n"),
    );
  }
  if (problems.length === 0) return 0;
  deps.err(problems.join("\n"));
  return 1;
}

/** Says what confirming deletions will permanently delete: whatever the previous Update left in the Holding area. */
async function warnAboutHoldingArea(replica: string, deps: CliDeps): Promise<void> {
  const held = await readHoldingArea(replica);
  if (held.count === 0) return;
  deps.out(
    `The Holding area on the Replica holds ${fileCount(held.count)}, ${formatSize(held.totalSize)}, from the previous Update. ` +
      `Confirming these deletions deletes ${held.count === 1 ? "it" : "them"} permanently.`,
  );
}

function totalSize(files: FileEntry[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

/** Finds the paired drives, compares them, and shows the report. */
async function compareAndShow(list: boolean, deps: CliDeps): Promise<{ drives: PairedDrives; report: Report }> {
  const pairing = await readPairing(deps.pairingFile);
  if (pairing === undefined) {
    throw new Error("The drives have not been paired yet. Pair them first with `sync-drive pair <primary> <replica>`.");
  }
  const drives = await findPairedDrives(pairing, deps.volumes);
  const report = await compare(drives.primary.mountPoint, drives.replica.mountPoint);
  deps.out(`Primary: ${describeDrive(drives.primary)}\nReplica: ${describeDrive(drives.replica)}\n`);
  deps.out(renderReport(report, { list }));
  return { drives, report };
}

function describeDrive(volume: Volume): string {
  return `"${volume.name}" at ${volume.mountPoint}`;
}
