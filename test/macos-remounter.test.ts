import assert from "node:assert/strict";
import { open, readFile, realpath, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { MacRemounter } from "../src/macos/remounter.ts";
import { MacVolumes } from "../src/macos/volume-identity.ts";
import { makeDiskImageTree, removeTrees } from "./helpers/trees.ts";

after(removeTrees);

/** A remounter that does not wait long between attempts, so a refusal is quick to test. */
const remounter = new MacRemounter({ retryDelayMs: 50 });

async function drive() {
  const path = await makeDiskImageTree({ "a.txt": "on the drive" });
  return new MacVolumes().volumeAt(path);
}

describe("Remounting on macOS", () => {
  it("remounts a drive read-only, as macOS confirms, and normally again, at the same mount point", async () => {
    const volume = await drive();

    const readOnly = await remounter.readOnly(volume);

    assert.deepEqual(readOnly, volume);
    assert.equal(await readFile(join(volume.mountPoint, "a.txt"), "utf8"), "on the drive");
    await assert.rejects(writeFile(join(volume.mountPoint, "b.txt"), "x"), { code: "EROFS" });

    const normal = await remounter.normally(readOnly);

    assert.deepEqual(normal, volume);
    await writeFile(join(volume.mountPoint, "b.txt"), "written");
    assert.equal(await realpath(volume.mountPoint), volume.mountPoint);
  });

  it("refuses, leaving the drive mounted normally, when it is in use and cannot be unmounted", async () => {
    const volume = await drive();
    const inUse = await open(join(volume.mountPoint, "a.txt"), "r+");
    try {
      await assert.rejects(remounter.readOnly(volume), /in use/);
    } finally {
      await inUse.close();
    }

    await writeFile(join(volume.mountPoint, "b.txt"), "still writable");
    assert.deepEqual(await new MacVolumes().volumeAt(volume.mountPoint), volume);
  });

  it("refuses, changing nothing, a drive whose volume ID is not the one at its mount point", async () => {
    const volume = await drive();

    await assert.rejects(remounter.readOnly({ ...volume, id: "NOT-THIS-DRIVE" }), /not the drive/);

    await writeFile(join(volume.mountPoint, "b.txt"), "still writable");
  });

  it("remounts a read-only drive normally even while a file on it is open", async () => {
    const volume = await drive();
    await remounter.readOnly(volume);
    const reading = await open(join(volume.mountPoint, "a.txt"), "r");
    try {
      await remounter.normally(volume);
    } finally {
      await reading.close().catch(() => {});
    }

    await writeFile(join(volume.mountPoint, "b.txt"), "written");
  });

  it("leaves a drive that was already read-only read-only afterwards", async () => {
    const volume = await drive();
    const run = promisify(execFile);
    await run("diskutil", ["unmount", volume.mountPoint]);
    await run("diskutil", ["mount", "readOnly", "-mountPoint", volume.mountPoint, volume.id]);

    await remounter.normally(await remounter.readOnly(volume));

    await assert.rejects(writeFile(join(volume.mountPoint, "b.txt"), "x"), { code: "EROFS" });
  });
});
