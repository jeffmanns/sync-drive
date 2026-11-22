import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import type { Remounter, Volume } from "../engine/index.ts";
import { diskutilPlist } from "./volume-identity.ts";

const run = promisify(execFile);

/** How often an unmount is tried before giving up: macOS (Spotlight, fseventsd) can hold a drive for a moment. */
const UNMOUNT_ATTEMPTS = 5;

/** A mounted drive as diskutil reports it. */
interface Mounted {
  volume: Volume;
  /** The disk identifier, e.g. `disk4s1`. Used only between unmounting and mounting again. */
  device: string;
  /** macOS's own word on whether the drive can be written to: `undefined` when it does not say. */
  writable: boolean | undefined;
}

/**
 * Remounts drives with `diskutil`: unmounts, then mounts again read-only or normally, and reads back
 * from macOS what it actually did. Needs no administrator rights. A drive in use is never forced off
 * while it can be written to; only a drive confirmed read-only is, as nothing on it can be lost.
 */
export class MacRemounter implements Remounter {
  readonly #retryDelayMs: number;

  constructor({ retryDelayMs = 500 }: { retryDelayMs?: number } = {}) {
    this.#retryDelayMs = retryDelayMs;
  }

  async readOnly(volume: Volume): Promise<Volume> {
    const before = await mountedAt(volume);
    // Already read-only, as macOS confirms: nothing to do.
    if (before.writable === false) return before.volume;
    await this.#unmount(before, { force: false });
    try {
      const after = await mount(before, { readOnly: true });
      // `diskutil mount readOnly` can succeed and still leave a drive writable: only macOS's own word counts.
      if (after.writable !== false) throw new Error("macOS mounted it again but does not confirm it is read-only.");
      return after.volume;
    } catch (error) {
      await this.#putBack(before).catch(() => {});
      throw new Error(`${volume.name} could not be remounted read-only: ${messageOf(error)}`, { cause: error });
    }
  }

  async normally(volume: Volume): Promise<Volume> {
    const before = await mountedAt(volume);
    if (before.writable === true) return before.volume;
    try {
      // Forced only when confirmed read-only: then nothing written to it can be lost.
      await this.#unmount(before, { force: before.writable === false });
      const after = await mount(before, { readOnly: false });
      if (after.writable !== true) throw new Error("macOS mounted it again but does not confirm it can be written to.");
      return after.volume;
    } catch (error) {
      throw new Error(
        `${volume.name} could not be remounted normally, so it may still be read-only: ${messageOf(error)} Eject it and connect it again.`,
        { cause: error },
      );
    }
  }

  /** Mounts `drive` normally again after a failed attempt to make it read-only, wherever it is now. */
  async #putBack(drive: Mounted): Promise<void> {
    const now = await diskutilPlist(["info", "-plist", drive.device]);
    if (typeof now.MountPoint === "string" && now.MountPoint !== "") {
      if (now.WritableVolume === true) return;
      await this.#unmount(drive, { force: now.WritableVolume === false });
    }
    await mount(drive, { readOnly: false });
  }

  /** Unmounts `drive`, trying again a few times while macOS holds it. */
  async #unmount(drive: Mounted, { force }: { force: boolean }): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await run("diskutil", ["unmount", ...(force ? ["force"] : []), drive.device]);
        return;
      } catch (error) {
        if (attempt === UNMOUNT_ATTEMPTS) {
          throw new Error(`macOS could not unmount it because it is in use. ${outputOf(error)}`, { cause: error });
        }
        await new Promise((resolve) => setTimeout(resolve, this.#retryDelayMs * attempt));
      }
    }
  }
}

/** `volume` as mounted now. Rejects if a different drive, or none, is mounted at its mount point. */
async function mountedAt(volume: Volume): Promise<Mounted> {
  const info = await diskutilPlist(["info", "-plist", volume.mountPoint]).catch((error: unknown) => {
    throw new Error(`${volume.name} is not mounted at ${volume.mountPoint}.`, { cause: error });
  });
  if (info.VolumeUUID !== volume.id || info.MountPoint !== volume.mountPoint || typeof info.DeviceIdentifier !== "string") {
    throw new Error(`The drive mounted at ${volume.mountPoint} is not the drive ${volume.name}.`);
  }
  return { volume, device: info.DeviceIdentifier, writable: writableOf(info) };
}

/**
 * Mounts the unmounted `drive` again, at its old mount point when that folder is still there (macOS
 * removes the ones it made in /Volumes, and then picks the same place again itself). Resolves with
 * the drive as macOS now reports it, after checking it is still the same drive.
 */
async function mount(drive: Mounted, { readOnly }: { readOnly: boolean }): Promise<Mounted> {
  const { volume, device } = drive;
  const keepMountPoint = await access(volume.mountPoint).then(
    () => true,
    () => false,
  );
  try {
    await run("diskutil", ["mount", ...(readOnly ? ["readOnly"] : []), ...(keepMountPoint ? ["-mountPoint", volume.mountPoint] : []), device]);
  } catch (error) {
    throw new Error(`macOS could not mount it again. ${outputOf(error)}`, { cause: error });
  }
  const info = await diskutilPlist(["info", "-plist", device]);
  const { VolumeUUID: id, MountPoint: mountPoint } = info;
  if (id !== volume.id || typeof mountPoint !== "string" || mountPoint === "") {
    throw new Error(`macOS does not report ${volume.name} mounted again.`);
  }
  return { volume: { ...volume, mountPoint }, device, writable: writableOf(info) };
}

/** Whether diskutil reports the volume writable: `undefined` when it does not say. */
function writableOf(info: Record<string, unknown>): boolean | undefined {
  return typeof info.WritableVolume === "boolean" ? info.WritableVolume : undefined;
}

/** What a failed command said, for messages. */
function outputOf(error: unknown): string {
  const failed = error as { stderr?: string; stdout?: string; message?: string };
  return (failed.stderr?.trim() || failed.stdout?.trim() || failed.message || String(error)).replace(/\s+/g, " ");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
