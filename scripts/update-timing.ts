/**
 * Times an Update copying files one at a time, as before #65, and as many at once as the app chooses
 * for the drives (ADR 0022). A developer script, not part of the app:
 *
 *   node scripts/update-timing.ts <folder on a drive> [files] [MB per file] [rounds]
 *
 * Makes `files` files of random data (default 200 of 5 MB) in a temporary folder on the Mac, which
 * stands in for the Primary, and updates a new, empty folder inside <folder>, the Replica, from it:
 * copied with the copy helper and each copy read back from the drive, exactly as the app's Update
 * does. Each round updates a fresh Replica folder one at a time, then again as chosen, so both see
 * the Mac's memory alike (default 2 rounds). Prints how many files are copied at once, and each
 * Update's time and MB/s. Removes everything it made, on the Mac and the drive. Needs
 * `npm run build` first, for the helper. Writes nothing else to the drive.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { compare, readsAtOnce, update, type DriveKind } from "../src/engine/index.ts";
import { MacDriveKind } from "../src/macos/drive-kind.ts";
import { MacFileCopier } from "../src/macos/file-copier.ts";
import { MacUncachedHasher } from "../src/macos/uncached-hasher.ts";

const run = promisify(execFile);

const [folder, filesArg = "200", megabytesArg = "5", roundsArg = "2"] = process.argv.slice(2);
const files = Number(filesArg);
const megabytes = Number(megabytesArg);
const rounds = Number(roundsArg);
if (folder === undefined || !(files > 0) || !(megabytes > 0) || !(rounds > 0)) {
  console.error("usage: node scripts/update-timing.ts <folder on a drive> [files] [MB per file] [rounds]");
  process.exit(2);
}

/** The top level of the drive `path` is on, as `df` gives it. */
async function driveOf(path: string): Promise<string> {
  const { stdout } = await run("df", ["-P", path]);
  const mounted = /^\S+\s+\d+\s+\d+\s+\d+\s+\d+%\s+(.+)$/.exec(stdout.trim().split("\n").at(-1) ?? "")?.[1];
  if (mounted === undefined) throw new Error(`df gave no drive for ${path}`);
  return mounted;
}

/** macOS's word on the drive each folder is on: the app asks about drives' top levels, these are folders. */
const mac = new MacDriveKind();
const driveKind: DriveKind = { isSolidState: async (path) => mac.isSolidState(await driveOf(path)) };

const primary = await mkdtemp(join(tmpdir(), "sync-drive-update-timing-"));
const replicas = join(folder, `sync-drive-update-timing-${process.pid}`);
try {
  await mkdir(replicas);
  for (let i = 0; i < files; i += 1) {
    await writeFile(join(primary, `${String(i).padStart(5, "0")}.bin`), randomBytes(megabytes * 1_000_000));
  }
  const [onPrimary, onReplica] = await Promise.all([readsAtOnce(driveKind, primary), readsAtOnce(driveKind, replicas)]);
  console.log(`${files} files of ${megabytes} MB, from ${primary} to ${folder}`);
  console.log(`Files at once as chosen: ${onPrimary} from the Primary, ${onReplica} on the Replica`);
  /** Seconds to update a fresh Replica folder from the Primary, one at a time or as chosen. */
  const timeUpdate = async (round: string, chosen: boolean) => {
    const replica = join(replicas, round);
    await mkdir(replica);
    const report = await compare(primary, replica);
    const started = process.hrtime.bigint();
    const result = await update(report, { update: true, moves: false, deletions: false }, {
      primary,
      replica,
      copier: new MacFileCopier(),
      copyHasher: new MacUncachedHasher(),
      ...(chosen ? { driveKind } : {}),
    });
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    if (result.failed.length > 0) throw new Error(`${result.failed.length} copies failed: ${result.failed[0]!.reason}`);
    await rm(replica, { recursive: true });
    return seconds;
  };
  const line = (label: string, seconds: number) =>
    console.log(`${label}: ${seconds.toFixed(2)} s (${((files * megabytes) / seconds).toFixed(0)} MB/s)`);
  for (let round = 1; round <= rounds; round += 1) {
    line(`Round ${round}, one at a time`, await timeUpdate(`${round}-one`, false));
    line(`Round ${round}, as chosen    `, await timeUpdate(`${round}-chosen`, true));
  }
} finally {
  await rm(replicas, { recursive: true, force: true });
  await rm(primary, { recursive: true, force: true });
}
