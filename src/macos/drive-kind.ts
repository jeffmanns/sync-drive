import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { DriveKind } from "../engine/index.ts";
import { diskutilPlist, plistFrom } from "./volume-identity.ts";

const run = promisify(execFile);

/** Disk images stored on disk images, followed no deeper than this, so a loop can never hang. */
const MOST_IMAGES_INSIDE = 4;

/**
 * Tells from macOS whether a drive is solid state, as `diskutil info` says ("Solid State"). A disk
 * image has no kind of its own: it is read from the drive its image file is stored on, so that
 * drive's kind is its kind (ADR 0022). Reads only; changes nothing.
 */
export class MacDriveKind implements DriveKind {
  async isSolidState(mountPoint: string): Promise<boolean | undefined> {
    return solidState(mountPoint, MOST_IMAGES_INSIDE).catch(() => undefined);
  }
}

async function solidState(mountPoint: string, imagesInside: number): Promise<boolean | undefined> {
  const real = await realpath(mountPoint);
  const info = await diskutilPlist(["info", "-plist", real]);
  // diskutil describes the drive a folder is on only when given that drive's top level.
  if (info.MountPoint !== real) return undefined;
  if (typeof info.SolidState === "boolean") return info.SolidState;
  if (info.BusProtocol !== "Disk Image" || imagesInside === 0) return undefined;
  const image = await imageFileMountedAt(real);
  return image === undefined ? undefined : solidState(await mountPointOf(image), imagesInside - 1);
}

/** The image file of the disk image mounted at `mountPoint`, as `hdiutil info` lists it, or `undefined`. */
async function imageFileMountedAt(mountPoint: string): Promise<string | undefined> {
  const { images } = await plistFrom("hdiutil", ["info", "-plist"]);
  for (const image of Array.isArray(images) ? (images as Array<Record<string, unknown>>) : []) {
    const entities = Array.isArray(image["system-entities"]) ? (image["system-entities"] as Array<Record<string, unknown>>) : [];
    if (entities.some((entity) => entity["mount-point"] === mountPoint) && typeof image["image-path"] === "string") {
      return image["image-path"];
    }
  }
  return undefined;
}

/** The top level of the drive `path` is on, as `df` gives it. */
async function mountPointOf(path: string): Promise<string> {
  const { stdout } = await run("df", ["-P", path]);
  // The last line: device, sizes, capacity, then the mount point, which may hold spaces.
  const mounted = /^\S+\s+\d+\s+\d+\s+\d+\s+\d+%\s+(.+)$/.exec(stdout.trim().split("\n").at(-1) ?? "")?.[1];
  if (mounted === undefined) throw new Error(`df gave no drive for ${path}`);
  return mounted;
}
