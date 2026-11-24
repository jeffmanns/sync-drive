import assert from "node:assert/strict";
import { basename } from "node:path";
import { after, describe, it } from "node:test";
import { findPairedDrives, pairDrives } from "../src/engine/index.ts";
import { FakeVolumes } from "./helpers/fake-volumes.ts";
import { makeTree, removeTrees } from "./helpers/trees.ts";

after(removeTrees);

describe("Pairing", () => {
  it("records the Primary and the Replica by their volume IDs", () => {
    const pairing = pairDrives(
      { id: "PRIMARY-ID", name: "Photos", mountPoint: "/Volumes/Photos" },
      { id: "REPLICA-ID", name: "Backup", mountPoint: "/Volumes/Backup" },
    );

    assert.deepEqual(pairing, { primary: { id: "PRIMARY-ID", name: "Photos" }, replica: { id: "REPLICA-ID", name: "Backup" } });
  });

  it("refuses to pair a drive with itself", () => {
    assert.throws(
      () => pairDrives({ id: "SAME-ID", name: "Photos", mountPoint: "/Volumes/Photos" }, { id: "SAME-ID", name: "Clone", mountPoint: "/Volumes/Clone" }),
      /same volume ID/,
    );
  });
});

describe("Finding the paired drives", () => {
  async function paired() {
    const primary = await makeTree();
    const replica = await makeTree();
    const other = await makeTree();
    const volumes = new FakeVolumes({ [primary]: "PRIMARY-ID", [other]: "OTHER-ID", [replica]: "REPLICA-ID" });
    const pairing = pairDrives(await volumes.volumeAt(primary), await volumes.volumeAt(replica));
    return { primary, replica, other, volumes, pairing };
  }

  it("finds the connected Primary and Replica by volume ID, even after a drive is renamed", async () => {
    const { primary, replica, volumes, pairing } = await paired();
    const renamedPrimary = await makeTree();
    volumes.disconnect(primary);
    volumes.connect(renamedPrimary, "PRIMARY-ID");

    const drives = await findPairedDrives(pairing, volumes);

    assert.equal(drives.primary.mountPoint, renamedPrimary);
    assert.equal(drives.replica.mountPoint, replica);
  });

  it("refuses, naming the drive, when the Primary or the Replica is not connected", async () => {
    const { primary, replica, volumes, pairing } = await paired();

    volumes.disconnect(replica);
    await assert.rejects(findPairedDrives(pairing, volumes), (error: Error) => {
      assert.match(error.message, /Replica/);
      assert.match(error.message, new RegExp(basename(replica)));
      assert.match(error.message, /not connected/);
      assert.doesNotMatch(error.message, /Primary/);
      return true;
    });

    volumes.disconnect(primary);
    await assert.rejects(findPairedDrives(pairing, volumes), /Primary.*Replica|Replica.*Primary/s);
  });

  it("refuses rather than guessing when two connected drives share a paired volume ID", async () => {
    const { volumes, pairing } = await paired();
    const clone = await makeTree();
    volumes.connect(clone, "REPLICA-ID");

    await assert.rejects(findPairedDrives(pairing, volumes), (error: Error) => {
      assert.match(error.message, /Replica/);
      assert.match(error.message, new RegExp(clone));
      return true;
    });
  });
});
