import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { after, afterEach, describe, it } from "node:test";
import { Flow } from "../src/app/flow.ts";
import type { FlowState } from "../src/app/view.ts";
import { freeSpaceExplanation, onlyFolderDeletionsWarning, onlyFolderNote, safetyStopExplanation } from "../src/app/view.ts";
import { compare, type FileCopier } from "../src/engine/index.ts";
import { holdingAreaReadme } from "../src/engine/holding-area.ts";
import { formatDay } from "../src/format.ts";
import { MacFileCopier } from "../src/macos/file-copier.ts";
import { FakeItemCounter } from "./helpers/fake-item-counter.ts";
import { FakeRemounter } from "./helpers/fake-remounter.ts";
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

/** Stands in for the owner changing the Primary themselves, such as between a comparison and Apply: what sync-drive must leave untouched is the Primary as it is now. */
async function ownerChangesPrimary(path: string, change: () => Promise<void>): Promise<void> {
  await change();
  primaries.find((primary) => primary.path === path)!.before = await snapshotTree(path);
}

afterEach(async () => {
  for (const { path, before } of primaries.splice(0)) {
    assert.deepEqual(await snapshotTree(path), before, "the Primary must never be written to");
  }
});

/** A Mac with its own place for the Pairing and its own connected drives, and the app's flow on it. */
async function testMac(copier: FileCopier = new MacFileCopier()) {
  const volumes = new FakeVolumes();
  const remounter = new FakeRemounter();
  const itemCounter = new FakeItemCounter();
  const pairingFile = join(await makeTree(), "sync-drive", "pairing.json");
  const exclusionsFile = join(dirname(pairingFile), "exclusions.json");
  const updateLogFolder = join(dirname(pairingFile), "Update logs");
  const open = async () => {
    const flow = new Flow({ volumes, pairingFile, exclusionsFile, updateLogFolder, copier, remounter, itemCounter });
    await flow.open();
    return flow;
  };
  /** The text of every Update log written on this Mac, oldest first. */
  const updateLogs = async () => {
    const names = (await readdir(updateLogFolder).catch(() => [])).sort();
    return Promise.all(names.map((name) => readFile(join(updateLogFolder, name), "utf8")));
  };
  return { volumes, remounter, itemCounter, pairingFile, exclusionsFile, updateLogFolder, updateLogs, open };
}

/**
 * Calls `listener` with every new state of `flow`, except those that differ from the one before only
 * in how far the comparison or the Update has got.
 */
function onChangeIgnoringProgress(flow: Flow, listener: (state: FlowState) => void): void {
  let last: FlowState | undefined;
  flow.onChange((state) => {
    const withoutProgress = (s: FlowState) => ({ ...s, progress: undefined });
    if (last?.step === state.step && isDeepStrictEqual(withoutProgress(last), withoutProgress(state))) return;
    last = state;
    listener(state);
  });
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
    assert.deepEqual(flow.state, { step: "start", pairing: expected, exclusions: [], deep: false, lastUpdated: { known: true, folders: [] } });
    assert.deepEqual((await mac.open()).state, { step: "start", pairing: expected, exclusions: [], deep: false, lastUpdated: { known: true, folders: [] } }, "remembered when the app opens again");
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

/** From Copies, Next through whichever review steps there are to the Summary, approving nothing more. */
function toSummary(flow: Flow): void {
  flow.next();
  if (flow.state.step === "anomalies") flow.next();
  if (flow.state.step === "moves") flow.next();
  if (flow.state.step === "deletions") flow.next();
  assert.equal(flow.state.step, "summary");
}

/** From Copies, Next to Deletions, approve the deletions, then Next to the Summary. */
function toSummaryApprovingDeletions(flow: Flow): void {
  flow.next();
  assert.equal(flow.state.step, "deletions");
  flow.approveDeletions(true);
  flow.next();
  assert.equal(flow.state.step, "summary");
}

/** The example drives: two new files and one changed, and one file only on the Replica. */
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
    onChangeIgnoringProgress(flow, (state) => steps.push(state.step));

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
    assert.deepEqual(review.deleted.files, [{ path: "Docs/old.pdf", size: 3 }]);
    assert.equal(review.copiesApproved, false, "nothing is approved until the owner approves it");
  });

  it("stays on Start, saying why, when a paired drive is not connected", async () => {
    const { flow, volumes, replica } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    volumes.disconnect(replica);

    await flow.compare();

    assert.equal(stateOf(flow).step, "start");
    assert.match(stateOf(flow).error, /Replica .* is not connected/);
    assert.match(stateOf(flow).error, /If a drive has been replaced, use Re-pair on Start\.$/, "points to the app's Re-pair, not a command");
  });

  it("writes nothing to either drive while pairing and comparing", async () => {
    const mac = await testMac();
    const primary = await makePrimary(EXAMPLE_PRIMARY);
    const replica = await makeTree(EXAMPLE_REPLICA);
    mac.volumes.connect(primary, "PRIMARY-ID");
    mac.volumes.connect(replica, "REPLICA-ID");
    const replicaBefore = await snapshotTree(replica);
    const flow = await mac.open();

    flow.choose("primary", primary);
    flow.choose("replica", replica);
    await flow.pair();
    await flow.compare();

    assert.equal(stateOf(flow).step, "copies");
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("says so on Start, asking nothing, when the Replica matches the Primary", async () => {
    const { flow } = await pairedMac({ "a.txt": "same" }, { "a.txt": "same" });

    await flow.compare();

    assert.equal(stateOf(flow).step, "start");
    assert.match(stateOf(flow).notice, /matches the Primary/);
  });
});

describe("app flow: progress", () => {
  it("shows Comparing's progress as items scanned out of the paired drives' item counts", async () => {
    const { flow, itemCounter, primary, replica } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    itemCounter.set(primary, 40);
    itemCounter.set(replica, 60);
    const comparing: Record<string, any>[] = [];
    flow.onChange((state) => {
      if (state.step === "comparing") comparing.push(state);
    });

    await flow.compare();

    assert.equal(comparing[0]!.progress, undefined, "nothing to show until the counts are read");
    assert.deepEqual(comparing[1]!.progress, { phase: "scanning", scanned: 0, total: 100 });
    // Photos, Photos/2026, a.jpg, b.jpg, readme.txt; readme.txt, Docs, old.pdf.
    assert.deepEqual(comparing.at(-1)!.progress, { phase: "scanning", scanned: 8, total: 100 });
    assert.equal(stateOf(flow).step, "copies");
  });

  it("shows Comparing's progress with no total when a paired drive has no usable item count", async () => {
    const { flow, itemCounter, primary } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    itemCounter.set(primary, 40);
    const comparing: Record<string, any>[] = [];
    flow.onChange((state) => {
      if (state.step === "comparing") comparing.push(state);
    });

    await flow.compare();

    assert.deepEqual(comparing.at(-1)!.progress, { phase: "scanning", scanned: 8 });
  });

  it("ignores progress from a comparison discarded because a drive disconnected", async () => {
    const mac = await testMac();
    const primary = await makePrimary(EXAMPLE_PRIMARY);
    const replica = await makeTree(EXAMPLE_REPLICA);
    mac.volumes.connect(primary, "PRIMARY-ID");
    mac.volumes.connect(replica, "REPLICA-ID");
    let countsAsked!: () => void;
    const asked = new Promise<void>((resolve) => (countsAsked = resolve));
    let giveCounts!: () => void;
    const held = new Promise<void>((resolve) => (giveCounts = resolve));
    // Holds the comparison at reading the item counts until the drive has gone.
    mac.itemCounter.itemCount = async () => {
      countsAsked();
      await held;
      return 10;
    };
    const flow = await mac.open();
    flow.choose("primary", primary);
    flow.choose("replica", replica);
    await flow.pair();

    const comparing = flow.compare();
    await asked;
    mac.volumes.disconnect(replica);
    await flow.drivesChanged();
    assert.equal(stateOf(flow).step, "start");
    const after: string[] = [];
    flow.onChange((state) => after.push(state.step));
    giveCounts();
    await comparing;

    assert.deepEqual(after, [], "the discarded comparison's progress never brings Comparing back");
    assert.equal(stateOf(flow).step, "start");
  });

  it("shows Updating's progress, by bytes copied out of the approved total, while the Primary is read-only", async () => {
    const { flow } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    await flow.compare();
    flow.approveCopies(true);
    toSummary(flow);
    const updating: Record<string, any>[] = [];
    flow.onChange((state) => {
      if (state.step === "updating" && state.progress !== undefined) updating.push(state);
    });

    await flow.apply();

    assert.ok(updating.every((state) => state.primary === "read-only"), "the bar belongs to the read-only stage");
    assert.deepEqual(updating[0]!.progress.copies, { copiedBytes: 0, notCopiedBytes: 0, totalBytes: 1_500_013 });
    assert.deepEqual(updating.at(-1)!.progress.copies, { copiedBytes: 1_500_013, notCopiedBytes: 0, totalBytes: 1_500_013 });
    assert.equal(stateOf(flow).step, "result");
  });
});

describe("app flow: what cannot be read on the Primary", () => {
  /** Runs `during` with the Primary folder `folder` unreadable, then makes it readable again for the Primary's check. */
  async function withUnreadable(primary: string, folder: string, during: () => Promise<void>): Promise<void> {
    await chmod(join(primary, folder), 0o000);
    try {
      await during();
    } finally {
      await chmod(join(primary, folder), 0o755);
    }
  }

  it("lists it in the review and on the Result, copies the rest, and keeps its Replica copy", async () => {
    const { flow, primary, replica } = await pairedMac(
      { "Private/diary.txt": "diary", "new.txt": "new" },
      { "Private/diary.txt": "diary", "Private/older.txt": "older" },
    );
    const unreadable = [{ path: "Private", folder: true, reason: "permission denied" }];

    await withUnreadable(primary, "Private", async () => {
      await flow.compare();
      assert.equal(stateOf(flow).step, "copies");
      assert.deepEqual(stateOf(flow).review.unreadable, unreadable);
      assert.deepEqual(stateOf(flow).review.deleted.files, [], "never treated as deleted");
      flow.approveCopies(true);
      toSummary(flow);
      assert.deepEqual(stateOf(flow).review.unreadable, unreadable, "still shown on the Summary");
      await flow.apply();
    });

    assert.equal(stateOf(flow).step, "result");
    assert.deepEqual(stateOf(flow).copied, [{ path: "new.txt", size: 3 }]);
    assert.deepEqual(stateOf(flow).unreadable, unreadable);
    assert.equal(await readFile(join(replica, "Private/older.txt"), "utf8"), "older");
  });

  it("goes on to the review, rather than saying the drives match, when only something unreadable stands out", async () => {
    const { flow, primary } = await pairedMac({ "Private/diary.txt": "diary", "a.txt": "same" }, { "a.txt": "same" });

    await withUnreadable(primary, "Private", () => flow.compare());

    assert.equal(stateOf(flow).step, "copies");
    assert.deepEqual(stateOf(flow).review.unreadable, [{ path: "Private", folder: true, reason: "permission denied" }]);
  });
});

describe("app flow: Approval, Summary and Apply", () => {
  it("with the copies approved, copies exactly the new and changed files, and leaves the deleted ones", async () => {
    const { flow, primary, replica } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    const primaryBefore = await snapshotTree(primary);
    await flow.compare();

    flow.approveCopies(true);
    toSummary(flow);

    assert.equal(stateOf(flow).step, "summary");
    assert.deepEqual(stateOf(flow).apply, {
      copy: { count: 3, totalSize: 1_500_013 },
      overwrite: { count: 0, totalSize: 0 },
      keep: { count: 0, totalSize: 0 },
      leaveUndecided: { count: 0, totalSize: 0 },
      renameOnReplica: { count: 0, totalSize: 0 },
      leaveAtOldPaths: { count: 0, totalSize: 0 },
      moveToHoldingArea: { count: 0, totalSize: 0 },
      deleteFromHoldingArea: { count: 0, totalSize: 0 },
      leaveOnReplica: { count: 1, totalSize: 3 },
    });
    const steps: string[] = [];
    onChangeIgnoringProgress(flow, (state) => steps.push(state.step));
    await flow.apply();

    assert.deepEqual(steps, ["updating", "updating", "updating", "result"]);
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

    toSummary(flow);
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
    toSummary(flow);

    await flow.apply();

    assert.deepEqual(stateOf(flow).copied, [{ path: "readme.txt", size: 8 }]);
    assert.deepEqual(stateOf(flow).failed, [
      { path: "Photos/2026/a.jpg", size: 1_500_000, reason: "the drive is full" },
      { path: "Photos/2026/b.jpg", size: 5, reason: "the drive is full" },
    ]);
    const after = await compare(primary, replica);
    assert.equal(after.new.count, 2);
  });

  it("keeps the Approvals through Back and Next, across Copies, Deletions and Summary", async () => {
    const { flow } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    await flow.compare();

    flow.approveCopies(true);
    flow.next();
    assert.equal(stateOf(flow).step, "deletions");
    flow.approveDeletions(true);
    flow.back();
    assert.equal(stateOf(flow).step, "copies");
    assert.equal(stateOf(flow).review.copiesApproved, true);
    flow.next();
    assert.equal(stateOf(flow).review.deletionsApproved, true);
    flow.next();
    assert.equal(stateOf(flow).step, "summary");
    assert.equal(stateOf(flow).apply.copy.count, 3);
    assert.equal(stateOf(flow).apply.moveToHoldingArea.count, 1);

    flow.back();
    assert.equal(stateOf(flow).step, "deletions");
    flow.approveDeletions(false);
    flow.back();
    flow.approveCopies(false);
    flow.next();
    flow.next();
    assert.equal(stateOf(flow).apply.copy.count, 0);
    assert.equal(stateOf(flow).apply.moveToHoldingArea.count, 0);
  });

  it("has no going back once Apply starts, and discards the decisions for the next comparison", async () => {
    const { flow, replica } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    await flow.compare();
    flow.approveCopies(true);
    toSummary(flow);
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
  /** Paired drives where the Primary has lost 101 of the Replica's 200 files, and gained a new one. */
  function pairedPastTheSafetyStop() {
    return pairedMac({ ...files("kept/", 99), "new.txt": "new" }, { ...files("kept/", 99), ...files("gone/", 101) });
  }

  /** Paired drives where the Replica, a small disk image, has no room for the Primary's 20 MB film. */
  async function pairedWithoutRoom(replicaSpec: TreeSpec = {}) {
    const mac = await testMac();
    const primary = await makePrimary({ "film.mov": "x".repeat(20_000_000) });
    const replica = await makeDiskImageTree(replicaSpec, { name: "Replica" });
    mac.volumes.connect(primary, "PRIMARY-ID");
    mac.volumes.connect(replica, "REPLICA-ID");
    const flow = await mac.open();
    flow.choose("primary", primary);
    flow.choose("replica", replica);
    await flow.pair();
    return { ...mac, flow, primary, replica };
  }

  it("stops on the refusal screen, before any Approval, when the Safety stop applies, explaining the deleted files' share of the Replica", async () => {
    const { flow } = await pairedPastTheSafetyStop();
    const steps: string[] = [];
    onChangeIgnoringProgress(flow, (state) => steps.push(state.step));

    await flow.compare();

    assert.deepEqual(steps, ["comparing", "refused"]);
    const { safetyStop, freeSpace } = stateOf(flow);
    assert.equal(freeSpace, undefined);
    assert.deepEqual(safetyStop, { deleted: { count: 101, totalSize: 101 }, replica: { count: 200, totalSize: 200 } });
    assert.match(
      safetyStopExplanation(safetyStop),
      /^The Safety stop applies: 101 files \(101 B\) are no longer on the Primary\. That is 101 of the Replica's 200 files \(50\.5%\) and 101 B of its 200 B \(50\.5%\), more than 10% of the Replica\./,
    );
    assert.match(safetyStopExplanation(safetyStop), /something is wrong with the Primary/);
  });

  it("writes nothing, and moves on to no Approval, while the Safety stop stands", async () => {
    const { flow, replica } = await pairedPastTheSafetyStop();
    const replicaBefore = await snapshotTree(replica);
    await flow.compare();

    flow.next();
    flow.approveCopies(true);
    flow.approveDeletions(true);
    await flow.apply();

    assert.equal(stateOf(flow).step, "refused", "no way past the refusal but the override");
    flow.restart();
    assert.equal(stateOf(flow).step, "start");
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("with the exact number of deletions typed, goes on to the usual Approvals, then updates past the Safety stop", async () => {
    const { flow, replica } = await pairedPastTheSafetyStop();
    await flow.compare();

    flow.overrideSafetyStop("101");

    assert.equal(stateOf(flow).step, "copies");
    const { review } = stateOf(flow);
    assert.equal(review.safetyStopOverridden, true);
    assert.equal(review.copiesApproved, false, "the override approves nothing");
    assert.equal(review.deletionsApproved, false, "the override approves nothing");
    flow.approveCopies(true);
    toSummaryApprovingDeletions(flow);
    await flow.apply();
    assert.equal(stateOf(flow).step, "result");
    assert.equal(stateOf(flow).error, undefined);
    assert.equal(stateOf(flow).moved.length, 101);
    const after = await snapshotTree(replica);
    assert.equal(after.some((line) => line.includes("sync-drive Holding Area/gone/0.txt")), true);
    assert.equal(after.some((line) => line.startsWith("file new.txt ")), true);
  });

  it("accepts the number with spaces around it", async () => {
    const { flow } = await pairedPastTheSafetyStop();
    await flow.compare();

    flow.overrideSafetyStop(" 101 ");

    assert.equal(stateOf(flow).step, "copies");
  });

  it("does not override with a wrong number, saying so, and writes nothing", async () => {
    const { flow, replica } = await pairedPastTheSafetyStop();
    const replicaBefore = await snapshotTree(replica);
    await flow.compare();

    for (const typed of ["100", "102", "", "1O1", "101.0", "+101", "yes", "200"]) {
      flow.overrideSafetyStop(typed);
      assert.equal(stateOf(flow).step, "refused", `"${typed}" must not override it`);
    }

    assert.match(stateOf(flow).safetyStop.error, /not the number of deletions/);
    flow.next();
    await flow.apply();
    assert.equal(stateOf(flow).step, "refused");
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("forgets the override on a new comparison", async () => {
    const { flow } = await pairedPastTheSafetyStop();
    await flow.compare();
    flow.overrideSafetyStop("101");
    flow.restart();

    await flow.compare();

    assert.equal(stateOf(flow).step, "refused");
  });

  it("forgets the override on a relaunch", async () => {
    const { flow, open } = await pairedPastTheSafetyStop();
    await flow.compare();
    flow.overrideSafetyStop("101");

    const relaunched = await open();
    await relaunched.compare();

    assert.equal(stateOf(relaunched).step, "refused");
  });

  it("forgets the override, back on Start, when a drive disconnects after it", async () => {
    const { flow, volumes, replica } = await pairedPastTheSafetyStop();
    await flow.compare();
    flow.overrideSafetyStop("101");

    volumes.disconnect(replica);
    await flow.drivesChanged();
    volumes.connect(replica, "REPLICA-ID");
    assert.equal(stateOf(flow).step, "start");
    await flow.compare();

    assert.equal(stateOf(flow).step, "refused");
  });

  it("discards the refusal, back on Start, when a drive disconnects on the refusal screen", async () => {
    const { flow, volumes, replica } = await pairedPastTheSafetyStop();
    await flow.compare();

    volumes.disconnect(replica);
    await flow.drivesChanged();

    assert.equal(stateOf(flow).step, "start");
    assert.match(stateOf(flow).error, /Replica .* is not connected/);
  });

  it("stops on the refusal screen when the Replica lacks the free space, naming the space needed and free and the Holding area's size", async () => {
    const { flow, replica } = await pairedWithoutRoom({ "sync-drive Holding Area/old.mov": "x".repeat(5_000) });
    const replicaBefore = await snapshotTree(replica);

    await flow.compare();

    assert.equal(stateOf(flow).step, "refused");
    const { freeSpace, safetyStop } = stateOf(flow);
    assert.equal(safetyStop, undefined);
    assert.equal(freeSpace.needed >= 20_000_000, true);
    assert.equal(freeSpace.free < freeSpace.needed, true);
    assert.deepEqual(freeSpace.holdingArea, { count: 1, totalSize: 5_000 });
    const explanation = freeSpaceExplanation(freeSpace);
    assert.match(explanation, /^The Replica has [\d.]+ [KM]B free, but the new and changed files need 20\.0 MB\./);
    assert.match(explanation, /The Holding area on the Replica holds 5\.0 KB from the previous Update\./);
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("says the Replica needs more room when there is no Holding area to free", async () => {
    const { flow } = await pairedWithoutRoom();

    await flow.compare();

    assert.deepEqual(stateOf(flow).freeSpace.holdingArea, { count: 0, totalSize: 0 });
    assert.match(freeSpaceExplanation(stateOf(flow).freeSpace), /The Replica needs a larger drive/);
  });

  it("offers no override for the free space, so nothing can be approved, and writes nothing", async () => {
    const { flow, replica } = await pairedWithoutRoom();
    const replicaBefore = await snapshotTree(replica);
    await flow.compare();

    flow.overrideSafetyStop("1");
    flow.overrideSafetyStop("0");
    flow.next();
    flow.approveCopies(true);
    await flow.apply();

    assert.equal(stateOf(flow).step, "refused");
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("offers no override when the Safety stop and the free space both refuse", async () => {
    const { flow, replica } = await pairedWithoutRoom({ ...files("gone/", 101) });
    const replicaBefore = await snapshotTree(replica);
    await flow.compare();
    assert.equal(stateOf(flow).step, "refused");
    assert.notEqual(stateOf(flow).safetyStop, undefined);
    assert.notEqual(stateOf(flow).freeSpace, undefined);

    flow.overrideSafetyStop("101");

    assert.equal(stateOf(flow).step, "refused");
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });
});

describe("app flow: a drive disconnecting", () => {
  it("discards the comparison and its decisions, back on Start, when a drive disconnects during review", async () => {
    const { flow, volumes, replica } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    await flow.compare();
    flow.approveCopies(true);
    toSummary(flow);

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
    toSummary(flow);

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

describe("app flow: Deletions", () => {
  it("comes after Copies, showing the deleted files grouped by folder, with nothing approved", async () => {
    const { flow } = await pairedMac(EXAMPLE_PRIMARY, { ...EXAMPLE_REPLICA, "Docs/2019/tax.pdf": "12345", "gone.txt": "x" });
    await flow.compare();

    flow.next();

    assert.equal(stateOf(flow).step, "deletions");
    const { review } = stateOf(flow);
    assert.deepEqual(review.deleted.folders, [
      { folder: "", count: 1, totalSize: 1, files: [{ path: "gone.txt", size: 1 }] },
      { folder: "Docs", count: 1, totalSize: 3, files: [{ path: "Docs/old.pdf", size: 3 }] },
      { folder: "Docs/2019", count: 1, totalSize: 5, files: [{ path: "Docs/2019/tax.pdf", size: 5 }] },
    ]);
    assert.equal(review.deletionsApproved, false, "nothing is approved until the owner approves it");
  });

  it("with only the deletions approved, moves the deleted files into the Holding area and copies nothing", async () => {
    const { flow, primary, replica } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    await flow.compare();
    toSummaryApprovingDeletions(flow);

    assert.deepEqual(stateOf(flow).apply, {
      copy: { count: 0, totalSize: 0 },
      overwrite: { count: 0, totalSize: 0 },
      keep: { count: 0, totalSize: 0 },
      leaveUndecided: { count: 0, totalSize: 0 },
      renameOnReplica: { count: 0, totalSize: 0 },
      leaveAtOldPaths: { count: 0, totalSize: 0 },
      moveToHoldingArea: { count: 1, totalSize: 3 },
      deleteFromHoldingArea: { count: 0, totalSize: 0 },
      leaveOnReplica: { count: 0, totalSize: 0 },
    });
    const steps: string[] = [];
    onChangeIgnoringProgress(flow, (state) => steps.push(state.step));
    await flow.apply();

    assert.deepEqual(steps, ["updating", "updating", "updating", "result"]);
    assert.deepEqual(stateOf(flow).copied, []);
    assert.deepEqual(stateOf(flow).moved, [{ path: "Docs/old.pdf", size: 3 }]);
    assert.deepEqual(stateOf(flow).notMoved, []);
    assert.equal(await readFile(join(replica, "sync-drive Holding Area", "Docs", "old.pdf"), "utf8"), "abc");
    const after = await compare(primary, replica);
    assert.equal(after.deleted.count, 0);
    assert.equal(after.new.count, 2, "the copies were not approved, so nothing was copied");
    assert.equal(after.changed.count, 1);
  });

  /**
   * Paired drives whose Replica's Holding area holds `Docs/first.txt` (5 B) from an earlier Update
   * that approved only the deletions, so `primaryExtra` is still to be copied.
   */
  async function pairedWithFilledHoldingArea(primaryExtra: TreeSpec = {}) {
    const paired = await pairedMac({ "a.txt": "same", ...primaryExtra }, { "a.txt": "same", "Docs/first.txt": "12345" });
    const { flow } = paired;
    await flow.compare();
    toSummaryApprovingDeletions(flow);
    await flow.apply();
    assert.deepEqual(stateOf(flow).moved, [{ path: "Docs/first.txt", size: 5 }]);
    flow.restart();
    return { ...paired, holding: join(paired.replica, "sync-drive Holding Area") };
  }

  it("warns with the deletions, after Copies, what the Holding area holds, which approving deletes for good", async () => {
    const { flow, replica } = await pairedWithFilledHoldingArea({ "new.txt": "new" });
    await writeFile(join(replica, "second.txt"), "x");
    await flow.compare();

    assert.equal(stateOf(flow).step, "copies");
    flow.next();
    assert.equal(stateOf(flow).step, "deletions");
    assert.deepEqual(stateOf(flow).review.holdingArea, { count: 1, totalSize: 5 });
    flow.approveDeletions(true);
    flow.next();
    assert.deepEqual(stateOf(flow).apply.deleteFromHoldingArea, { count: 1, totalSize: 5 });
  });

  it("with only the copies approved, leaves the previous Holding area and the deleted files alone", async () => {
    const { flow, replica, holding } = await pairedWithFilledHoldingArea({ "new.txt": "new" });
    await writeFile(join(replica, "second.txt"), "x");
    const holdingBefore = await snapshotTree(holding);
    await flow.compare();
    flow.approveCopies(true);
    toSummary(flow);

    assert.deepEqual(stateOf(flow).apply.deleteFromHoldingArea, { count: 0, totalSize: 0 });
    await flow.apply();

    assert.deepEqual(stateOf(flow).copied, [{ path: "new.txt", size: 3 }]);
    assert.deepEqual(stateOf(flow).moved, []);
    assert.deepEqual(stateOf(flow).leftOnReplica, { count: 1, totalSize: 1 });
    assert.deepEqual(await snapshotTree(holding), holdingBefore);
    assert.equal(await readFile(join(replica, "second.txt"), "utf8"), "x");
  });

  it("with the deletions approved, empties the previous Holding area, then moves the new deletions in", async () => {
    const { flow, replica, holding } = await pairedWithFilledHoldingArea();
    await writeFile(join(replica, "second.txt"), "x");
    await flow.compare();
    toSummaryApprovingDeletions(flow);

    await flow.apply();

    assert.deepEqual(stateOf(flow).moved, [{ path: "second.txt", size: 1 }]);
    assert.deepEqual((await readdir(holding)).sort(), ["READ ME.txt", "second.txt"]);
  });

  it("skips Deletions, and the warning, when there is nothing to delete, leaving the Holding area alone", async () => {
    const { flow, replica, holding } = await pairedWithFilledHoldingArea();
    await writeFile(join(replica, "a.txt"), "changed on the Replica");
    const holdingBefore = await snapshotTree(holding);
    await flow.compare();
    flow.approveCopies(true);

    flow.next();
    assert.equal(stateOf(flow).step, "summary");
    flow.back();
    assert.equal(stateOf(flow).step, "copies");
    flow.next();
    await flow.apply();

    assert.deepEqual(stateOf(flow).copied, [{ path: "a.txt", size: 4 }]);
    assert.deepEqual(await snapshotTree(holding), holdingBefore);
  });

  it("with neither Approval, writes nothing, even with deletions to approve", async () => {
    const { flow, replica } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    const replicaBefore = await snapshotTree(replica);
    await flow.compare();
    toSummary(flow);

    await flow.apply();

    assert.equal(stateOf(flow).step, "summary", "there is nothing to apply");
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("lists in full every deleted file that was not moved, and why", async () => {
    const { flow, replica } = await pairedMac(EXAMPLE_PRIMARY, { ...EXAMPLE_REPLICA, "gone.txt": "x" });
    await flow.compare();
    toSummaryApprovingDeletions(flow);
    // Gone from the Replica between the comparison and Apply, so it cannot be moved.
    await rm(join(replica, "Docs", "old.pdf"));

    await flow.apply();

    assert.deepEqual(stateOf(flow).moved, [{ path: "gone.txt", size: 1 }]);
    assert.equal(stateOf(flow).notMoved.length, 1);
    assert.equal(stateOf(flow).notMoved[0].path, "Docs/old.pdf");
    assert.match(stateOf(flow).notMoved[0].reason, /ENOENT/);
  });

  it("lists a deleted file that is on the Primary again since the comparison as not moved, and why", async () => {
    const { flow, primary, replica } = await pairedMac(EXAMPLE_PRIMARY, { ...EXAMPLE_REPLICA, "gone.txt": "x" });
    await flow.compare();
    toSummaryApprovingDeletions(flow);
    await ownerChangesPrimary(primary, () => writeFile(join(primary, "gone.txt"), "restored"));

    await flow.apply();

    assert.deepEqual(stateOf(flow).moved, [{ path: "Docs/old.pdf", size: 3 }]);
    assert.deepEqual(stateOf(flow).notMoved.map((file: { path: string }) => file.path), ["gone.txt"]);
    assert.match(stateOf(flow).notMoved[0].reason, /on the Primary again since the comparison/);
    assert.equal(await readFile(join(replica, "gone.txt"), "utf8"), "x");
  });

  it("writes nothing, back on Start, when the Holding area changed after the comparison", async () => {
    const { flow, replica, holding } = await pairedWithFilledHoldingArea();
    await writeFile(join(replica, "second.txt"), "x");
    await flow.compare();
    toSummaryApprovingDeletions(flow);
    // Put there after the comparison, so the warning and the Summary never showed it.
    await writeFile(join(holding, "unseen.txt"), "unseen");
    const replicaBefore = await snapshotTree(replica);

    await flow.apply();

    assert.equal(stateOf(flow).step, "start");
    assert.match(stateOf(flow).error, /Holding area .* changed since the comparison/);
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("lists what was moved and copied when the Update stops partway", async () => {
    const { flow, replica } = await pairedMac({ "new.txt": "new" }, { "gone.txt": "gone", ".sync-drive-incoming/stuck": "left over" });
    const stuck = join(replica, ".sync-drive-incoming", "stuck");
    // Locked, so emptying the Incoming folder fails after the deletions have moved.
    await promisify(execFile)("chflags", ["uchg", stuck]);
    try {
      await flow.compare();
      flow.approveCopies(true);
      toSummaryApprovingDeletions(flow);

      await flow.apply();

      assert.equal(stateOf(flow).step, "result");
      assert.match(stateOf(flow).error, /EPERM/);
      assert.deepEqual(stateOf(flow).moved, [{ path: "gone.txt", size: 4 }]);
      assert.deepEqual(stateOf(flow).copied, []);
    } finally {
      await promisify(execFile)("chflags", ["nouchg", stuck]);
    }
  });
});

describe("app flow: Moves", () => {
  /** Photos/Iceland moved into Photos/2026 on the Primary, plus one new file and one deleted. */
  const MOVED_PRIMARY: TreeSpec = { "Photos/2026/Iceland/a.jpg": "aaaa", "Photos/2026/Iceland/b.jpg": "bb", "new.txt": "new" };
  const MOVED_REPLICA: TreeSpec = { "Photos/Iceland/a.jpg": "aaaa", "Photos/Iceland/b.jpg": "bb", "gone.txt": "gone" };

  it("comes after Copies and before Deletions, showing the moves grouped by folder, with nothing approved", async () => {
    const { flow } = await pairedMac(MOVED_PRIMARY, MOVED_REPLICA);
    await flow.compare();
    assert.deepEqual(stateOf(flow).review.new.files, [{ path: "new.txt", size: 3 }], "moved files are not new");

    flow.next();

    assert.equal(stateOf(flow).step, "moves");
    const { review } = stateOf(flow);
    assert.deepEqual(
      review.moves.folders.map(({ from, to, count, totalSize }: Record<string, unknown>) => ({ from, to, count, totalSize })),
      [{ from: "Photos/Iceland", to: "Photos/2026/Iceland", count: 2, totalSize: 6 }],
    );
    assert.equal(review.movesApproved, false, "nothing is approved until the owner approves it");
    flow.next();
    assert.equal(stateOf(flow).step, "deletions");
  });

  it("with only the moves approved, renames the moved files on the Replica and copies and deletes nothing", async () => {
    const { flow, primary, replica } = await pairedMac(MOVED_PRIMARY, MOVED_REPLICA);
    await flow.compare();
    flow.next();
    flow.approveMoves(true);
    flow.next();
    flow.next();

    assert.equal(stateOf(flow).step, "summary");
    assert.deepEqual(stateOf(flow).apply, {
      copy: { count: 0, totalSize: 0 },
      overwrite: { count: 0, totalSize: 0 },
      keep: { count: 0, totalSize: 0 },
      leaveUndecided: { count: 0, totalSize: 0 },
      renameOnReplica: { count: 2, totalSize: 6 },
      leaveAtOldPaths: { count: 0, totalSize: 0 },
      moveToHoldingArea: { count: 0, totalSize: 0 },
      deleteFromHoldingArea: { count: 0, totalSize: 0 },
      leaveOnReplica: { count: 1, totalSize: 4 },
    });
    await flow.apply();

    assert.equal(stateOf(flow).step, "result");
    assert.deepEqual(stateOf(flow).renamed, [
      { from: "Photos/Iceland/a.jpg", to: "Photos/2026/Iceland/a.jpg", size: 4 },
      { from: "Photos/Iceland/b.jpg", to: "Photos/2026/Iceland/b.jpg", size: 2 },
    ]);
    assert.deepEqual(stateOf(flow).notRenamed, []);
    assert.deepEqual(stateOf(flow).copied, []);
    assert.deepEqual(stateOf(flow).moved, []);
    assert.deepEqual((await readdir(replica)).sort(), [".sync-drive-last-updated", "Photos", "gone.txt"], "no Holding area");
    const after = await compare(primary, replica);
    assert.equal(after.moves.count, 0);
    assert.deepEqual(after.new.files, [{ path: "new.txt", size: 3 }]);
  });

  it("without the moves Approval, leaves the moved files at their old paths, even with the copies approved", async () => {
    const { flow, replica } = await pairedMac(MOVED_PRIMARY, MOVED_REPLICA);
    await flow.compare();
    flow.approveCopies(true);
    toSummary(flow);

    assert.deepEqual(stateOf(flow).apply.renameOnReplica, { count: 0, totalSize: 0 });
    assert.deepEqual(stateOf(flow).apply.leaveAtOldPaths, { count: 2, totalSize: 6 });
    await flow.apply();

    assert.deepEqual(stateOf(flow).copied, [{ path: "new.txt", size: 3 }]);
    assert.deepEqual(stateOf(flow).renamed, []);
    assert.deepEqual(stateOf(flow).movesLeftAtOldPaths, { count: 2, totalSize: 6 });
    assert.deepEqual(await readdir(join(replica, "Photos")), ["Iceland"]);
  });

  it("keeps the moves Approval through Back and Next", async () => {
    const { flow } = await pairedMac(MOVED_PRIMARY, MOVED_REPLICA);
    await flow.compare();

    flow.next();
    flow.approveMoves(true);
    flow.next();
    assert.equal(stateOf(flow).step, "deletions");
    flow.back();
    assert.equal(stateOf(flow).step, "moves");
    assert.equal(stateOf(flow).review.movesApproved, true);
    flow.back();
    assert.equal(stateOf(flow).step, "copies");
    flow.next();
    flow.next();
    flow.next();
    assert.equal(stateOf(flow).step, "summary");
    assert.equal(stateOf(flow).apply.renameOnReplica.count, 2);
    flow.back();
    flow.back();
    assert.equal(stateOf(flow).step, "moves");
    flow.approveMoves(false);
    flow.next();
    flow.next();
    assert.equal(stateOf(flow).apply.renameOnReplica.count, 0);
  });

  it("skips Moves when nothing was moved", async () => {
    const { flow } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    await flow.compare();

    flow.next();

    assert.equal(stateOf(flow).step, "deletions");
    flow.back();
    assert.equal(stateOf(flow).step, "copies");
  });

  it("lists every moved file that was not renamed, and why", async () => {
    const { flow, replica } = await pairedMac(MOVED_PRIMARY, MOVED_REPLICA);
    await flow.compare();
    flow.next();
    flow.approveMoves(true);
    flow.next();
    flow.next();
    // Edited on the Replica after the comparison, so it may no longer be the same file.
    await writeFile(join(replica, "Photos/Iceland/b.jpg"), "edited");

    await flow.apply();

    assert.deepEqual(stateOf(flow).renamed.map((move: { from: string }) => move.from), ["Photos/Iceland/a.jpg"]);
    assert.equal(stateOf(flow).notRenamed.length, 1);
    assert.equal(stateOf(flow).notRenamed[0].from, "Photos/Iceland/b.jpg");
    assert.match(stateOf(flow).notRenamed[0].reason, /changed .* since the comparison/);
  });
});

describe("app flow: the Primary read-only during the Update", () => {
  it("remounts the Primary read-only before writing anything, and normally again afterwards", async () => {
    const real = new MacFileCopier();
    const copiedWhileReadOnly: boolean[] = [];
    let remounter: FakeRemounter | undefined;
    const copier: FileCopier = {
      copy: (source, destination) => {
        copiedWhileReadOnly.push(remounter!.isReadOnly(primary));
        return real.copy(source, destination);
      },
    };
    const paired = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA, copier);
    const { flow, primary } = paired;
    remounter = paired.remounter;
    await flow.compare();
    flow.approveCopies(true);
    toSummary(flow);
    const states: Record<string, any>[] = [];
    onChangeIgnoringProgress(flow, (state) => states.push(state));

    await flow.apply();

    assert.deepEqual(remounter.log, [`read-only ${primary}`, `normally ${primary}`]);
    assert.deepEqual(copiedWhileReadOnly, [true, true, true]);
    assert.deepEqual(
      states.map((state) => (state.step === "updating" ? `updating: ${state.primary}` : state.step)),
      ["updating: remounting read-only", "updating: read-only", "updating: remounting normally", "result"],
      "the Updating screen says what is happening to the Primary",
    );
    assert.equal(stateOf(flow).primaryStillReadOnly, undefined);
    assert.equal(remounter.isReadOnly(primary), false);
  });

  it("refuses to start the Update, writing nothing, when the Primary cannot be remounted read-only", async () => {
    const { flow, remounter, replica } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    const replicaBefore = await snapshotTree(replica);
    remounter.failReadOnly = new Error("Volume in use by Finder.");
    await flow.compare();
    flow.approveCopies(true);
    toSummaryApprovingDeletions(flow);

    await flow.apply();

    assert.equal(stateOf(flow).step, "start");
    assert.match(stateOf(flow).error, /did not start, and nothing was written.*read-only.*Volume in use by Finder\./);
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("remounts the Primary normally when the Update stops partway", async () => {
    const { flow, remounter, primary, replica } = await pairedMac({ "new.txt": "new" }, { ".sync-drive-incoming/stuck": "left over" });
    const stuck = join(replica, ".sync-drive-incoming", "stuck");
    // Locked, so emptying the Incoming folder fails and the Update stops.
    await promisify(execFile)("chflags", ["uchg", stuck]);
    try {
      await flow.compare();
      flow.approveCopies(true);
      toSummary(flow);

      await flow.apply();

      assert.match(stateOf(flow).error, /EPERM/);
      assert.deepEqual(remounter.log, [`read-only ${primary}`, `normally ${primary}`]);
      assert.equal(remounter.isReadOnly(primary), false);
    } finally {
      await promisify(execFile)("chflags", ["nouchg", stuck]);
    }
  });

  it("says on the Result when the Primary could not be remounted normally afterwards", async () => {
    const { flow, remounter, primary } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    remounter.failNormally = new Error("Volume busy.");
    await flow.compare();
    flow.approveCopies(true);
    toSummary(flow);

    await flow.apply();

    assert.equal(stateOf(flow).step, "result");
    assert.equal(stateOf(flow).copied.length, 3, "the Update itself still happened");
    assert.equal(stateOf(flow).primaryStillReadOnly, "Volume busy.");
    assert.equal(remounter.isReadOnly(primary), true);
  });

  it("reads the Primary where it is mounted read-only, if that is somewhere else", async () => {
    const { flow, remounter, primary, replica } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    remounter.remountAt = `${primary} 1`;
    await flow.compare();
    flow.approveCopies(true);
    toSummary(flow);

    await flow.apply();

    assert.deepEqual(remounter.log, [`read-only ${primary}`, `normally ${primary} 1`]);
    assert.deepEqual(stateOf(flow).failed, []);
    assert.equal(await readFile(join(replica, "readme.txt"), "utf8"), "changed!");
  });

  it("on quitting during the Update, stops it first, then remounts the Primary normally", async () => {
    const real = new MacFileCopier();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let copying!: () => void;
    const copyStarted = new Promise<void>((resolve) => (copying = resolve));
    const blocking: FileCopier = {
      copy: async (source, destination) => {
        copying();
        await released;
        return real.copy(source, destination);
      },
    };
    const { flow, remounter, primary } = await pairedMac({ "a.txt": "first", "b.txt": "second" }, {}, blocking);
    await flow.compare();
    flow.approveCopies(true);
    toSummary(flow);

    const applying = flow.apply();
    await copyStarted;
    const quitting = Promise.all([flow.quit(), flow.quit()]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(remounter.isReadOnly(primary), true, "still read-only while the Update is running");
    release();
    await quitting;

    assert.equal(stateOf(flow).step, "result", "the Update had stopped before quitting finished");
    assert.deepEqual(stateOf(flow).copied, [{ path: "a.txt", size: 5 }], "the copy under way finishes");
    assert.deepEqual(stateOf(flow).failed, [{ path: "b.txt", size: 6, reason: "The app is quitting." }]);
    assert.deepEqual(remounter.log, [`read-only ${primary}`, `normally ${primary}`]);
    assert.equal(remounter.isReadOnly(primary), false);
    await applying;
  });

  it("quits without remounting anything when no Update is running", async () => {
    const { flow, remounter } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    await flow.compare();

    await flow.quit();

    assert.deepEqual(remounter.log, []);
  });
});

describe("app flow: Exclusions", () => {
  it("adds and removes Exclusions on Start, saving them beside the Pairing for the next time the app opens", async () => {
    const { flow, open, exclusionsFile } = await pairedMac();

    await flow.addExclusion("  Movies/Cache/ ");
    await flow.addExclusion("*.tmp");
    await flow.addExclusion("node_modules");
    await flow.removeExclusion("*.tmp");

    assert.deepEqual(stateOf(flow).exclusions, ["Movies/Cache", "node_modules"]);
    assert.deepEqual(stateOf(await open()).exclusions, ["Movies/Cache", "node_modules"], "remembered when the app opens again");
    assert.deepEqual(JSON.parse(await readFile(exclusionsFile, "utf8")), { exclusions: ["Movies/Cache", "node_modules"] });
  });

  it("refuses a pattern it cannot use, or one already listed, saying why and saving nothing", async () => {
    const { flow, open } = await pairedMac();
    await flow.addExclusion("Scratch");

    await flow.addExclusion("*");
    assert.match(stateOf(flow).exclusionProblem, /everything on the drive/);
    await flow.addExclusion("scratch/");
    assert.match(stateOf(flow).exclusionProblem, /already/);

    assert.deepEqual(stateOf(flow).exclusions, ["Scratch"]);
    assert.deepEqual(stateOf(await open()).exclusions, ["Scratch"]);
    await flow.addExclusion("Other");
    assert.equal(stateOf(flow).exclusionProblem, undefined, "cleared once a pattern is added");
  });

  it("leaves what the Exclusions match out of the review, and Apply never copies, moves or deletes it", async () => {
    const { flow, replica } = await pairedMac(
      { "Scratch/new.txt": "x", "Work/a.tmp": "x", "Work/keep.txt": "x", "New/photo.jpg": "same" },
      { "Scratch/old.txt": "x", "Old/photo.jpg": "same", "Docs/gone.pdf": "x" },
    );
    await flow.addExclusion("Scratch");
    await flow.addExclusion("*.tmp");
    await flow.addExclusion("/Old");

    await flow.compare();
    const { review } = stateOf(flow);
    assert.deepEqual(review.exclusions, ["Scratch", "*.tmp", "/Old"]);
    assert.deepEqual(review.new.files.map((file: { path: string }) => file.path), ["New/photo.jpg", "Work/keep.txt"]);
    assert.deepEqual(review.moves.moves, []);
    assert.deepEqual(review.deleted.files.map((file: { path: string }) => file.path), ["Docs/gone.pdf"]);
    flow.approveCopies(true);
    toSummaryApprovingDeletions(flow);
    await flow.apply();

    assert.equal(stateOf(flow).step, "result");
    assert.deepEqual(stateOf(flow).failed, []);
    const files = (await readdir(replica, { recursive: true, withFileTypes: true })).filter((entry) => !entry.isDirectory());
    assert.deepEqual(files.map((entry) => join(entry.parentPath, entry.name).slice(replica.length + 1)).sort(), [
      ".sync-drive-last-updated",
      "New/photo.jpg",
      "Old/photo.jpg",
      "Scratch/old.txt",
      "Work/keep.txt",
      "sync-drive Holding Area/Docs/gone.pdf",
      "sync-drive Holding Area/READ ME.txt",
    ]);  });

  it("refuses to compare, saying why, when the saved Exclusions are damaged", async () => {
    const mac = await testMac();
    const primary = await makePrimary({ "a.txt": "x" });
    const replica = await makeTree();
    mac.volumes.connect(primary, "PRIMARY-ID");
    mac.volumes.connect(replica, "REPLICA-ID");
    const first = await mac.open();
    first.choose("primary", primary);
    first.choose("replica", replica);
    await first.pair();
    await writeFile(mac.exclusionsFile, "{ not json");

    const flow = await mac.open();
    assert.match(stateOf(flow).exclusionProblem, /damaged/);
    await flow.compare();
    await flow.addExclusion("Scratch");

    assert.equal(stateOf(flow).step, "start");
    assert.match(stateOf(flow).error, /damaged/);
    assert.equal(await readFile(mac.exclusionsFile, "utf8"), "{ not json", "not overwritten");
  });
});

describe("app flow: limiting a run to one folder", () => {
  it("compares and updates only the folder chosen on Start, leaving everything outside it alone", async () => {
    const { flow, primary, replica, updateLogs } = await pairedMac(
      { "Photos/2019/new.jpg": "n", "Photos/2019/Iceland/moved.jpg": "m", "Photos/2020/new.jpg": "n", "Elsewhere/arrived.jpg": "a" },
      { "Photos/2019/moved.jpg": "m", "Photos/2019/arrived.jpg": "a", "Photos/2020/gone.jpg": "g", "old.txt": "o" },
    );

    await flow.limitTo(join(primary, "Photos", "2019"));
    assert.equal(stateOf(flow).only, "Photos/2019");
    await flow.compare();

    const { review } = stateOf(flow);
    assert.equal(review.only, "Photos/2019");
    assert.deepEqual(review.new.files.map((file: { path: string }) => file.path), ["Photos/2019/new.jpg"]);
    assert.deepEqual(review.moves.moves.map((move: { to: string }) => move.to), ["Photos/2019/Iceland/moved.jpg"]);
    assert.deepEqual(review.deleted.files.map((file: { path: string }) => file.path), ["Photos/2019/arrived.jpg"]);
    flow.approveCopies(true);
    flow.next();
    flow.approveMoves(true);
    flow.next();
    flow.approveDeletions(true);
    flow.next();
    await flow.apply();

    assert.equal(stateOf(flow).step, "result");
    assert.equal(stateOf(flow).only, "Photos/2019");
    const files = (await readdir(replica, { recursive: true, withFileTypes: true })).filter((entry) => !entry.isDirectory());
    assert.deepEqual(files.map((entry) => join(entry.parentPath, entry.name).slice(replica.length + 1)).sort(), [
      ".sync-drive-last-updated",
      "Photos/2019/Iceland/moved.jpg",
      "Photos/2019/new.jpg",
      "Photos/2020/gone.jpg",
      "old.txt",
      "sync-drive Holding Area/Photos/2019/arrived.jpg",
      "sync-drive Holding Area/READ ME.txt",
    ]);
    const [log] = await updateLogs();
    assert.match(log!, /^Limited to the folder: "Photos\/2019"$/m);
    await flow.restart();
    assert.equal(stateOf(flow).only, "Photos/2019", "kept on Start until changed");
    const { lastUpdated } = stateOf(flow);
    assert.equal(lastUpdated.wholeDrive, undefined, "the whole drive was not updated");
    assert.deepEqual(lastUpdated.folders.map((entry: { folder: string }) => entry.folder), ["Photos/2019"]);
  });

  it("goes back to the whole drive when asked, or when the top of the Primary is chosen", async () => {
    const { flow, primary } = await pairedMac({ "Photos/2019/a.jpg": "a", "top.txt": "t" });

    await flow.limitTo(join(primary, "Photos", "2019"));
    flow.wholeDrive();
    assert.equal(stateOf(flow).only, undefined);
    await flow.limitTo(join(primary, "Photos"));
    await flow.limitTo(primary);
    assert.equal(stateOf(flow).only, undefined);

    await flow.compare();
    assert.equal(stateOf(flow).review.only, undefined);
    assert.equal(stateOf(flow).review.new.count, 2);
  });

  it("refuses a folder that is not on the Primary, keeping the choice as it was", async () => {
    const { flow, primary, replica } = await pairedMac({ "Photos/2019/a.jpg": "a" });
    await flow.limitTo(join(primary, "Photos"));

    await flow.limitTo(join(replica, "Photos"));

    assert.equal(stateOf(flow).only, "Photos");
    assert.match(stateOf(flow).error, /not on the Primary/);
  });

  it("stays on Start, saying why, when the folder is no longer on the Primary", async () => {
    const { flow, primary } = await pairedMac({ "Photos/2019/a.jpg": "a" });
    await flow.limitTo(join(primary, "Photos", "2019"));
    await ownerChangesPrimary(primary, () => rm(join(primary, "Photos"), { recursive: true }));

    await flow.compare();

    assert.equal(stateOf(flow).step, "start");
    assert.match(stateOf(flow).error, /The Primary has no folder "Photos\/2019"/);
  });

  it("says the folder matches when nothing in it differs, even when other folders do", async () => {
    const { flow, primary } = await pairedMac({ "Photos/2019/a.jpg": "a", "other.txt": "o" }, { "Photos/2019/a.jpg": "a" });
    await flow.limitTo(join(primary, "Photos", "2019"));

    await flow.compare();

    assert.equal(stateOf(flow).step, "start");
    assert.match(stateOf(flow).notice, /The folder "Photos\/2019" on the Replica matches the Primary/);
  });

  it("measures the Safety stop against the folder, and says so", async () => {
    const { flow, primary } = await pairedMac(
      { ...files("Other/", 2000), ...files("Photos/kept/", 99) },
      { ...files("Other/", 2000), ...files("Photos/kept/", 99), ...files("Photos/gone/", 101) },
    );
    await flow.limitTo(join(primary, "Photos"));

    await flow.compare();

    const { safetyStop } = stateOf(flow);
    assert.deepEqual(safetyStop, { deleted: { count: 101, totalSize: 101 }, replica: { count: 200, totalSize: 200 }, only: "Photos" });
    assert.match(
      safetyStopExplanation(safetyStop),
      /^The Safety stop applies: 101 files \(101 B\) are no longer on the Primary\. That is 101 of the 200 files in "Photos" on the Replica \(50\.5%\) and 101 B of their 200 B \(50\.5%\), more than 10% of the folder\./,
    );
  });

  it("notes on the review steps and the Summary that the run is limited, and that moves across its edge show as new or deleted", () => {
    const note = onlyFolderNote("Photos/2019");

    assert.match(note, /Limited to the folder "Photos\/2019"/);
    assert.match(note, /nothing outside it is compared, copied, moved or deleted/);
    assert.match(note, /moved into or out of it .* appear as new or deleted/);
  });

  it("warns on Deletions that a file moved out of the folder may be the only backup of one that cannot be read on the Primary", () => {
    const warning = onlyFolderDeletionsWarning("Photos/2019");

    assert.match(warning, /moved out of "Photos\/2019" on the Primary show here as deleted/);
    assert.match(warning, /cannot be read on the Primary/);
    assert.match(warning, /leave the deletions unapproved until an Update of the whole drive/);
  });
});

describe("app flow: Deep verify and Anomalies", () => {
  /**
   * `a.txt` and `b.txt` match by size and date but not by contents, `old.txt` is newer on the Replica,
   * `Photos/x.jpg` moved, and `gone.txt` is only on the Replica.
   */
  const ANOMALY_PRIMARY: TreeSpec = {
    "a.txt": "AAAA",
    "b.txt": "BBBB",
    "same.txt": "same",
    "old.txt": { content: "primary", mtime: new Date("2026-02-01T09:00:00Z") },
    "Photos/2026/x.jpg": "xx",
  };
  const ANOMALY_REPLICA: TreeSpec = {
    "a.txt": "zzzz",
    "b.txt": "yyyy",
    "same.txt": "same",
    "old.txt": { content: "replica", mtime: new Date("2026-03-01T09:00:00Z") },
    "Photos/x.jpg": "xx",
    "gone.txt": "gone",
  };

  /** A Mac with the anomaly drives paired, Deep verify chosen on Start, and compared. */
  async function deepVerified() {
    const mac = await pairedMac(ANOMALY_PRIMARY, ANOMALY_REPLICA);
    mac.flow.deepVerify(true);
    await mac.flow.compare();
    assert.equal(mac.flow.state.step, "copies");
    return mac;
  }

  it("is chosen on Start and kept there until changed, with Quick compare the default", async () => {
    const { flow } = await pairedMac({ "a.txt": "AAAA" }, { "a.txt": "zzzz" });
    assert.equal(stateOf(flow).deep, false);

    await flow.compare();
    assert.equal(stateOf(flow).step, "start", "a Quick compare reads no contents, so finds them equal");
    assert.equal(stateOf(flow).deep, false);

    flow.deepVerify(true);
    assert.equal(stateOf(flow).deep, true);
    await flow.compare();
    assert.equal(stateOf(flow).step, "copies", "a Deep verify finds the content mismatch");
    assert.equal(stateOf(flow).review.deep, true);
    flow.restart();
    assert.equal(stateOf(flow).deep, true, "still chosen for the next comparison");
    flow.deepVerify(false);
    assert.equal(stateOf(flow).deep, false);
  });

  it("shows the checksum phase's progress by bytes while comparing", async () => {
    const { flow } = await pairedMac({ "a.txt": "12345", "b.txt": "123" }, { "a.txt": "12345", "b.txt": "123" });
    flow.deepVerify(true);
    const comparing: Record<string, any>[] = [];
    flow.onChange((state) => {
      if (state.step === "comparing") comparing.push(state);
    });

    await flow.compare();

    assert.ok(comparing.every((state) => state.deep === true));
    const verifying = comparing.map((state) => state.progress).filter((progress) => progress?.phase === "verifying");
    assert.deepEqual(verifying.at(-1), { phase: "verifying", checkedBytes: 16, totalBytes: 16 });
  });

  it("flags on Copies the files whose Replica copy is newer, which the copies Approval replaces with the Primary's", async () => {
    const { flow, replica } = await deepVerified();
    const { review } = stateOf(flow);
    assert.deepEqual(review.anomalies.replicaNewer.files, [{ path: "old.txt", size: 7 }]);
    assert.deepEqual(review.changed.files, [{ path: "old.txt", size: 7 }]);

    flow.approveCopies(true);
    toSummary(flow);
    await flow.apply();

    assert.deepEqual(stateOf(flow).copied, [{ path: "old.txt", size: 7 }]);
    assert.equal(await readFile(join(replica, "old.txt"), "utf8"), "primary");
  });

  it("puts the Anomalies step after Copies and before Moves and Deletions, with no file chosen", async () => {
    const { flow } = await deepVerified();

    flow.next();

    assert.equal(stateOf(flow).step, "anomalies");
    const { review } = stateOf(flow);
    assert.deepEqual(review.anomalies.contentMismatch.files, [{ path: "a.txt", size: 4 }, { path: "b.txt", size: 4 }]);
    assert.deepEqual(review.mismatchChoices, {});
    flow.next();
    assert.equal(stateOf(flow).step, "moves");
    flow.next();
    assert.equal(stateOf(flow).step, "deletions");
    flow.back();
    flow.back();
    assert.equal(stateOf(flow).step, "anomalies");
  });

  it("skips Anomalies when there is no content mismatch", async () => {
    const { flow } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    flow.deepVerify(true);
    await flow.compare();

    flow.next();

    assert.equal(stateOf(flow).step, "deletions");
  });

  it("keeps each per-file choice through Back and Next, and shows them all on the Summary", async () => {
    const { flow } = await deepVerified();
    flow.next();
    flow.chooseForMismatch("a.txt", "overwrite");
    flow.chooseForMismatch("b.txt", "keep");
    flow.chooseForMismatch("b.txt", "overwrite");
    flow.chooseForMismatch("b.txt", "keep");
    flow.chooseForMismatch("same.txt", "overwrite");

    flow.back();
    flow.next();
    assert.equal(stateOf(flow).step, "anomalies");
    assert.deepEqual(stateOf(flow).review.mismatchChoices, { "a.txt": "overwrite", "b.txt": "keep" }, "only content mismatches can be chosen");
    flow.next();
    flow.next();
    flow.next();

    assert.equal(stateOf(flow).step, "summary");
    assert.deepEqual(stateOf(flow).review.mismatchChoices, { "a.txt": "overwrite", "b.txt": "keep" });
    assert.deepEqual(stateOf(flow).apply.overwrite, { count: 1, totalSize: 4 });
    assert.deepEqual(stateOf(flow).apply.keep, { count: 1, totalSize: 4 });
    assert.deepEqual(stateOf(flow).apply.leaveUndecided, { count: 0, totalSize: 0 });
  });

  it("leaves a content mismatch with no choice out of the Update, saying so on the Summary", async () => {
    const { flow, replica } = await deepVerified();
    flow.next();
    flow.chooseForMismatch("a.txt", "overwrite");
    flow.next();
    flow.next();
    flow.next();

    assert.deepEqual(stateOf(flow).apply.leaveUndecided, { count: 1, totalSize: 4 });
    await flow.apply();

    assert.deepEqual(stateOf(flow).copied, [{ path: "a.txt", size: 4 }]);
    assert.equal(await readFile(join(replica, "a.txt"), "utf8"), "AAAA");
    assert.equal(await readFile(join(replica, "b.txt"), "utf8"), "yyyy");
  });

  it("logs on the Mac everything the Update did and left, with the reasons", async () => {
    const { flow, replica, updateLogs } = await deepVerified();
    flow.approveCopies(true);
    flow.next();
    flow.chooseForMismatch("a.txt", "overwrite");
    flow.next();
    flow.approveMoves(true);
    flow.next();
    flow.approveDeletions(true);
    flow.next();
    // Something the Update cannot do: a folder where the moved file goes.
    await mkdir(join(replica, "Photos/2026/x.jpg"), { recursive: true });

    await flow.apply();

    const logs = await updateLogs();
    assert.equal(logs.length, 1);
    assert.equal(stateOf(flow).updateLog.endsWith(" Update.txt"), true);
    const [heading, finished, ...rest] = logs[0]!.split("\n");
    assert.equal(heading, "sync-drive Update log");
    assert.match(finished!, /^Finished: \d{1,2} [A-Z][a-z]+ \d{4} at \d{2}:\d{2}:\d{2}$/);
    const { pairing } = stateOf(flow);
    assert.deepEqual(rest, [
      `Primary: "${pairing.primary.name}" (volume ID PRIMARY-ID)`,
      `Replica: "${pairing.replica.name}" (volume ID REPLICA-ID)`,
      "Compared by: Deep verify",
      "",
      "Copied: 1 file (7 B)",
      "  old.txt (7 B)",
      "",
      "Content mismatches overwritten with the Primary's copy: 1 file (4 B)",
      "  a.txt (4 B)",
      "",
      "Content mismatches left as they are: 1 file (4 B)",
      "  b.txt (4 B): no choice was made",
      "",
      "Renamed: none",
      "",
      "Not renamed: 1 file",
      "  Photos/x.jpg → Photos/2026/x.jpg: the Replica already has a file at its new path",
      "",
      "Moved into the Holding area: 1 file (4 B)",
      "  gone.txt (4 B)",
      "",
    ]);
  });

  it("honours each choice on Apply, with no Approval given: overwrites the chosen Replica copies and keeps the others", async () => {
    const { flow, primary, replica } = await deepVerified();
    flow.next();
    flow.chooseForMismatch("a.txt", "keep");
    flow.chooseForMismatch("b.txt", "overwrite");
    flow.next();
    flow.next();
    flow.next();
    assert.equal(stateOf(flow).step, "summary");
    assert.deepEqual(stateOf(flow).apply.copy, { count: 0, totalSize: 0 });

    await flow.apply();

    assert.equal(stateOf(flow).step, "result");
    assert.deepEqual(stateOf(flow).copied, [{ path: "b.txt", size: 4 }]);
    assert.deepEqual(stateOf(flow).overwritten, [{ path: "b.txt", size: 4 }]);
    assert.equal(await readFile(join(replica, "a.txt"), "utf8"), "zzzz");
    assert.equal(await readFile(join(replica, "b.txt"), "utf8"), "BBBB");
    assert.deepEqual(await readdir(join(replica, "Photos")), ["x.jpg"], "the moves were not approved");
    const after = await compare(primary, replica, { deep: true });
    assert.deepEqual(after.anomalies.contentMismatch.files, [{ path: "a.txt", size: 4 }]);
  });

  it("discards the choices with the comparison", async () => {
    const { flow } = await deepVerified();
    flow.next();
    flow.chooseForMismatch("a.txt", "overwrite");
    flow.restart();

    await flow.compare();
    flow.next();

    assert.equal(stateOf(flow).step, "anomalies");
    assert.deepEqual(stateOf(flow).review.mismatchChoices, {});
  });
});


describe("app flow: the Holding area on the Result", () => {
  it("shows what the Holding area holds after the Update, and when it was last added to", async () => {
    const { flow } = await pairedMac({ "a.txt": "same" }, { "a.txt": "same", "Docs/gone.txt": "12345" });
    await flow.compare();
    toSummaryApprovingDeletions(flow);

    await flow.apply();

    assert.deepEqual(stateOf(flow).holdingArea, { count: 1, totalSize: 5, lastAddedOn: formatDay(new Date()) });
  });

  it("counts what an earlier Update left there too, even when this one added nothing", async () => {
    const { flow } = await pairedMac(
      { "a.txt": "same", "new.txt": "new" },
      { "a.txt": "same", "sync-drive Holding Area/old.txt": "held", "sync-drive Holding Area/READ ME.txt": holdingAreaReadme(new Date(2026, 5, 3)) },
    );
    await flow.compare();
    flow.approveCopies(true);
    toSummary(flow);

    await flow.apply();

    assert.deepEqual(stateOf(flow).holdingArea, { count: 1, totalSize: 4, lastAddedOn: "3 June 2026" });
  });
});

describe("app flow: when the Replica was last updated", () => {
  it("shows on Start that sync-drive has never updated a fresh Replica", async () => {
    const { flow } = await pairedMac();

    assert.deepEqual(stateOf(flow).lastUpdated, { known: true, folders: [] });
  });

  it("shows on Start, after the Update and when the app opens again, that the whole drive was just updated", async () => {
    const { flow, open } = await pairedMac(EXAMPLE_PRIMARY, EXAMPLE_REPLICA);
    const before = Date.now();
    await flow.compare();
    flow.approveCopies(true);
    toSummary(flow);
    await flow.apply();

    await flow.restart();

    assert.equal(stateOf(flow).step, "start");
    const { known, wholeDrive, folders } = stateOf(flow).lastUpdated;
    assert.equal(known, true);
    assert.ok(Date.parse(wholeDrive) >= before && Date.parse(wholeDrive) <= Date.now(), "the date of this Update");
    assert.deepEqual(folders, []);
    assert.deepEqual(stateOf(await open()).lastUpdated, stateOf(flow).lastUpdated);
  });

  it("says the Replica must be connected to know, and reads it once it is", async () => {
    const { flow, volumes, replica, open } = await pairedMac({}, { ".sync-drive-last-updated": '{"wholeDrive":"2026-08-20T10:00:00.000Z","folders":[]}' });
    volumes.disconnect(replica);
    const reopened = await open();

    assert.deepEqual(stateOf(reopened).lastUpdated, { known: false, reason: "Connect the Replica to see when it was last updated." });

    volumes.connect(replica, "REPLICA-ID");
    await reopened.drivesChanged();

    assert.deepEqual(stateOf(reopened).lastUpdated, { known: true, wholeDrive: "2026-08-20T10:00:00.000Z", folders: [] });
    assert.equal(stateOf(flow).step, "start");
  });

  it("says when the marker is damaged, and still compares", async () => {
    const { flow } = await pairedMac({ "a.txt": "a" }, { ".sync-drive-last-updated": "garbage" });

    assert.equal(stateOf(flow).lastUpdated.known, false);
    assert.match(stateOf(flow).lastUpdated.reason, /damaged/);
    await flow.compare();
    assert.equal(stateOf(flow).step, "copies");
  });
});
