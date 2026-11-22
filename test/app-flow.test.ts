import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { Flow } from "../src/app/flow.ts";
import { compare, type FileCopier } from "../src/engine/index.ts";
import { MacFileCopier } from "../src/macos/file-copier.ts";
import { FakeVolumes } from "./helpers/fake-volumes.ts";
import { makeDiskImageTree, makeTree, removeTrees, snapshotTree, type TreeSpec } from "./helpers/trees.ts";

after(removeTrees);

/** Every Primary a test made, with its snapshot from before the flow saw it. */
const primaries: { path: string; before: string[] }[] = [];

/** Makes a Primary with `spec`, which every test then checks was never written to. */
async function makePrimary(spec: TreeSpec = {}): Promise<string> {
  const path = await makeTree(spec);
  primaries.push({ path, before: await snapshotTree(path) });
  return path;
}

afterEach(async () => {
  for (const { path, before } of primaries.splice(0)) {
    assert.deepEqual(await snapshotTree(path), before, "the Primary must never be written to");
  }
});

/** A Mac with its own place for the Pairing and its own connected drives, and the app's flow on it. */
async function testMac(copier: FileCopier = new MacFileCopier()) {
  const volumes = new FakeVolumes();
  const pairingFile = join(await makeTree(), "sync-drive", "pairing.json");
  const open = async () => {
    const flow = new Flow({ volumes, pairingFile, copier });
    await flow.open();
    return flow;
  };
  return { volumes, pairingFile, open };
}

describe("app flow: opening", () => {
  it("opens on Pairing when no Pairing is saved", async () => {
    const mac = await testMac();

    const flow = await mac.open();

    assert.equal(flow.state.step, "pairing");
  });
});

describe("app flow: Pairing", () => {
  it("pairs the chosen drives, saves the Pairing, and moves on to Start", async () => {
    const mac = await testMac();
    const primary = await makePrimary();
    const replica = await makeTree();
    mac.volumes.connect(primary, "PRIMARY-ID");
    mac.volumes.connect(replica, "REPLICA-ID");
    const flow = await mac.open();

    flow.choose("primary", primary);
    flow.choose("replica", replica);
    await flow.pair();

    const expected = { primary: { id: "PRIMARY-ID", name: basename(primary) }, replica: { id: "REPLICA-ID", name: basename(replica) } };
    assert.deepEqual(flow.state, { step: "start", pairing: expected });
    assert.deepEqual((await mac.open()).state, { step: "start", pairing: expected }, "remembered when the app opens again");
  });

  it("stays on Pairing, saying why and saving nothing, when both choices are the same drive", async () => {
    const mac = await testMac();
    const drive = await makePrimary();
    mac.volumes.connect(drive, "SAME-ID");
    const flow = await mac.open();

    flow.choose("primary", drive);
    flow.choose("replica", drive);
    await flow.pair();

    assert.equal(flow.state.step, "pairing");
    assert.match(flow.state.step === "pairing" ? flow.state.error ?? "" : "", /same drive/);
    assert.equal((await mac.open()).state.step, "pairing");
  });
});

/** A Mac with two drives holding these trees, connected and paired, and the flow opened on Start. */
async function pairedMac(primarySpec: TreeSpec = {}, replicaSpec: TreeSpec = {}, copier?: FileCopier) {
  const mac = await testMac(copier);
  const primary = await makePrimary(primarySpec);
  const replica = await makeTree(replicaSpec);
  mac.volumes.connect(primary, "PRIMARY-ID");
  mac.volumes.connect(replica, "REPLICA-ID");
  const flow = await mac.open();
  flow.choose("primary", primary);
  flow.choose("replica", replica);
  await flow.pair();
  assert.equal(flow.state.step, "start");
  return { ...mac, flow, primary, replica };
}

describe("app flow: Re-pair", () => {
  it("replaces the Pairing only after the extra confirmation", async () => {
    const { flow, volumes, open, primary } = await pairedMac();
    const newReplica = await makeTree();
    volumes.connect(newReplica, "NEW-REPLICA-ID");

    flow.beginRepair();
    assert.equal(flow.state.step, "pairing");
    flow.choose("primary", primary);
    flow.choose("replica", newReplica);
    await flow.pair();

    assert.equal(flow.state.step, "pairing", "not replaced without the confirmation");
    assert.match(flow.state.step === "pairing" ? flow.state.error ?? "" : "", /confirm/i);
    assert.equal(stateOf(await open()).pairing?.replica.id, "REPLICA-ID");

    flow.confirmReplace(true);
    await flow.pair();

    assert.equal(stateOf(flow).step, "start");
    assert.equal(stateOf(flow).pairing?.replica.id, "NEW-REPLICA-ID");
    assert.equal(stateOf(await open()).pairing?.replica.id, "NEW-REPLICA-ID");
  });

  it("goes back to Start, keeping the Pairing, when Re-pair is cancelled", async () => {
    const { flow } = await pairedMac();

    flow.beginRepair();
    flow.cancelRepair();

    assert.equal(stateOf(flow).step, "start");
    assert.equal(stateOf(flow).pairing?.replica.id, "REPLICA-ID");
  });

  it("opens on Pairing, as a replacement that needs confirming, when the saved Pairing is damaged", async () => {
    const { pairingFile, open, primary, replica } = await pairedMac();
    await writeFile(pairingFile, "{ not json");

    const flow = await open();

    assert.equal(flow.state.step, "pairing");
    assert.match(flow.state.step === "pairing" ? flow.state.error ?? "" : "", /damaged/);
    flow.choose("primary", primary);
    flow.choose("replica", replica);
    await flow.pair();
    assert.equal(await readFile(pairingFile, "utf8"), "{ not json");
    flow.confirmReplace(true);
    await flow.pair();
    assert.equal(stateOf(flow).step, "start");
  });
});

/** The flow's state, loosened so tests can read any step's fields. */
function stateOf(flow: Flow): Record<string, any> {
  return flow.state;
}

/** The CLI's example drives: two new files and one changed, and one file only on the Replica. */
const EXAMPLE_PRIMARY: TreeSpec = {
  "Photos/2026/a.jpg": "x".repeat(1_500_000),
  "Photos/2026/b.jpg": "12345",
  "readme.txt": "changed!",
};
const EXAMPLE_REPLICA: TreeSpec = { "readme.txt": "old", "Docs/old.pdf": "abc" };

describe("app flow: Comparing and Copies", () => {
  it("compares the paired drives, showing Comparing meanwhile, then the new and changed files by folder", async () => {
    const { flow, primary, replica } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    const steps: string[] = [];
    flow.onChange((state) => steps.push(state.step));

    await flow.compare();

    assert.deepEqual(steps, ["comparing", "copies"]);
    const { review } = stateOf(flow);
    assert.equal(review.drives.primary.mountPoint, primary);
    assert.equal(review.drives.replica.mountPoint, replica);
    assert.deepEqual(review.new.folders, [
      {
        folder: "Photos/2026",
        count: 2,
        totalSize: 1_500_005,
        files: [
          { path: "Photos/2026/a.jpg", size: 1_500_000 },
          { path: "Photos/2026/b.jpg", size: 5 },
        ],
      },
    ]);
    assert.deepEqual(review.changed.files, [{ path: "readme.txt", size: 8 }]);
    assert.deepEqual(review.deleted, { count: 1, totalSize: 3 });
    assert.equal(review.copiesApproved, false, "nothing is approved until the owner approves it");
  });

  it("stays on Start, saying why, when a paired drive is not connected", async () => {
    const { flow, volumes, replica } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    volumes.disconnect(replica);

    await flow.compare();

    assert.equal(stateOf(flow).step, "start");
    assert.match(stateOf(flow).error, /Replica .* is not connected/);
  });

  it("says so on Start, asking nothing, when the Replica matches the Primary", async () => {
    const { flow } = await pairedMac({ "a.txt": "same" }, { "a.txt": "same" });

    await flow.compare();

    assert.equal(stateOf(flow).step, "start");
    assert.match(stateOf(flow).notice, /matches the Primary/);
  });
});

describe("app flow: Approval, Summary and Apply", () => {
  it("with the copies approved, copies exactly the new and changed files, and leaves the deleted ones", async () => {
    const { flow, primary, replica } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    const primaryBefore = await snapshotTree(primary);
    await flow.compare();

    flow.approveCopies(true);
    flow.next();

    assert.equal(stateOf(flow).step, "summary");
    assert.deepEqual(stateOf(flow).apply, {
      copy: { count: 3, totalSize: 1_500_013 },
      leaveOnReplica: { count: 1, totalSize: 3 },
    });
    const steps: string[] = [];
    flow.onChange((state) => steps.push(state.step));
    await flow.apply();

    assert.deepEqual(steps, ["updating", "result"]);
    assert.deepEqual(stateOf(flow).copied, [
      { path: "Photos/2026/a.jpg", size: 1_500_000 },
      { path: "Photos/2026/b.jpg", size: 5 },
      { path: "readme.txt", size: 8 },
    ]);
    assert.deepEqual(stateOf(flow).failed, []);
    assert.deepEqual(stateOf(flow).leftOnReplica, { count: 1, totalSize: 3 });
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
    assert.equal(await readFile(join(replica, "readme.txt"), "utf8"), "changed!");
    const after = await compare(primary, replica);
    assert.equal(after.new.count + after.changed.count, 0);
    assert.deepEqual(after.deleted.files, [{ path: "Docs/old.pdf", size: 3 }]);
  });

  it("without the Approval, says Apply would copy nothing, and writes nothing", async () => {
    const { flow, primary, replica } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    const primaryBefore = await snapshotTree(primary);
    const replicaBefore = await snapshotTree(replica);
    await flow.compare();

    flow.next();
    assert.equal(stateOf(flow).step, "summary");
    assert.deepEqual(stateOf(flow).apply.copy, { count: 0, totalSize: 0 });
    await flow.apply();

    assert.equal(stateOf(flow).step, "summary", "there is nothing to apply");
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("lists every file that was not copied, and why", async () => {
    const real = new MacFileCopier();
    const failing: FileCopier = {
      copy: (source, destination) =>
        source.endsWith(".jpg") ? Promise.reject(new Error("the drive is full")) : real.copy(source, destination),
    };
    const { flow, primary, replica } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA, failing);
    await flow.compare();
    flow.approveCopies(true);
    flow.next();

    await flow.apply();

    assert.deepEqual(stateOf(flow).copied, [{ path: "readme.txt", size: 8 }]);
    assert.deepEqual(stateOf(flow).failed, [
      { path: "Photos/2026/a.jpg", size: 1_500_000, reason: "the drive is full" },
      { path: "Photos/2026/b.jpg", size: 5, reason: "the drive is full" },
    ]);
    const after = await compare(primary, replica);
    assert.equal(after.new.count, 2);
  });

  it("keeps the Approval through Back and Next", async () => {
    const { flow } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    await flow.compare();

    flow.approveCopies(true);
    flow.next();
    flow.back();
    assert.equal(stateOf(flow).step, "copies");
    assert.equal(stateOf(flow).review.copiesApproved, true);
    flow.next();
    assert.equal(stateOf(flow).apply.copy.count, 3);

    flow.back();
    flow.approveCopies(false);
    flow.next();
    assert.equal(stateOf(flow).apply.copy.count, 0);
  });

  it("has no going back once Apply starts, and discards the decisions for the next comparison", async () => {
    const { flow, replica } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    await flow.compare();
    flow.approveCopies(true);
    flow.next();
    await flow.apply();

    flow.back();
    assert.equal(stateOf(flow).step, "result");

    flow.restart();
    assert.equal(stateOf(flow).step, "start");
    await writeFile(join(replica, "readme.txt"), "changed on the Replica");
    await flow.compare();
    assert.equal(stateOf(flow).step, "copies");
    assert.equal(stateOf(flow).review.copiesApproved, false);
  });

  it("starts over from Start, discarding the decisions, from any review step", async () => {
    const { flow } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    await flow.compare();
    flow.approveCopies(true);
    flow.next();

    flow.restart();
    assert.equal(stateOf(flow).step, "start");
    await flow.compare();
    assert.equal(stateOf(flow).review.copiesApproved, false);
  });
});

/** `count` one-byte files named `<prefix>0.txt`, `<prefix>1.txt`, … */
function files(prefix: string, count: number): TreeSpec {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}.txt`, "x"]));
}

describe("app flow: refusals", () => {
  it("stops with the refusal, before any Approval, when the Safety stop applies, and writes nothing", async () => {
    const { flow, primary, replica } = await pairedMac(
      { ...files("kept/", 99), "new.txt": "new" },
      { ...files("kept/", 99), ...files("gone/", 101) },
    );
    const primaryBefore = await snapshotTree(primary);
    const replicaBefore = await snapshotTree(replica);

    await flow.compare();

    assert.equal(stateOf(flow).step, "refused");
    assert.match(stateOf(flow).reasons.join("\n"), /Safety stop applies: 101 files \(101 B\) would go into the Holding area, more than 10% of the Replica/);
    flow.next();
    flow.approveCopies(true);
    await flow.apply();
    assert.equal(stateOf(flow).step, "refused", "no way past the refusal");
    flow.restart();
    assert.equal(stateOf(flow).step, "start");
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("stops with the refusal when the Replica lacks the free space for the copies, and writes nothing", async () => {
    const mac = await testMac();
    const primary = await makePrimary({ "film.mov": "x".repeat(20_000_000) });
    const replica = await makeDiskImageTree({}, { name: "Replica" });
    mac.volumes.connect(primary, "PRIMARY-ID");
    mac.volumes.connect(replica, "REPLICA-ID");
    const flow = await mac.open();
    flow.choose("primary", primary);
    flow.choose("replica", replica);
    await flow.pair();
    const replicaBefore = await snapshotTree(replica);

    await flow.compare();

    assert.equal(stateOf(flow).step, "refused");
    assert.match(stateOf(flow).reasons.join("\n"), /The Replica has [\d.]+ [KM]B free, but the new and changed files need 20\.0 MB\./);
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });
});

describe("app flow: a drive disconnecting", () => {
  it("discards the comparison and its decisions, back on Start, when a drive disconnects during review", async () => {
    const { flow, volumes, replica } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    await flow.compare();
    flow.approveCopies(true);
    flow.next();

    volumes.disconnect(replica);
    await flow.drivesChanged();

    assert.equal(stateOf(flow).step, "start");
    assert.match(stateOf(flow).error, /Replica .* is not connected/);
    assert.match(stateOf(flow).error, /discarded/);
    volumes.connect(replica, "REPLICA-ID");
    await flow.compare();
    assert.equal(stateOf(flow).review.copiesApproved, false);
  });

  it("keeps the comparison and its decisions when the paired drives are still connected", async () => {
    const { flow, volumes } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    await flow.compare();
    flow.approveCopies(true);
    volumes.connect(await makeTree(), "SOME-OTHER-DRIVE");

    await flow.drivesChanged();

    assert.equal(stateOf(flow).step, "copies");
    assert.equal(stateOf(flow).review.copiesApproved, true);
  });

  it("checks the drives again on Apply, and writes nothing if one has gone", async () => {
    const { flow, volumes, primary, replica } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    const replicaBefore = await snapshotTree(replica);
    await flow.compare();
    flow.approveCopies(true);
    flow.next();

    volumes.disconnect(primary);
    await flow.apply();

    assert.equal(stateOf(flow).step, "start");
    assert.match(stateOf(flow).error, /Primary .* is not connected/);
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("ignores a comparison whose drive disconnected while it ran", async () => {
    const { flow, volumes, replica } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);

    const comparing = flow.compare();
    volumes.disconnect(replica);
    await flow.drivesChanged();
    await comparing;

    assert.equal(stateOf(flow).step, "start");
    assert.match(stateOf(flow).error, /Replica .* is not connected/);
  });
});
