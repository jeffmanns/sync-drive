import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import {
  compare,
  MarkedDriveKind,
  markedIn,
  readsAtOnce,
  readSolidStateMarks,
  SOLID_STATE_READS,
  solidStateMarksFileBeside,
  writeSolidStateMarks,
  Sha256Hasher,
  type Hasher,
  type Pairing,
} from "../src/engine/index.ts";
import { FakeDriveKind } from "./helpers/fake-drive-kind.ts";
import { FakeVolumes } from "./helpers/fake-volumes.ts";
import { makeTree, removeTrees, snapshotTree } from "./helpers/trees.ts";

after(removeTrees);

const PAIRING: Pairing = { primary: { id: "PRIMARY-ID", name: "Photos" }, replica: { id: "REPLICA-ID", name: "Backup 1TB" } };

/** A Primary and a Replica connected with the Pairing's volume IDs, and what macOS says of each: unknown unless set. */
function drives(primary = "/Volumes/Photos", replica = "/Volumes/Backup 1TB") {
  const volumes = new FakeVolumes({ [primary]: "PRIMARY-ID", [replica]: "REPLICA-ID" });
  const macOS = new FakeDriveKind();
  macOS.set(primary, undefined);
  macOS.set(replica, undefined);
  return { primary, replica, volumes, macOS };
}

describe("A drive marked as solid state by the owner", () => {
  it("has several files read at once when macOS cannot tell its kind; an unmarked one still has one", async () => {
    const { primary, replica, volumes, macOS } = drives();
    const kind = new MarkedDriveKind(macOS, volumes, markedIn(PAIRING, ["REPLICA-ID"]));

    assert.equal(await readsAtOnce(kind, replica), SOLID_STATE_READS);
    assert.equal(await readsAtOnce(kind, primary), 1);
    assert.deepEqual(await kind.kindOf(replica), { solidState: true, marked: true });
    assert.deepEqual(await kind.kindOf(primary), { solidState: undefined, marked: false });
  });

  it("never overrides macOS's own answer: a drive macOS calls spinning stays at one file, and one it calls solid state is not 'marked'", async () => {
    const { primary, replica, volumes, macOS } = drives();
    macOS.set(primary, true);
    macOS.set(replica, false);
    const kind = new MarkedDriveKind(macOS, volumes, markedIn(PAIRING, ["PRIMARY-ID", "REPLICA-ID"]));

    assert.equal(await readsAtOnce(kind, replica), 1);
    assert.deepEqual(await kind.kindOf(replica), { solidState: false, marked: false });
    assert.deepEqual(await kind.kindOf(primary), { solidState: true, marked: false });
  });

  it("follows the drive by Volume ID, not its name or where it is mounted", async () => {
    const { volumes, macOS } = drives("/Volumes/Photos", "/Volumes/Renamed backup");
    const kind = new MarkedDriveKind(macOS, volumes, markedIn(PAIRING, ["REPLICA-ID"]));

    assert.equal(await readsAtOnce(kind, "/Volumes/Renamed backup"), SOLID_STATE_READS);
  });

  it("ignores a mark on a drive that is not in the current Pairing, or when there is no Pairing", async () => {
    const { replica, volumes, macOS } = drives();
    const other: Pairing = { primary: { id: "PRIMARY-ID", name: "Photos" }, replica: { id: "OTHER-ID", name: "Other" } };

    assert.equal(await readsAtOnce(new MarkedDriveKind(macOS, volumes, markedIn(other, ["REPLICA-ID"])), replica), 1);
    assert.equal(await readsAtOnce(new MarkedDriveKind(macOS, volumes, markedIn(undefined, ["REPLICA-ID"])), replica), 1);
  });

  it("is taken as not marked when the drive's Volume ID cannot be read", async () => {
    const { macOS, volumes } = drives();
    macOS.set("/Volumes/Gone", undefined);
    const kind = new MarkedDriveKind(macOS, volumes, () => true);

    assert.deepEqual(await kind.kindOf("/Volumes/Gone"), { solidState: undefined, marked: false });
  });

  it("gives a Deep verify the same Report with or without the mark, reading several Replica files at once with it", async () => {
    const spec = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`Docs/file${i}.txt`, `contents ${i}`]));
    const primary = await makeTree({ ...spec, "new.txt": "new", "Moved/m.txt": "move me" });
    const replica = await makeTree({ ...spec, "Docs/file3.txt": "damaged!!!", "m.txt": "move me", "gone.txt": "gone" });
    const before = await snapshotTree(primary);
    const volumes = new FakeVolumes({ [primary]: "PRIMARY-ID", [replica]: "REPLICA-ID" });
    const macOS = new FakeDriveKind();
    macOS.set(primary, undefined);
    macOS.set(replica, undefined);
    const run = async (marks: string[]) => {
      const onReplica = { running: 0, most: 0 };
      const inner = new Sha256Hasher();
      const hasher: Hasher = {
        async checksum(path, onRead) {
          // The Replica is the drive the ticket is for: it sets the pace for both.
          const counts = path.startsWith(replica + "/") ? onReplica : { running: 0, most: 0 };
          counts.running++;
          counts.most = Math.max(counts.most, counts.running);
          try {
            await new Promise((resolve) => setTimeout(resolve, 2));
            return await inner.checksum(path, onRead);
          } finally {
            counts.running--;
          }
        },
      };
      const report = await compare(primary, replica, { deep: true, hasher, driveKind: new MarkedDriveKind(macOS, volumes, markedIn(PAIRING, marks)) });
      return { report, most: onReplica.most };
    };

    const [marked, unmarked] = [await run(["PRIMARY-ID", "REPLICA-ID"]), await run([])];

    assert.deepEqual(marked.report, unmarked.report);
    assert.equal(unmarked.most, 1);
    assert.ok(marked.most > 2, `${marked.most} Replica files read at once`);
    assert.equal(marked.report.anomalies.contentMismatch.count, 1);
    assert.deepEqual(await snapshotTree(primary), before, "the Primary must never be written to");
  });
});

describe("The solid-state marks file", () => {
  it("is kept beside the Pairing", () => {
    assert.equal(solidStateMarksFileBeside("/Mac/sync-drive/pairing.json"), "/Mac/sync-drive/solid-state-marks.json");
  });

  it("keeps the marked Volume IDs", async () => {
    const file = join(await makeTree(), "sync-drive", "solid-state-marks.json");

    await writeSolidStateMarks(file, ["REPLICA-ID"]);

    assert.deepEqual(await readSolidStateMarks(file), ["REPLICA-ID"]);
    await writeSolidStateMarks(file, []);
    assert.deepEqual(await readSolidStateMarks(file), []);
  });

  it("means no marks when it is missing or damaged, never a refusal", async () => {
    const folder = await makeTree();
    const file = join(folder, "solid-state-marks.json");
    assert.deepEqual(await readSolidStateMarks(file), []);

    for (const damaged of ["{not json", "null", '{"solidState": "REPLICA-ID"}', '{"solidState": [1, "REPLICA-ID"]}', '["REPLICA-ID"]']) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, damaged);
      assert.deepEqual(await readSolidStateMarks(file), [], damaged);
    }
  });

  it("can be saved over a damaged file", async () => {
    const file = join(await makeTree(), "solid-state-marks.json");
    await writeFile(file, "{not json");

    await writeSolidStateMarks(file, ["REPLICA-ID"]);

    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { solidState: ["REPLICA-ID"] });
  });
});
