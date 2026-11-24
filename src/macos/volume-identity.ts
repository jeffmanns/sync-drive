import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { CandidateDrive, Volume, VolumeIdentity } from "../engine/index.ts";

const run = promisify(execFile);

/** Reads drives' volume UUIDs from macOS, via `diskutil`. Reads only; changes nothing. */
export class MacVolumes implements VolumeIdentity {
  async volumeAt(path: string): Promise<Volume> {
    const real = await realpath(path).catch((error: NodeJS.ErrnoException) => {
      throw new Error(`${path} cannot be read (${error.code ?? error.message})`, { cause: error });
    });
    // diskutil exits with an error for a path that is not a mount point; its output says why.
    const info = await diskutilPlist(["info", "-plist", real]).catch(() => undefined);
    const volume = info === undefined ? undefined : toVolume(info);
    if (volume === undefined || volume.mountPoint !== real) {
      throw new Error(`${path} is not the top level of a drive. Give the drive itself, e.g. /Volumes/<name>.`);
    }
    return volume;
  }

  async connected(): Promise<Volume[]> {
    const list = await diskutilPlist(["list", "-plist"]);
    const volumes = new Map<string, Volume>();
    // Volumes sit at different depths (partitions, APFS containers), so look everywhere.
    (function visit(node: unknown): void {
      if (Array.isArray(node)) return node.forEach(visit);
      if (typeof node !== "object" || node === null) return;
      const volume = toVolume(node as Record<string, unknown>);
      if (volume !== undefined) volumes.set(volume.mountPoint, volume);
      Object.values(node).forEach(visit);
    })((list as Record<string, unknown>).AllDisksAndPartitions);
    return [...volumes.values()];
  }

  async candidates(): Promise<CandidateDrive[]> {
    const described = await Promise.all(
      (await this.connected()).map(async (volume) => {
        // A drive ejected since it was listed is simply not offered.
        const info = await diskutilPlist(["info", "-plist", volume.mountPoint]).catch(() => undefined);
        return info === undefined || !couldBePaired(info) ? undefined : { ...volume, size: sizeOf(info), writable: info.Writable === true };
      }),
    );
    return described.filter((drive) => drive !== undefined);
  }
}

/**
 * Whether the volume diskutil describes as `info` could be paired: one mounted in /Volumes, where
 * macOS mounts the drives and disk images connected to it, on a drive that is external, or removable
 * and ejectable (such as an SD card in the Mac's own reader). Disk images are external to diskutil.
 * The Mac's own disk and its system volumes never are, nor are volumes macOS mounts out of sight
 * (such as Xcode's simulators).
 */
export function couldBePaired(info: Record<string, unknown>): boolean {
  const { Internal: internal, Ejectable: ejectable, RemovableMedia: removable, MountPoint: mountPoint } = info;
  const external = internal === false || (ejectable === true && removable === true);
  return external && typeof mountPoint === "string" && mountPoint.startsWith("/Volumes/");
}

/** The capacity, in bytes, of the volume diskutil describes as `info`, or 0 if it does not say. */
function sizeOf(info: Record<string, unknown>): number {
  const size = info.TotalSize ?? info.Size;
  return typeof size === "number" ? size : 0;
}

/** A mounted volume described by diskutil, or `undefined` if `entry` is not one with a volume UUID. */
function toVolume(entry: Record<string, unknown>): Volume | undefined {
  const { VolumeUUID: id, MountPoint: mountPoint, VolumeName: name } = entry;
  if (typeof id !== "string" || id === "" || typeof mountPoint !== "string" || mountPoint === "") {
    return undefined;
  }
  return { id, name: typeof name === "string" && name !== "" ? name : basename(mountPoint), mountPoint };
}

/** Runs diskutil with `args` (which must include `-plist`) and returns its output as JSON. */
export async function diskutilPlist(args: string[]): Promise<Record<string, unknown>> {
  const { stdout: plist } = await run("diskutil", args, { maxBuffer: 16 * 1024 * 1024 });
  const converting = run("plutil", ["-convert", "json", "-o", "-", "-"], { maxBuffer: 16 * 1024 * 1024 });
  converting.child.stdin!.end(plist);
  const { stdout: json } = await converting;
  return JSON.parse(json) as Record<string, unknown>;
}
