import assert from "node:assert/strict";
import { basename } from "node:path";
import { after, describe, it } from "node:test";
import { findPairedDrives, pair } from "../src/engine/index.ts";
import { FakeVolumes } from "./helpers/fake-volumes.ts";
import { makeTree, removeTrees } from "./helpers/trees.ts";

after(removeTrees);

describe("Pairing", () => {
  it("records the Primary and the Replica by their volume IDs", async () => {
    const primary = await makeTree();
    const replica = await makeTree();
    const volumes = new FakeVolumes({ [primary]: "PRIMARY-ID", [replica]: "REPLICA-ID" });

    const pairing = await pair(primary, replica, volumes);

    assert.equal(pairing.primary.id, "PRIMARY-ID");
    assert.equal(pairing.replica.id, "REPLICA-ID");
  });

  it("refuses to pair a drive with itself", async () => {
    const drive = await makeTree();
    const sameDriveElsewhere = await makeTree();
    const volumes = new FakeVolumes({ [drive]: "SAME-ID", [sameDriveElsewhere]: "SAME-ID" });

    await assert.rejects(pair(drive, sameDriveElsewhere, volumes), /same drive/);
  });
});

describe("Finding the paired drives", () => {
  async function paired() {
    const primary = await makeTree();
    const replica = await makeTree();
    const other = await makeTree();
    const volumes = new FakeVolumes({ [primary]: "PRIMARY-ID", [other]: "OTHER-ID", [replica]: "REPLICA-ID" });
    const pairing = await pair(primary, replica, volumes);
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

  it("accepts drives given by path when they match the Pairing", async () => {
    const { primary, replica, volumes, pairing } = await paired();

    const drives = await findPairedDrives(pairing, volumes, { primary, replica });

    assert.equal(drives.primary.mountPoint, primary);
    assert.equal(drives.replica.mountPoint, replica);
  });

  it("refuses drives given by path when their roles are swapped", async () => {
    const { primary, replica, volumes, pairing } = await paired();

    await assert.rejects(
      findPairedDrives(pairing, volumes, { primary: replica, replica: primary }),
      /swapped/,
    );
  });

  it("refuses a drive given by path that is not the one paired in that role", async () => {
    const { primary, replica, other, volumes, pairing } = await paired();

    await assert.rejects(findPairedDrives(pairing, volumes, { primary, replica: other }), (error: Error) => {
      assert.match(error.message, new RegExp(`${other} is not the paired Replica`));
      return true;
    });
    await assert.rejects(
      findPairedDrives(pairing, volumes, { primary: other, replica }),
      new RegExp(`${other} is not the paired Primary`),
    );
    await assert.rejects(
      findPairedDrives(pairing, volumes, { primary: replica, replica }),
      new RegExp(`${replica} is not the paired Primary`),
    );
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
