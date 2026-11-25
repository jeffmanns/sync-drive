import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createRehearsal, removeRehearsal } from "../scripts/rehearsal.ts";
import { MacVolumes } from "../src/macos/volume-identity.ts";
import { makeTree, removeTrees, snapshotTree } from "./helpers/trees.ts";

const NAMES = { primary: "Rehearsal Test Primary", replica: "Rehearsal Test Replica" };

const folders: string[] = [];
after(async () => {
  for (const folder of folders) await removeRehearsal({ folder });
  await removeTrees();
});

/** A fresh folder for a rehearsal's disk images (and, in use, the app's Pairing). */
async function rehearsalFolder(): Promise<string> {
  const folder = join(await makeTree(), "rehearsal");
  folders.push(folder);
  return folder;
}

describe("the rehearsal kit", () => {
  it("creates two drives that Pairing offers, the Primary seeded from the chosen folder, which is left unchanged", async () => {
    const source = await makeTree({ "Photos/a.jpg": "photo", "Docs/notes.txt": "notes", "top.txt": "top" });
    const sourceBefore = await snapshotTree(source);
    const folder = await rehearsalFolder();

    const { primary, replica } = await createRehearsal({ folder, source, names: NAMES });

    const offered = await new MacVolumes().candidates();
    const offeredPrimary = offered.find((drive) => drive.mountPoint === primary.mountPoint);
    const offeredReplica = offered.find((drive) => drive.mountPoint === replica.mountPoint);
    assert.equal(offeredPrimary?.name, NAMES.primary);
    assert.equal(offeredReplica?.name, NAMES.replica);
    assert.equal(offeredPrimary.writable, true, "the Primary is mounted normally, so the Update's read-only remount is rehearsed");
    assert.equal(offeredReplica.writable, true);
    assert.notEqual(offeredPrimary.id, offeredReplica.id);
    assert.equal(await readFile(join(primary.mountPoint, "Photos/a.jpg"), "utf8"), "photo");
    assert.equal(await readFile(join(primary.mountPoint, "Docs/notes.txt"), "utf8"), "notes");
    assert.equal(await readFile(join(primary.mountPoint, "top.txt"), "utf8"), "top");
    await assert.rejects(access(join(replica.mountPoint, "top.txt")), "the Replica starts empty");
    assert.deepEqual(await snapshotTree(source), sourceBefore);
  });

  it("removes the drives and the rehearsal folder, and does nothing when run again", async () => {
    const folder = await rehearsalFolder();
    const { primary, replica } = await createRehearsal({ folder, source: await makeTree({ "a.txt": "a" }), names: NAMES });

    const removed = await removeRehearsal({ folder });

    assert.deepEqual(removed?.map((drive) => drive.id).sort(), [primary.id, replica.id].sort());
    const connected = (await new MacVolumes().connected()).map((volume) => volume.id);
    assert.ok(!connected.includes(primary.id) && !connected.includes(replica.id), "both drives are ejected");
    await assert.rejects(access(folder), "the rehearsal folder is gone");
    assert.equal(await removeRehearsal({ folder }), undefined);
  });

  it("refuses to create a second rehearsal in the same folder", async () => {
    const folder = await rehearsalFolder();
    await createRehearsal({ folder, source: await makeTree({ "a.txt": "a" }), names: NAMES });

    await assert.rejects(createRehearsal({ folder, source: await makeTree(), names: NAMES }), /already exists/);
  });

  it("leaves alone a folder the kit did not make", async () => {
    const folder = await makeTree({ "keep.txt": "mine" });

    await assert.rejects(removeRehearsal({ folder }), /not made by the rehearsal kit/);
    assert.equal(await readFile(join(folder, "keep.txt"), "utf8"), "mine");
  });
});
