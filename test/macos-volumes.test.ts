import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { MacVolumes } from "../src/macos/volume-identity.ts";
import { makeDiskImageTree, makeTree, removeTrees } from "./helpers/trees.ts";

after(removeTrees);

const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

describe("Volume identity on macOS", () => {
  it("reads a drive's volume UUID and name, and lists it among the connected drives", async () => {
    const drive = await makeDiskImageTree({}, { name: "Holiday Photos" });
    const volumes = new MacVolumes();

    const volume = await volumes.volumeAt(drive);

    assert.match(volume.id, UUID);
    assert.equal(volume.name, "Holiday Photos");
    assert.equal(volume.mountPoint, await realpath(drive));
    assert.deepEqual(
      (await volumes.connected()).filter((connected) => connected.id === volume.id),
      [volume],
    );
  });

  it("tells two drives apart, and keeps a drive's ID when it is renamed", async () => {
    const first = await makeDiskImageTree({}, { name: "First" });
    const second = await makeDiskImageTree({}, { name: "Second" });
    const volumes = new MacVolumes();
    const before = await volumes.volumeAt(first);

    await promisify(execFile)("diskutil", ["rename", first, "Renamed"]);

    const after = await volumes.volumeAt(first);
    assert.equal(after.id, before.id);
    assert.equal(after.name, "Renamed");
    assert.notEqual((await volumes.volumeAt(second)).id, before.id);
  });

  it("refuses a folder that is not the top level of a drive", async () => {
    const drive = await makeDiskImageTree();
    const inside = join(drive, "Photos");
    await mkdir(inside);
    const volumes = new MacVolumes();

    await assert.rejects(volumes.volumeAt(inside), /not the top level of a drive/);
    await assert.rejects(volumes.volumeAt(await makeTree()), /not the top level of a drive/);
    await assert.rejects(volumes.volumeAt(join(drive, "missing")), /missing/);
  });
});
