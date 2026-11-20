import { parseArgs } from "node:util";
import {
  compare,
  findPairedDrives,
  pair,
  readPairing,
  writePairing,
  type GivenDrives,
  type Volume,
  type VolumeIdentity,
} from "../engine/index.ts";
import { renderReport } from "./render-report.ts";

export const USAGE = `Usage: sync-drive pair <primary> <replica> [--replace]
       sync-drive compare [<primary> <replica>] [--list]

  pair      Remembers which drive is the Primary and which is the Replica, by each
            drive's volume ID, so renaming a drive does not matter. Give the top level
            of each drive, e.g. /Volumes/Photos. --replace pairs again over an earlier
            Pairing, e.g. after replacing a drive.

  compare   Compares the paired Primary with the paired Replica by Quick compare (size
            and modification date) and reports new, changed and deleted files. Finds
            the drives by volume ID; if drives are given, checks they are the paired
            ones, in the right roles. Writes nothing to either drive.

  --list    Show every file, not just the totals for each folder.`;

/** What the CLI needs from the Mac it runs on. */
export interface CliDeps {
  volumes: VolumeIdentity;
  /** Where the Pairing is stored. */
  pairingFile: string;
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
      },
    });
  } catch (error) {
    deps.err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const [command, ...drives] = parsed.positionals;
  const { list, replace } = parsed.values;
  try {
    if (command === "pair" && drives.length === 2 && !list) {
      return await runPair(drives[0]!, drives[1]!, replace, deps);
    }
    if (command === "compare" && (drives.length === 0 || drives.length === 2) && !replace) {
      const given = drives.length === 2 ? { primary: drives[0]!, replica: drives[1]! } : undefined;
      return await runCompare(given, list, deps);
    }
  } catch (error) {
    deps.err(`sync-drive: ${(error as Error).message}`);
    return 1;
  }
  deps.err(USAGE);
  return 2;
}

async function runPair(primary: string, replica: string, replace: boolean, deps: CliDeps): Promise<number> {
  const existing = await readPairing(deps.pairingFile).catch(() => undefined);
  if (existing !== undefined && !replace) {
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

async function runCompare(given: GivenDrives | undefined, list: boolean, deps: CliDeps): Promise<number> {
  const pairing = await readPairing(deps.pairingFile);
  if (pairing === undefined) {
    throw new Error("The drives have not been paired yet. Pair them first with `sync-drive pair <primary> <replica>`.");
  }
  const drives = await findPairedDrives(pairing, deps.volumes, given);
  const report = await compare(drives.primary.mountPoint, drives.replica.mountPoint);
  deps.out(`Primary: ${describeDrive(drives.primary)}\nReplica: ${describeDrive(drives.replica)}\n`);
  deps.out(renderReport(report, { list }));
  return 0;
}

function describeDrive(volume: Volume): string {
  return `"${volume.name}" at ${volume.mountPoint}`;
}
