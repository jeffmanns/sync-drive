import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { compare, safetyStopApplies } from "../src/engine/index.ts";
import { makeTree, removeTrees, type TreeSpec } from "./helpers/trees.ts";

after(removeTrees);

/** `count` one-byte files named `<prefix>0.txt`, `<prefix>1.txt`, … */
function files(prefix: string, count: number): TreeSpec {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}.txt`, "x"]));
}

describe("Safety stop", () => {
  it("applies when the deleted files are more than 10% of the Replica's files, and more than 100", () => {
    assert.equal(safetyStopApplies({ count: 101, totalSize: 101 }, { count: 1_000, totalSize: 1_000_000 }), true);
  });

  it("does not apply at exactly 10% of the files and of the size", () => {
    assert.equal(safetyStopApplies({ count: 101, totalSize: 101 }, { count: 1_010, totalSize: 1_010 }), false);
  });

  it("applies when the deleted files are more than 10% of the Replica's size, though few by count", () => {
    assert.equal(safetyStopApplies({ count: 101, totalSize: 1_001 }, { count: 100_000, totalSize: 10_000 }), true);
  });

  it("never applies to 100 deleted files or fewer, even if that is the whole Replica", () => {
    assert.equal(safetyStopApplies({ count: 100, totalSize: 5_000 }, { count: 100, totalSize: 5_000 }), false);
  });

  it("does not apply to a month of photos moved on a large Replica", () => {
    assert.equal(
      safetyStopApplies({ count: 250, totalSize: 750_000_000 }, { count: 100_000, totalSize: 500_000_000_000 }),
      false,
    );
  });

  it("is stated in the report, measured against the Replica's contents for comparison only", async () => {
    // 101 deleted of 1,001 files is over 10%. Files in the Holding area and Incoming folder would push the
    // Replica past 1,010 files, and the stop below 10%, if they were wrongly counted.
    const primary = await makeTree(files("kept/", 900));
    const replica = await makeTree({
      ...files("kept/", 900),
      ...files("gone/", 101),
      ...files("sync-drive Holding Area/old/", 50),
      ...files(".sync-drive-incoming/", 50),
    });

    const report = await compare(primary, replica);

    assert.deepEqual(report.replica, { count: 1_001, totalSize: 1_001 });
    assert.equal(report.deleted.count, 101);
    assert.equal(report.safetyStop, true);
  });

  it("is stated in the report as not applying when few files are deleted", async () => {
    const primary = await makeTree({ "a.txt": "a" });
    const replica = await makeTree({ "a.txt": "a", "b.txt": "b" });

    const report = await compare(primary, replica);

    assert.deepEqual(report.replica, { count: 2, totalSize: 2 });
    assert.equal(report.safetyStop, false);
  });
});
