/**
 * Times a Quick compare and a Deep verify of the paired drives (#63), for the baseline that faster
 * comparisons and Updates are measured against (#12). A developer script, not part of the app:
 *
 *   node scripts/benchmark.ts [--only <folder>] [--quick]
 *
 * Finds the Primary and the Replica by the Pairing, as the app does (ADR 0003): the app's own Pairing,
 * or the one in `SYNC_DRIVE_PAIRING_FILE`. For the rehearsal drives (#16), once paired in
 * `npm run rehearsal:app`:
 *
 *   SYNC_DRIVE_PAIRING_FILE=~/Library/Application\ Support/sync-drive-rehearsal/pairing.json node scripts/benchmark.ts
 *
 * Leaves out the Exclusions saved beside the Pairing, as the app does. `--only <folder>` gives both
 * runs a Folder limit: that folder (relative to the top of the drives, using `/`), as on Start (ADR 0017), for a short
 * run on a large drive. `--quick` skips the Deep verify.
 *
 * Says how many files it reads at once from each drive, chosen as the app chooses them (ADR 0022).
 * Runs a Quick compare, then a Deep verify, each exactly as the app runs it, and prints for each its
 * elapsed time and that of each phase: reading both drives (items listed per second), with Deep verify
 * verifying contents (ADR 0018), and confirming moves by checksum (ADR 0011), each with files and MB read
 * per second. Bytes read count both drives' copies, so MB/s is the two drives' together. A Quick compare
 * reads no contents, so its MB/s and files/s are of the Replica's files in the comparison (the Report's
 * totals), over the time spent reading both drives' folders. Time outside the phases (checking the
 * drives, matching files) is shown as the rest. A comparison only reads: this writes
 * nothing to either drive, and nothing beside the Pairing.
 *
 * macOS keeps recently read files in memory, so a run soon after another reads partly from memory and
 * looks faster than the drives are. The Deep verify's scan follows the Quick compare's, so it is
 * usually the faster of the two. For figures of the drives themselves, eject and reconnect both first.
 */
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  compare,
  exclusionsFileBeside,
  findPairedDrives,
  readExclusions,
  readPairing,
  readsAtOnce,
  Sha256Hasher,
  type CompareProgress,
  type Hasher,
  type Totals,
} from "../src/engine/index.ts";
import { fileCount, formatSize } from "../src/format.ts";
import { MacDriveKind } from "../src/macos/drive-kind.ts";
import { MacItemCounter } from "../src/macos/item-counter.ts";
import { MacVolumes } from "../src/macos/volume-identity.ts";

/** How long one phase of a comparison took, and how much it did. */
export interface PhaseTiming {
  phase: CompareProgress["phase"];
  seconds: number;
  /** Scanning only: items (files plus folders) listed on both drives together. */
  items?: number;
  /** Verifying and checking moves: files read in full, counting each Primary file and its Replica copy once. */
  files?: number;
  /** Verifying and checking moves: bytes read, on both drives together. */
  bytes?: number;
}

/** How long a comparison took, phase by phase. */
export interface Timing {
  deep: boolean;
  seconds: number;
  /** The phases in the order they ran. A comparison with nothing to read in a phase may not run it. */
  phases: PhaseTiming[];
  /** The Replica's files in the comparison, as the Report gives them. */
  replica: Totals;
}

/**
 * Compares `primary` with `replica` as the app does, Quick compare or with `deep` Deep verify, and
 * times it phase by phase. Writes nothing to either.
 */
export async function benchmark(
  primary: string,
  replica: string,
  options: { deep: boolean; exclusions?: readonly string[]; only?: string },
): Promise<Timing> {
  const phases: PhaseTiming[] = [];
  let phaseStarted = 0n;
  const finishPhase = (now: bigint) => {
    const current = phases.at(-1);
    if (current !== undefined) current.seconds = seconds(now - phaseStarted);
  };
  const started = process.hrtime.bigint();
  const onProgress = (progress: CompareProgress) => {
    let current = phases.at(-1);
    if (current?.phase !== progress.phase) {
      const now = process.hrtime.bigint();
      finishPhase(now);
      phaseStarted = now;
      current = { phase: progress.phase, seconds: 0, ...(progress.phase === "scanning" ? { items: 0 } : { files: 0, bytes: 0 }) };
      phases.push(current);
    }
    if (progress.phase === "scanning") current.items = progress.scanned;
  };
  const inner = new Sha256Hasher();
  const primaryWithin = primary.endsWith(sep) ? primary : primary + sep;
  /** Counts what each phase reads, as it reads it. */
  const hasher: Hasher = {
    async checksum(path, onRead) {
      const current = phases.at(-1);
      // Each Primary file is read with its Replica copy: one file read in full on both drives.
      if (current !== undefined && path.startsWith(primaryWithin)) current.files = (current.files ?? 0) + 1;
      return inner.checksum(path, (bytes) => {
        if (current !== undefined) current.bytes = (current.bytes ?? 0) + bytes;
        onRead?.(bytes);
      });
    },
  };
  const report = await compare(primary, replica, {
    deep: options.deep,
    exclusions: options.exclusions ?? [],
    ...(options.only === undefined ? {} : { only: options.only }),
    hasher,
    itemCounter: new MacItemCounter(),
    driveKind: new MacDriveKind(),
    onProgress,
  });
  const ended = process.hrtime.bigint();
  finishPhase(ended);
  return { deep: options.deep, seconds: seconds(ended - started), phases, replica: report.replica };
}

/** `nanoseconds` in seconds. */
function seconds(nanoseconds: bigint): number {
  return Number(nanoseconds) / 1e9;
}

/** Where the app keeps its Pairing, as in src/app/main.ts. */
const PAIRING_FILE =
  process.env.SYNC_DRIVE_PAIRING_FILE ?? join(homedir(), "Library", "Application Support", "sync-drive", "pairing.json");

const PHASE_NAMES: Record<CompareProgress["phase"], string> = {
  scanning: "Reading both drives",
  verifying: "Verifying contents",
  "checking moves": "Confirming moves",
};

/** The lines that describe `timing`. */
export function describeTiming(timing: Timing): string[] {
  const perSecond = (amount: number, seconds: number, unit: string) =>
    seconds > 0 ? `${Math.round(amount / seconds).toLocaleString("en-US")} ${unit}/s` : `- ${unit}/s`;
  const megabytesPerSecond = (bytes: number, seconds: number) =>
    seconds > 0 ? `${(bytes / 1e6 / seconds).toFixed(1)} MB/s` : "- MB/s";
  const time = (seconds: number) => `${seconds.toFixed(2)} s`;
  const lines = [`${timing.deep ? "Deep verify" : "Quick compare"}: ${time(timing.seconds)}`];
  const scanning = timing.phases.find((phase) => phase.phase === "scanning");
  if (!timing.deep && scanning !== undefined) {
    const { count, totalSize } = timing.replica;
    lines.push(
      `  Files compared, by the Replica's ${fileCount(count)} (${formatSize(totalSize)}), none read: ` +
        `${perSecond(count, scanning.seconds, "files")}, ${megabytesPerSecond(totalSize, scanning.seconds)}`,
    );
  }
  for (const phase of timing.phases) {
    const name = `  ${PHASE_NAMES[phase.phase]}:`.padEnd(24);
    if (phase.phase === "scanning") {
      const items = phase.items ?? 0;
      lines.push(`${name}${time(phase.seconds)}, ${items.toLocaleString("en-US")} items listed: ${perSecond(items, phase.seconds, "items")}`);
    } else {
      const files = phase.files ?? 0;
      const bytes = phase.bytes ?? 0;
      lines.push(
        `${name}${time(phase.seconds)}, ${fileCount(files)}, ${formatSize(bytes)} read on both drives: ` +
          `${perSecond(files, phase.seconds, "files")}, ${megabytesPerSecond(bytes, phase.seconds)}`,
      );
    }
  }
  const rest = timing.seconds - timing.phases.reduce((total, phase) => total + phase.seconds, 0);
  lines.push(`${"  The rest:".padEnd(24)}${time(rest)} (checking the drives, matching files)`);
  return lines;
}

async function main(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { only: { type: "string" }, quick: { type: "boolean", default: false } } });
  const pairing = await readPairing(PAIRING_FILE);
  if (pairing === undefined) throw new Error(`There is no Pairing in ${PAIRING_FILE}. Pair the drives in the app first.`);
  const exclusions = await readExclusions(exclusionsFileBeside(PAIRING_FILE));
  const { primary, replica } = await findPairedDrives(pairing, new MacVolumes());
  console.log(`Primary "${primary.name}" at ${primary.mountPoint}, Replica "${replica.name}" at ${replica.mountPoint}`);
  const driveKind = new MacDriveKind();
  const [onPrimary, onReplica] = await Promise.all([readsAtOnce(driveKind, primary.mountPoint), readsAtOnce(driveKind, replica.mountPoint)]);
  console.log(`Files read at once, by whether each drive is solid state (ADR 0022): Primary ${onPrimary}, Replica ${onReplica}`);
  console.log(`${values.only === undefined ? "Whole drives" : `Folder limit "${values.only}"`}, ${exclusions.length} Exclusions\n`);
  const runs = values.quick ? [false] : [false, true];
  for (const deep of runs) {
    const timing = await benchmark(primary.mountPoint, replica.mountPoint, {
      deep,
      exclusions,
      ...(values.only === undefined ? {} : { only: values.only }),
    });
    for (const line of describeTiming(timing)) console.log(line);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    const badArguments = String((error as NodeJS.ErrnoException).code).startsWith("ERR_PARSE_ARGS");
    if (badArguments) console.error("usage: node scripts/benchmark.ts [--only <folder>] [--quick]");
    process.exitCode = badArguments ? 2 : 1;
  });
}
