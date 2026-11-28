import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { benchmark, describeReadsAtOnce, readsAtOnceOf } from "../scripts/benchmark.ts";
import { MarkedDriveKind, markedIn, SOLID_STATE_READS } from "../src/engine/index.ts";
import { FakeDriveKind } from "./helpers/fake-drive-kind.ts";
import { FakeVolumes } from "./helpers/fake-volumes.ts";
import { makeTree, removeTrees, snapshotTree } from "./helpers/trees.ts";

after(removeTrees);

describe("the benchmark", () => {
  it("times a Quick compare: the drives' reading, with the items listed and the Replica's files judged by size and date, writing nothing", async () => {
    const primary = await makeTree({ "a.txt": "aaaa", "Docs/b.txt": "bb", "new.txt": "new" });
    const replica = await makeTree({ "a.txt": "aaaa", "Docs/b.txt": "bb" });
    const before = [await snapshotTree(primary), await snapshotTree(replica)];

    const timing = await benchmark(primary, replica, { deep: false });

    assert.equal(timing.deep, false);
    assert.ok(timing.seconds > 0);
    assert.equal(timing.replica.count, 2);
    assert.equal(timing.replica.totalSize, 6);
    const scanning = timing.phases.find((phase) => phase.phase === "scanning");
    // Primary: a.txt, new.txt, Docs, Docs/b.txt. Replica: a.txt, Docs, Docs/b.txt.
    assert.equal(scanning?.items, 7);
    assert.ok(scanning.seconds > 0 && scanning.seconds <= timing.seconds);
    assert.equal(timing.phases.some((phase) => phase.phase === "verifying"), false, "a Quick compare reads no contents");
    assert.deepEqual([await snapshotTree(primary), await snapshotTree(replica)], before);
  });

  it("times a Deep verify: the files verified and the bytes read on both drives, then the move candidates confirmed, writing nothing", async () => {
    const primary = await makeTree({ "a.txt": "aaaa", "Docs/b.txt": "bb", "changed.txt": "new", "Moved/m.txt": "move me" });
    const replica = await makeTree({ "a.txt": "aaaa", "Docs/b.txt": "bb", "changed.txt": "old!", "m.txt": "move me" });
    const before = [await snapshotTree(primary), await snapshotTree(replica)];

    const timing = await benchmark(primary, replica, { deep: true });

    assert.equal(timing.deep, true);
    assert.deepEqual(timing.phases.map((phase) => phase.phase), ["scanning", "verifying", "checking moves"]);
    const [, verifying, checkingMoves] = timing.phases;
    // a.txt and Docs/b.txt, on both drives. changed.txt differs in size, so is not read.
    assert.equal(verifying?.files, 2);
    assert.equal(verifying.bytes, 12);
    assert.equal(checkingMoves?.files, 1);
    assert.equal(checkingMoves.bytes, 14);
    const phaseSeconds = timing.phases.reduce((total, phase) => total + phase.seconds, 0);
    assert.ok(phaseSeconds <= timing.seconds);
    assert.deepEqual([await snapshotTree(primary), await snapshotTree(replica)], before);
  });

  it("limits both drives to one folder, leaving out the Exclusions", async () => {
    const primary = await makeTree({ "Docs/a.txt": "aaaa", "Docs/skip.tmp": "tmp", "Other/b.txt": "bb" });
    const replica = await makeTree({ "Docs/a.txt": "aaaa", "Docs/skip.tmp": "tmp", "Other/b.txt": "bb" });

    const timing = await benchmark(primary, replica, { deep: true, only: "Docs", exclusions: ["*.tmp"] });

    assert.deepEqual(timing.replica, { count: 1, totalSize: 4 });
    assert.equal(timing.phases.find((phase) => phase.phase === "verifying")?.files, 1);
  });
});

describe("the benchmark's files read at once", () => {
  it("says when a drive's number comes from the owner's Solid-state mark", () => {
    assert.equal(
      describeReadsAtOnce({ atOnce: 8, marked: false }, { atOnce: 8, marked: true }),
      "Files read at once, by whether each drive is solid state (ADR 0022): Primary 8, Replica 8 (marked as solid state)",
    );
    assert.equal(
      describeReadsAtOnce({ atOnce: 8, marked: false }, { atOnce: 1, marked: false }),
      "Files read at once, by whether each drive is solid state (ADR 0022): Primary 8, Replica 1",
    );
  });

  it("reads several files at once from a drive marked as solid state, as the app does", async () => {
    const primary = await makeTree({ "a.txt": "aaaa" });
    const replica = await makeTree({ "a.txt": "aaaa" });
    const volumes = new FakeVolumes({ [primary]: "PRIMARY-ID", [replica]: "REPLICA-ID" });
    const macOS = new FakeDriveKind(primary);
    macOS.set(replica, undefined);
    const pairing = { primary: { id: "PRIMARY-ID", name: "P" }, replica: { id: "REPLICA-ID", name: "R" } };
    const before = await snapshotTree(primary);

    const kind = new MarkedDriveKind(macOS, volumes, markedIn(pairing, ["REPLICA-ID"]));

    assert.deepEqual(await readsAtOnceOf(kind, primary, replica), [
      { atOnce: SOLID_STATE_READS, marked: false },
      { atOnce: SOLID_STATE_READS, marked: true },
    ]);
    const timing = await benchmark(primary, replica, { deep: true, driveKind: kind });
    assert.equal(timing.phases.find((phase) => phase.phase === "verifying")?.files, 1);
    assert.deepEqual(await snapshotTree(primary), before, "the Primary must never be written to");
  });
});
