import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { comparingBar, copiesBar } from "../src/app/view.ts";

describe("The Comparing bar", () => {
  it("shows items scanned out of the drives' item counts", () => {
    assert.deepEqual(comparingBar({ phase: "scanning", scanned: 250, total: 1000 }), {
      fraction: 0.25,
      label: "Read 250 of about 1,000 items",
    });
  });

  it("never shows 100% before the compare finishes, even when the scan passes the count", () => {
    assert.equal(comparingBar({ phase: "scanning", scanned: 1000, total: 1000 }).fraction, 0.99);
    assert.equal(comparingBar({ phase: "scanning", scanned: 1500, total: 1000 }).fraction, 0.99);
    assert.equal(comparingBar({ phase: "checking moves", checkedBytes: 2000, totalBytes: 2000 }).fraction, 0.99);
  });

  it("is a moving bar with no percentage when a drive has no usable count, or before the counts are read", () => {
    assert.deepEqual(comparingBar({ phase: "scanning", scanned: 1234 }), { label: "Read 1,234 items" });
    assert.equal(comparingBar({ phase: "scanning", scanned: 0, total: 0 }).fraction, undefined);
    assert.deepEqual(comparingBar(undefined), { label: "Counting the items on both drives" });
  });

  it("shows bytes read to confirm moves, out of the bytes to read", () => {
    assert.deepEqual(comparingBar({ phase: "checking moves", checkedBytes: 500_000, totalBytes: 2_000_000 }), {
      fraction: 0.25,
      label: "Confirming moved files by checksum: read 500.0 KB of 2.0 MB",
    });
  });
});

describe("The Updating bar", () => {
  const progress = (copies: { copiedBytes: number; notCopiedBytes: number; totalBytes: number }) => ({
    deletions: { done: 0, total: 0 },
    moves: { done: 0, total: 0 },
    copies,
  });

  it("shows bytes copied out of the approved total", () => {
    assert.deepEqual(copiesBar(progress({ copiedBytes: 1_500_000, notCopiedBytes: 0, totalBytes: 6_000_000 })), {
      fraction: 0.25,
      label: "Copied 1.5 MB of 6.0 MB",
    });
  });

  it("moves past files that could not be copied, and says how much could not be", () => {
    assert.deepEqual(copiesBar(progress({ copiedBytes: 1_000_000, notCopiedBytes: 2_000_000, totalBytes: 4_000_000 })), {
      fraction: 0.75,
      label: "Copied 1.0 MB of 4.0 MB (2.0 MB could not be copied)",
    });
  });

  it("is full once every copy is done", () => {
    assert.equal(copiesBar(progress({ copiedBytes: 4_000, notCopiedBytes: 0, totalBytes: 4_000 }))?.fraction, 1);
  });

  it("is not shown when nothing is copied, nor before the Update starts", () => {
    assert.equal(copiesBar(progress({ copiedBytes: 0, notCopiedBytes: 0, totalBytes: 0 })), undefined);
    assert.equal(copiesBar(undefined), undefined);
  });
});
