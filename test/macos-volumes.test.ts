import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { MacItemCounter } from "../src/macos/item-counter.ts";
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

  it("offers mounted disk images for Pairing, with their size, but never the Mac's own disk or its system volumes", async () => {
    const drive = await makeDiskImageTree({}, { name: "Rehearsal", size: "40m" });
    const volumes = new MacVolumes();
    const image = await volumes.volumeAt(drive);

    const candidates = await volumes.candidates();

    const offered = candidates.find((candidate) => candidate.id === image.id);
    assert.deepEqual(offered && { ...offered, size: undefined }, { ...image, size: undefined });
    assert.ok(offered!.size > 30_000_000 && offered!.size <= 42_000_000, `size ${offered!.size}`);
    const own = await volumes.volumeAt("/");
    assert.equal(candidates.find((candidate) => candidate.id === own.id), undefined);
    for (const candidate of candidates) {
      assert.ok(candidate.mountPoint !== "/" && !candidate.mountPoint.startsWith("/System/Volumes/"), candidate.mountPoint);
    }
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

describe("Item counts on macOS", () => {
  it("counts a drive's files plus folders without reading its folders", async () => {
    // Photos, Photos/2026, two photos, and notes.txt.
    const drive = await makeDiskImageTree({ "Photos/2026/a.jpg": "a", "Photos/2026/b.jpg": "b", "notes.txt": "n" });

    assert.equal(await new MacItemCounter().itemCount(drive), 5);
  });

  it("gives no usable count for a file system that keeps none, such as FAT and exFAT", async () => {
    for (const fileSystem of ["MS-DOS", "ExFAT"]) {
      const drive = await makeDiskImageTree({ "Photos/a.jpg": "a" }, { fileSystem, size: "40m", name: "SDTEST" });

      assert.equal(await new MacItemCounter().itemCount(drive), undefined, fileSystem);
    }
  });

  it("gives no usable count, rather than rejecting, for a drive that is not there", async () => {
    assert.equal(await new MacItemCounter().itemCount(join(await makeTree(), "gone")), undefined);
  });
});
