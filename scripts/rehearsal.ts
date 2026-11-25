/**
 * The rehearsal kit (#16): two small APFS disk images that macOS mounts in /Volumes like real external
 * drives, so the owner can rehearse the whole workflow in the app before the first run on real drives.
 * See `docs/rehearsal.md` for the walkthrough. A developer script, not part of the app:
 *
 *   npm run rehearsal:create <folder>   make and mount the drives, and copy <folder> onto the fake Primary
 *   npm run rehearsal:app               open the app with the rehearsal's own Pairing, Exclusions and Update logs
 *   npm run rehearsal:remove            eject the drives and delete everything the rehearsal made
 *
 * Everything lives in one rehearsal folder, `~/Library/Application Support/sync-drive-rehearsal/`
 * (`SYNC_DRIVE_REHEARSAL_FOLDER` overrides it): the disk images, and the Pairing, Exclusions and Update
 * logs of the app opened by `rehearsal:app`. So the rehearsal never touches the real Pairing or logs.
 * The chosen folder is only read, never written to.
 */
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MacVolumes } from "../src/macos/volume-identity.ts";

const run = promisify(execFile);

/** The rehearsal drives' names, as the Finder and the app show them. */
export interface RehearsalNames {
  primary: string;
  replica: string;
}

/** A mounted rehearsal drive. */
export interface RehearsalDrive {
  name: string;
  /** Where macOS mounted it, e.g. `/Volumes/Rehearsal Primary`. */
  mountPoint: string;
  /** Its Volume ID, as Pairing and the Update logs show it. */
  id: string;
}

/** What `rehearsal.json`, in the rehearsal folder, records. Its presence marks a folder the kit made. */
interface Record_ {
  source: string;
  created: string;
  primary?: RehearsalDrive;
  replica?: RehearsalDrive;
}

export const DEFAULT_NAMES: RehearsalNames = { primary: "Rehearsal Primary", replica: "Rehearsal Replica" };

export const DEFAULT_FOLDER =
  process.env.SYNC_DRIVE_REHEARSAL_FOLDER ?? join(homedir(), "Library", "Application Support", "sync-drive-rehearsal");

const RECORD = "rehearsal.json";
const PRIMARY_IMAGE = "Primary.sparseimage";
const REPLICA_IMAGE = "Replica.sparseimage";

/**
 * Makes and mounts the two rehearsal drives, and copies the contents of `source` onto the Primary.
 * The images are sparse: they take only the space their files use, however large the drive looks.
 * The Replica is left empty, so the first Update copies everything. Refuses if `folder` already
 * holds a rehearsal.
 */
export async function createRehearsal({
  folder = DEFAULT_FOLDER,
  source,
  names = DEFAULT_NAMES,
}: {
  folder?: string;
  source: string;
  names?: RehearsalNames;
}): Promise<{ primary: RehearsalDrive; replica: RehearsalDrive }> {
  const sourceStats = await stat(source).catch(() => undefined);
  if (sourceStats?.isDirectory() !== true) throw new Error(`${source} is not a folder.`);
  await mkdir(folder, { recursive: true });
  if (await readRecord(folder)) {
    throw new Error(`A rehearsal already exists in ${folder}. Remove it first: npm run rehearsal:remove`);
  }
  // Written first, so that `removeRehearsal` can clean up even if a later step fails.
  const record: Record_ = { source: await realpath(source), created: new Date().toISOString() };
  await writeRecord(folder, record);

  const sourceBytes = await sizeOf(source);
  const megabytes = (bytes: number) => `${Math.ceil(bytes / 2 ** 20)}m`;
  // Room for the Primary's files to grow a little, and on the Replica for the copies and the Holding area.
  const primary = await makeDrive(join(folder, PRIMARY_IMAGE), names.primary, megabytes(sourceBytes * 1.5 + 2 ** 30));
  const replica = await makeDrive(join(folder, REPLICA_IMAGE), names.replica, megabytes(sourceBytes * 3 + 2 ** 30));
  await writeRecord(folder, { ...record, primary, replica });

  // ditto keeps dates, extended attributes (Finder tags), permissions and shortcuts, and only reads `source`.
  await run("ditto", [source, primary.mountPoint], { maxBuffer: 64 * 1024 * 1024 }).catch((error: { stderr?: string }) => {
    throw new Error(`Could not copy ${source} onto the rehearsal Primary:\n${error.stderr ?? String(error)}`);
  });
  return { primary, replica };
}

/**
 * Ejects the rehearsal drives and deletes the rehearsal folder: the disk images, and the Pairing,
 * Exclusions and Update logs `rehearsal:app` kept there. Does nothing if there is no rehearsal. Refuses
 * to delete a folder the kit did not make, and deletes nothing if a drive cannot be ejected.
 * Returns the drives the rehearsal had recorded, or `undefined` if there was no rehearsal.
 */
export async function removeRehearsal({ folder = DEFAULT_FOLDER }: { folder?: string } = {}): Promise<RehearsalDrive[] | undefined> {
  const exists = await stat(folder).then(
    () => true,
    () => false,
  );
  if (!exists) return undefined;
  const record = await readRecord(folder);
  if (record === undefined) throw new Error(`${folder} was not made by the rehearsal kit, so it is left alone.`);
  for (const device of await devicesOfImagesIn(folder)) await detach(device);
  await rm(folder, { recursive: true, force: true });
  return [record.primary, record.replica].filter((drive) => drive !== undefined);
}

/** Makes a sparse APFS disk image at `image` and mounts it in /Volumes, as a connected drive is. */
async function makeDrive(image: string, name: string, size: string): Promise<RehearsalDrive> {
  await run("hdiutil", ["create", "-quiet", "-type", "SPARSE", "-fs", "APFS", "-size", size, "-volname", name, image]);
  // No -mountpoint: macOS mounts it at /Volumes/<name> (or "<name> 1" if that is taken), where Pairing looks (ADR 0020).
  const { stdout } = await run("hdiutil", ["attach", image]);
  const mountPoint = stdout.match(/\t(\/Volumes\/.+)$/m)?.[1]?.trim();
  if (mountPoint === undefined) throw new Error(`hdiutil attach did not say where it mounted ${image}:\n${stdout}`);
  const { id } = await new MacVolumes().volumeAt(mountPoint);
  return { name, mountPoint, id };
}

/** The device nodes (e.g. `/dev/disk5`) of the disk images in `folder` that are mounted now. */
async function devicesOfImagesIn(folder: string): Promise<string[]> {
  const within = (await realpath(folder)) + sep;
  const { stdout: plist } = await run("hdiutil", ["info", "-plist"], { maxBuffer: 16 * 1024 * 1024 });
  const converting = run("plutil", ["-convert", "json", "-o", "-", "-"], { maxBuffer: 16 * 1024 * 1024 });
  converting.child.stdin!.end(plist);
  const info = JSON.parse((await converting).stdout) as {
    images?: { "image-path"?: string; "system-entities"?: { "dev-entry"?: string }[] }[];
  };
  const devices: string[] = [];
  for (const image of info.images ?? []) {
    // hdiutil names an image by the path it was attached with, e.g. /var/… rather than /private/var/….
    const path = image["image-path"] === undefined ? undefined : await realpath(image["image-path"]).catch(() => undefined);
    if (!path?.startsWith(within)) continue;
    // The whole disk, e.g. /dev/disk5 rather than /dev/disk5s1: the shortest entry.
    const entries = (image["system-entities"] ?? []).map((entity) => entity["dev-entry"]).filter((entry) => entry !== undefined);
    const whole = entries.sort((a, b) => a.length - b.length)[0];
    if (whole !== undefined) devices.push(whole);
  }
  return devices;
}

/**
 * Ejects the disk image at `device`. Spotlight or fseventsd can hold a freshly used drive for a moment,
 * so it is retried, but never forced: an app with a file open on the drive could lose unsaved work.
 */
async function detach(device: string): Promise<void> {
  const attempts = 6;
  for (let attempt = 1; ; attempt++) {
    try {
      await run("hdiutil", ["detach", device]);
      return;
    } catch (error) {
      if (attempt === attempts) {
        const said = (error as { stderr?: string }).stderr?.trim();
        throw new Error(`Could not eject ${device}${said ? `: ${said}` : ""}. Close any window or app using it, then try again.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

/** The size in bytes of the files under `folder`, as `du` counts them. */
async function sizeOf(folder: string): Promise<number> {
  // du exits with an error for anything it cannot read, but still prints the total of the rest.
  const { stdout } = await run("du", ["-sk", folder]).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
  const kilobytes = Number.parseInt(stdout, 10);
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : 0;
}

async function readRecord(folder: string): Promise<Record_ | undefined> {
  const text = await readFile(join(folder, RECORD), "utf8").catch(() => undefined);
  return text === undefined ? undefined : (JSON.parse(text) as Record_);
}

async function writeRecord(folder: string, record: Record_): Promise<void> {
  await writeFile(join(folder, RECORD), JSON.stringify(record, null, 2) + "\n");
}

/** Opens the built app with its Pairing, Exclusions and Update logs in the rehearsal folder. */
async function openApp(folder: string): Promise<void> {
  if ((await readRecord(folder)) === undefined) throw new Error("There is no rehearsal yet. Create one first: npm run rehearsal:create <folder>");
  const project = fileURLToPath(new URL("..", import.meta.url));
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
  const app = spawn(join(project, "node_modules", ".bin", "electron"), [project], {
    stdio: "inherit",
    env: { ...env, SYNC_DRIVE_PAIRING_FILE: join(folder, "pairing.json") },
  });
  await new Promise((resolve) => app.on("exit", resolve));
}

function describeDrive(role: string, drive: RehearsalDrive): string {
  return `  ${role}: "${drive.name}" at ${drive.mountPoint} (volume ID ${drive.id})`;
}

async function main([command, ...args]: string[]): Promise<void> {
  const folder = DEFAULT_FOLDER;
  if (command === "create" && args.length === 1) {
    const { primary, replica } = await createRehearsal({ folder, source: args[0]! });
    console.log(`Rehearsal drives made in ${folder}, and ${args[0]} copied onto the Primary:`);
    console.log(describeDrive("Primary", primary));
    console.log(describeDrive("Replica", replica));
    const others = (await new MacVolumes().candidates()).filter((drive) => drive.id !== primary.id && drive.id !== replica.id);
    if (others.length > 0) {
      console.log(`\nPairing needs exactly two drives connected. Eject these first: ${others.map((drive) => `"${drive.name}"`).join(", ")}.`);
    }
    console.log("\nNext: npm run rehearsal:app, and follow docs/rehearsal.md.");
  } else if (command === "app" && args.length === 0) {
    await openApp(folder);
  } else if (command === "remove" && args.length === 0) {
    const drives = await removeRehearsal({ folder });
    if (drives === undefined) {
      console.log(`There is no rehearsal to remove: ${folder} does not exist.`);
      return;
    }
    if (drives.length > 0) console.log("Ejected and deleted the rehearsal drives:");
    for (const drive of drives) console.log(`  "${drive.name}" (volume ID ${drive.id})`);
    console.log(`Deleted ${folder}, with the rehearsal's Pairing, Exclusions and Update logs.`);
  } else {
    console.log("Usage: npm run rehearsal:create <folder> | npm run rehearsal:app | npm run rehearsal:remove");
    process.exitCode = 2;
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
