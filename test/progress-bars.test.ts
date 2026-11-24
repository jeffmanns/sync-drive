import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { comparingBar, updatingBar, updatingLines } from "../src/app/view.ts";

describe("The Comparing bar", () => {
  it("shows items scanned out of the drives' item counts", () => {
    assert.deepEqual(comparingBar({ phase: "scanning", scanned: 250, total: 1000 }), {
      fraction: 0.25,
      label: "Step 1 of 2, reading both drives: 250 of about 1,000 items",
    });
  });

  it("never shows 100% before the compare finishes, even when the scan passes the count", () => {
    assert.equal(comparingBar({ phase: "scanning", scanned: 1000, total: 1000 }).fraction, 0.99);
    assert.equal(comparingBar({ phase: "scanning", scanned: 1500, total: 1000 }).fraction, 0.99);
    assert.equal(comparingBar({ phase: "checking moves", checkedBytes: 2000, totalBytes: 2000 }).fraction, 0.99);
  });

  it("is a moving bar with no percentage when a drive has no usable count, or before the counts are read", () => {
    assert.deepEqual(comparingBar({ phase: "scanning", scanned: 1234 }), { label: "Step 1 of 2, reading both drives: 1,234 items" });
    assert.equal(comparingBar({ phase: "scanning", scanned: 0, total: 0 }).fraction, undefined);
    assert.deepEqual(comparingBar(undefined), { label: "Step 1 of 2, reading both drives: counting their items" });
  });

  it("shows bytes read to confirm moves, out of the bytes to read, as the second of two labelled stages", () => {
    assert.deepEqual(comparingBar({ phase: "checking moves", checkedBytes: 500_000, totalBytes: 2_000_000 }), {
      fraction: 0.25,
      label: "Step 2 of 2, confirming moved files by checksum: 500.0 KB of 2.0 MB",
    });
  });
});

describe("The Comparing bar for a Deep verify", () => {
  it("shows bytes read to verify contents as the second of three labelled stages, then the moves as the third", () => {
    assert.deepEqual(comparingBar({ phase: "scanning", scanned: 250, total: 1000 }, true), {
      fraction: 0.25,
      label: "Step 1 of 3, reading both drives: 250 of about 1,000 items",
    });
    assert.deepEqual(comparingBar({ phase: "verifying", checkedBytes: 500_000, totalBytes: 2_000_000 }, true), {
      fraction: 0.25,
      label: "Step 2 of 3, verifying contents by checksum: 500.0 KB of 2.0 MB",
    });
    assert.equal(comparingBar({ phase: "verifying", checkedBytes: 2_000_000, totalBytes: 2_000_000 }, true).fraction, 0.99);
    assert.deepEqual(comparingBar({ phase: "checking moves", checkedBytes: 500_000, totalBytes: 2_000_000 }, true), {
      fraction: 0.25,
      label: "Step 3 of 3, confirming moved files by checksum: 500.0 KB of 2.0 MB",
    });
    assert.deepEqual(comparingBar(undefined, true), { label: "Step 1 of 3, reading both drives: counting their items" });
  });
});

describe("The Updating bar", () => {
  const progress = (copies: { copiedBytes: number; notCopiedBytes: number; totalBytes: number }) => ({
    deletions: { done: 0, total: 0 },
    moves: { done: 0, total: 0 },
    copies,
  });

  it("shows bytes copied out of the approved total", () => {
    assert.deepEqual(updatingBar(progress({ copiedBytes: 1_500_000, notCopiedBytes: 0, totalBytes: 6_000_000 })), {
      fraction: 0.25,
      label: "Copied 1.5 MB of 6.0 MB",
    });
  });

  it("moves past files that could not be copied, and says how much could not be", () => {
    assert.deepEqual(updatingBar(progress({ copiedBytes: 1_000_000, notCopiedBytes: 2_000_000, totalBytes: 4_000_000 })), {
      fraction: 0.75,
      label: "Copied 1.0 MB of 4.0 MB (2.0 MB could not be copied)",
    });
  });

  it("is full once every copy is done", () => {
    assert.equal(updatingBar(progress({ copiedBytes: 4_000, notCopiedBytes: 0, totalBytes: 4_000 }))?.fraction, 1);
  });

  it("is headed by the deleted files and the moves dealt with, only for what was approved", () => {
    assert.deepEqual(
      updatingLines({ deletions: { done: 3, total: 10 }, moves: { done: 0, total: 1 }, copies: { copiedBytes: 0, notCopiedBytes: 0, totalBytes: 0 } }),
      ["Moved into the Holding area: 3 of 10 files", "Renamed on the Replica: 0 of 1 file"],
    );
    assert.deepEqual(updatingLines(progress({ copiedBytes: 0, notCopiedBytes: 0, totalBytes: 5 })), []);
    assert.deepEqual(updatingLines(undefined), []);
  });

  it("is not shown when nothing is copied, nor before the Update starts", () => {
    assert.equal(updatingBar(progress({ copiedBytes: 0, notCopiedBytes: 0, totalBytes: 0 })), undefined);
    assert.equal(updatingBar(undefined), undefined);
  });
});
