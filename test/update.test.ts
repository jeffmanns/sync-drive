import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, lutimes, mkdir, readdir, readFile, readlink, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { after, describe, it } from "node:test";
import { compare, readHoldingArea, readLastUpdated, update, UpdateStoppedError, type Approvals, type FileCopier, type UpdateProgress } from "../src/engine/index.ts";
import { MacFileCopier } from "../src/macos/file-copier.ts";
import {
  extendedAttributes,
  makeDiskImageTree,
  makeTree,
  metadataOf,
  removeTrees,
  snapshotTree,
  type TreeSpec,
} from "./helpers/trees.ts";

after(removeTrees);

const run = promisify(execFile);

const APPROVED: Approvals = { update: true, moves: false, deletions: false };
const APPROVED_WITH_DELETIONS: Approvals = { update: true, moves: false, deletions: true };
const APPROVED_WITH_MOVES: Approvals = { update: true, moves: true, deletions: false };

/** `snapshot` (of a Replica) without the last-updated marker, which every Update that finishes rewrites. */
function withoutMarker(snapshot: string[]): string[] {
  return snapshot.filter((line) => !line.startsWith("file .sync-drive-last-updated "));
}

/**
 * Compares, runs an Update with `approvals`, and checks the Primary came through untouched:
 * byte for byte and metadata for metadata.
 */
async function compareAndUpdate(
  primary: string,
  replica: string,
  approvals: Approvals = APPROVED,
  copier: FileCopier = new MacFileCopier(),
) {
  const primaryBefore = await snapshotTree(primary);
  const report = await compare(primary, replica);
  const result = await update(report, approvals, { primary, replica, copier });
  assert.deepEqual(await snapshotTree(primary), primaryBefore, "the Primary must never be written to");
  return result;
}

describe("Update", () => {
  it("copies new files, so a following Quick compare finds no differences", async () => {
    const primary = await makeTree({ "Photos/2026/beach.jpg": "12345", "notes.txt": "hello" });
    const replica = await makeTree();

    const result = await compareAndUpdate(primary, replica);

    assert.deepEqual(result.copied, [
      { path: "Photos/2026/beach.jpg", size: 5 },
      { path: "notes.txt", size: 5 },
    ]);
    assert.deepEqual(result.failed, []);
    const after = await compare(primary, replica);
    assert.equal(after.new.count + after.changed.count + after.deleted.count, 0);
  });

  it("replaces changed files with the Primary's version", async () => {
    const primary = await makeTree({
      "notes.txt": { content: "edited on the Primary", mtime: new Date("2026-03-01T09:00:00Z") },
    });
    const replica = await makeTree({
      "notes.txt": { content: "the old text", mtime: new Date("2026-02-01T09:00:00Z") },
    });

    const result = await compareAndUpdate(primary, replica);

    assert.deepEqual(result.copied, [{ path: "notes.txt", size: 21 }]);
    assert.equal(await readFile(join(replica, "notes.txt"), "utf8"), "edited on the Primary");
    const after = await compare(primary, replica);
    assert.equal(after.changed.count, 0);
  });

  it("keeps the modification and creation dates, Finder tags, extended attributes and flags", async () => {
    const primary = await makeDiskImageTree({ "Photos/tagged.jpg": "a photo" }, { name: "Primary" });
    const replica = await makeDiskImageTree({}, { name: "Replica" });
    const file = join(primary, "Photos/tagged.jpg");
    // Setting an earlier modification date also moves the creation date back; then move only the
    // modification date forward, so the two dates differ.
    const created = new Date("2020-01-01T00:00:00Z");
    await utimes(file, created, created);
    await utimes(file, 1_700_000_000.123456, 1_700_000_000.123456);
    await run("xattr", ["-wx", "com.apple.metadata:_kMDItemUserTags", RED_TAG_HEX, file]);
    await run("xattr", ["-w", "com.example.note", "kept", file]);
    await run("chflags", ["hidden", file]);

    await compareAndUpdate(primary, replica);

    const copy = join(replica, "Photos/tagged.jpg");
    const stats = await lstat(copy, { bigint: true });
    assert.equal(stats.birthtimeNs, 1_577_836_800_000_000_000n);
    assert.equal(stats.mtimeNs / 1000n, 1_700_000_000_123_456n);
    const xattrs = await extendedAttributes(copy);
    assert.equal(xattrs["com.apple.metadata:_kMDItemUserTags"], RED_TAG_HEX);
    assert.equal(Buffer.from(xattrs["com.example.note"]!, "hex").toString(), "kept");
    assert.equal(await metadataOf(copy), await metadataOf(file));
  });

  it("hides leftover temporary files from an interrupted run, and clears them on the next Update", async () => {
    const primary = await makeTree({ "a.txt": "same" });
    const replica = await makeTree({
      "a.txt": "same",
      ".sync-drive-incoming/8d7f0a52-interrupted": "half a fi",
    });

    const report = await compare(primary, replica);
    assert.equal(report.new.count + report.changed.count + report.deleted.count, 0);

    await compareAndUpdate(primary, replica);

    assert.deepEqual((await readdir(replica)).sort(), [".sync-drive-last-updated", "a.txt"]);
  });

  it("never leaves a part-copied file under a real name, and carries on with the other files", async () => {
    const primary = await makeTree({ "big.mov": "the whole new film", "small.txt": "fine" });
    const replica = await makeTree({ "big.mov": { content: "the old film", mtime: new Date("2025-01-01") } });
    const replicaBigBefore = await metadataOf(join(replica, "big.mov"));
    const interrupted: FileCopier = {
      async copy(source, destination) {
        if (!source.endsWith("big.mov")) return new MacFileCopier().copy(source, destination);
        await writeFile(destination, "the whole");
        throw new Error("the drive was disconnected");
      },
    };

    const result = await compareAndUpdate(primary, replica, APPROVED, interrupted);

    assert.deepEqual(result.copied, [{ path: "small.txt", size: 4 }]);
    assert.deepEqual(result.failed, [{ path: "big.mov", size: 18, reason: "the drive was disconnected" }]);
    assert.equal(await readFile(join(replica, "big.mov"), "utf8"), "the old film");
    assert.equal(await metadataOf(join(replica, "big.mov")), replicaBigBefore);
    const after = await compare(primary, replica);
    assert.deepEqual(after.changed.files, [{ path: "big.mov", size: 18 }]);
    assert.equal(after.new.count + after.deleted.count, 0);
  });

  it("checks every copy's checksum, and discards a corrupted copy that has the right size and dates", async () => {
    const mtime = new Date("2026-03-01T09:00:00Z");
    const primary = await makeTree({
      "Photos/beach.jpg": { content: "the real photo", mtime },
      "notes.txt": "fine",
    });
    const replica = await makeTree({ "Photos/beach.jpg": { content: "old photo", mtime: new Date("2025-01-01") } });
    const replicaPhotoBefore = await metadataOf(join(replica, "Photos/beach.jpg"));
    const corrupting: FileCopier = {
      async copy(source, destination) {
        await new MacFileCopier().copy(source, destination);
        if (!source.endsWith("beach.jpg")) return;
        // One wrong byte in the copy. Size and dates stay the same, so only the contents can tell
        // the copy apart from the Primary's file.
        await writeFile(destination, "the real phota");
        await utimes(destination, mtime, mtime);
      },
    };

    const result = await compareAndUpdate(primary, replica, APPROVED, corrupting);

    assert.deepEqual(result.copied, [{ path: "notes.txt", size: 4 }]);
    assert.deepEqual(result.failed, [
      { path: "Photos/beach.jpg", size: 14, reason: "the copy's checksum does not match the Primary's" },
    ]);
    assert.equal(await readFile(join(replica, "Photos/beach.jpg"), "utf8"), "old photo");
    assert.equal(await metadataOf(join(replica, "Photos/beach.jpg")), replicaPhotoBefore);
    assert.deepEqual((await readdir(replica)).sort(), [".sync-drive-last-updated", "Photos", "notes.txt"], "no copy is left behind");
  });

  it("writes nothing to the Replica without the main approval", async () => {
    const primary = await makeTree({ "new.txt": "new", "notes.txt": "edited" });
    const replica = await makeTree({
      "notes.txt": { content: "before", mtime: new Date("2025-01-01") },
      ".sync-drive-incoming/leftover": "x",
    });
    const replicaBefore = await snapshotTree(replica);

    const result = await compareAndUpdate(primary, replica, { update: false, moves: false, deletions: false });

    assert.deepEqual(result, { copied: [], failed: [], renamed: [], notRenamed: [], moved: [], notMoved: [], emptiedHoldingArea: false });
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("discards a copy when the Primary file changes while it is being copied", async () => {
    const primary = await makeTree({ "draft.txt": "first version" });
    const replica = await makeTree();
    let primaryAfterEdit: string[] = [];
    const editedMidCopy: FileCopier = {
      async copy(source, destination) {
        await new MacFileCopier().copy(source, destination);
        // The user saves the file again while it is being copied.
        await writeFile(source, "second version, longer");
        primaryAfterEdit = await snapshotTree(primary);
      },
    };

    const report = await compare(primary, replica);
    const result = await update(report, APPROVED, { primary, replica, copier: editedMidCopy });

    assert.deepEqual(result.copied, []);
    assert.deepEqual(result.failed, [
      { path: "draft.txt", size: 13, reason: "it changed on the Primary while it was being copied" },
    ]);
    assert.deepEqual(await readdir(replica), [".sync-drive-last-updated"], "nothing but the last-updated marker");
    assert.deepEqual(await snapshotTree(primary), primaryAfterEdit, "only the user's edit touched the Primary");
  });

  it("refuses, writing nothing, when the Replica is the Primary or inside it", async () => {
    const primary = await makeTree({ "a.txt": "a", "Inside/old.txt": "x" });
    const primaryBefore = await snapshotTree(primary);
    const report = await compare(primary, join(primary, "Inside"));

    for (const replica of [primary, join(primary, "Inside"), join(primary, "Inside", "..")]) {
      await assert.rejects(update(report, APPROVED, { primary, replica, copier: new MacFileCopier() }), /overlap/);
    }
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
  });

  it("refuses, writing nothing, a report path that would lead outside the Replica", async () => {
    const outside = await makeTree();
    const primary = await makeTree({ "escape.txt": "x" });
    const replica = join(outside, "Replica");
    await mkdir(replica);
    const primaryBefore = await snapshotTree(primary);
    const report = await compare(primary, replica);
    report.new.files[0]!.path = "../escape.txt";

    await assert.rejects(
      update(report, APPROVED, { primary, replica, copier: new MacFileCopier() }),
      /"\.\.\/escape\.txt" is not a path inside the drive/,
    );
    assert.deepEqual(await readdir(outside), ["Replica"]);
    assert.deepEqual(await readdir(replica), []);
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
  });
});

describe("Update progress", () => {
  it("reports bytes copied out of the approved total, as each copy is confirmed", async () => {
    const primary = await makeTree({ "a.txt": "12345", "b.txt": "123" });
    const replica = await makeTree();
    const report = await compare(primary, replica);
    const seen: UpdateProgress[] = [];

    await update(report, APPROVED, { primary, replica, copier: new MacFileCopier(), onProgress: (p) => seen.push(structuredClone(p)) });

    const none = { done: 0, total: 0 };
    assert.deepEqual(seen.map((p) => p.copies), [
      { copiedBytes: 0, notCopiedBytes: 0, totalBytes: 8 },
      { copiedBytes: 5, notCopiedBytes: 0, totalBytes: 8 },
      { copiedBytes: 8, notCopiedBytes: 0, totalBytes: 8 },
    ]);
    assert.ok(seen.every((p) => isDeepStrictEqual(p.deletions, none) && isDeepStrictEqual(p.moves, none)));
  });

  it("counts a file that could not be copied apart from those copied", async () => {
    const primary = await makeTree({ "a.txt": "12345", "b.txt": "123" });
    const replica = await makeTree();
    const report = await compare(primary, replica);
    const seen: UpdateProgress[] = [];
    const failingForA: FileCopier = {
      copy: (source, destination) => (source.endsWith("a.txt") ? Promise.reject(new Error("EIO")) : new MacFileCopier().copy(source, destination)),
    };

    await update(report, APPROVED, { primary, replica, copier: failingForA, onProgress: (p) => seen.push(structuredClone(p)) });

    assert.deepEqual(seen.at(-1)!.copies, { copiedBytes: 3, notCopiedBytes: 5, totalBytes: 8 });
  });

  it("reports the deleted files moved into the Holding area and the moves renamed, before the copies", async () => {
    const primary = await makeTree({ "New/x.jpg": "12345", "fresh.txt": "f" });
    const replica = await makeTree({ "Old/x.jpg": "12345", "gone-1.txt": "1", "gone-2.txt": "2" });
    const report = await compare(primary, replica);
    const seen: UpdateProgress[] = [];

    await update(report, { update: true, moves: true, deletions: true }, {
      primary,
      replica,
      copier: new MacFileCopier(),
      onProgress: (p) => seen.push(structuredClone(p)),
    });

    assert.deepEqual(seen.map((p) => [p.deletions.done, p.moves.done, p.copies.copiedBytes]), [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [2, 1, 0],
      [2, 1, 1],
    ]);
    assert.deepEqual(seen.at(-1), {
      deletions: { done: 2, total: 2 },
      moves: { done: 1, total: 1 },
      copies: { copiedBytes: 1, notCopiedBytes: 0, totalBytes: 1 },
    });
  });

  it("reports only the approved work: no copies without the copies in the report, no moves or deletions without their Approvals", async () => {
    const primary = await makeTree({ "New/x.jpg": "12345" });
    const replica = await makeTree({ "Old/x.jpg": "12345", "gone.txt": "1" });
    const report = await compare(primary, replica);
    const seen: UpdateProgress[] = [];

    await update(report, APPROVED, { primary, replica, copier: new MacFileCopier(), onProgress: (p) => seen.push(structuredClone(p)) });

    assert.deepEqual(seen, [{ deletions: { done: 0, total: 0 }, moves: { done: 0, total: 0 }, copies: { copiedBytes: 0, notCopiedBytes: 0, totalBytes: 0 } }]);
  });

  it("gives the same Result, and stops with the same UpdateStoppedError, with progress reported to a listener that throws", async () => {
    const throwing = () => {
      throw new Error("the screens went away");
    };
    const spec = { "a.txt": "12345", "New/x.jpg": "12345" };
    const replicaSpec = { "Old/x.jpg": "12345", "gone.txt": "1" };
    const run = async (onProgress?: () => void) => {
      const primary = await makeTree(spec);
      const replica = await makeTree(replicaSpec);
      const report = await compare(primary, replica);
      return update(report, { update: true, moves: true, deletions: true }, { primary, replica, copier: new MacFileCopier(), ...(onProgress === undefined ? {} : { onProgress }) });
    };
    assert.deepEqual(await run(throwing), await run());

    // Stopped before writing anything: the Safety stop is not overridden.
    const primary = await makeTree();
    const replica = await makeTree(files("old", 200));
    const report = await compare(primary, replica);
    const stopped = await update(report, APPROVED_WITH_DELETIONS, { primary, replica, copier: new MacFileCopier(), onProgress: throwing }).catch((e: unknown) => e);
    assert.ok(stopped instanceof UpdateStoppedError);
    assert.match(stopped.message, /Safety stop/);
    assert.deepEqual(stopped.result, { copied: [], failed: [], renamed: [], notRenamed: [], moved: [], notMoved: [], emptiedHoldingArea: false });
  });
});

describe("Update: deletions and the Holding area", () => {
  it("moves confirmed deletions into the Holding area, keeping their folder paths and metadata", async () => {
    const primary = await makeTree({ "keep.txt": "kept" });
    const replica = await makeTree({
      "keep.txt": "kept",
      "Photos/2024/old.jpg": { content: "an old photo", mtime: new Date("2024-06-01T10:00:00Z") },
      "gone.txt": "gone",
    });
    const oldPhotoBefore = await metadataOf(join(replica, "Photos/2024/old.jpg"));

    const result = await compareAndUpdate(primary, replica, APPROVED_WITH_DELETIONS);

    assert.deepEqual(result.moved, [
      { path: "Photos/2024/old.jpg", size: 12 },
      { path: "gone.txt", size: 4 },
    ]);
    assert.deepEqual(result.notMoved, []);
    const holding = join(replica, "sync-drive Holding Area");
    assert.equal(await readFile(join(holding, "Photos/2024/old.jpg"), "utf8"), "an old photo");
    assert.equal(await metadataOf(join(holding, "Photos/2024/old.jpg")), oldPhotoBefore);
    assert.equal(await readFile(join(holding, "gone.txt"), "utf8"), "gone");
    await assert.rejects(lstat(join(replica, "gone.txt")), { code: "ENOENT" });
    const after = await compare(primary, replica);
    assert.equal(after.new.count + after.changed.count + after.deleted.count, 0, "the Holding area never appears in a comparison");
  });

  it("leaves every Replica file in place when deletions are not confirmed", async () => {
    const primary = await makeTree({ "new.txt": "new" });
    const replica = await makeTree({ "Photos/old.jpg": "old", "gone.txt": "gone" });
    const replicaBefore = await snapshotTree(replica);

    const result = await compareAndUpdate(primary, replica, APPROVED);

    assert.deepEqual(result.copied, [{ path: "new.txt", size: 3 }]);
    assert.deepEqual(result.moved, []);
    const replicaAfter = withoutMarker(await snapshotTree(replica)).filter((line) => !line.includes("new.txt"));
    assert.deepEqual(replicaAfter, replicaBefore);
  });

  it("does nothing with deletions confirmed but no main approval", async () => {
    const primary = await makeTree();
    const replica = await makeTree({ "gone.txt": "gone" });
    const replicaBefore = await snapshotTree(replica);

    const result = await compareAndUpdate(primary, replica, { update: false, moves: false, deletions: true });

    assert.deepEqual(result.moved, []);
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("writes a READ ME with the date of the Update and how to restore a file", async () => {
    const primary = await makeTree();
    const replica = await makeTree({ "gone.txt": "gone" });
    const primaryBefore = await snapshotTree(primary);
    const report = await compare(primary, replica);

    await update(report, APPROVED_WITH_DELETIONS, {
      primary,
      replica,
      copier: new MacFileCopier(),
      now: new Date(2026, 10, 20, 15, 30),
    });

    const readme = await readFile(join(replica, "sync-drive Holding Area", "READ ME.txt"), "utf8");
    assert.match(readme, /Update on 20 November 2026/);
    assert.deepEqual(await readHoldingArea(replica), { count: 1, totalSize: 4, lastAddedOn: "20 November 2026" });
    assert.match(readme, /permanently deleted at the next Update whose deletions you confirm/);
    assert.match(readme, /copy it back to the Primary/);
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
  });

  it("keeps the previous Holding area through comparisons and declined Updates, and empties it when the next deletions are confirmed", async () => {
    const primary = await makeTree({ "a.txt": "same" });
    const replica = await makeTree({ "a.txt": "same", "first.txt": "deleted first" });
    await compareAndUpdate(primary, replica, APPROVED_WITH_DELETIONS);
    const holding = join(replica, "sync-drive Holding Area");
    await writeFile(join(replica, "second.txt"), "deleted second");
    const replicaBefore = await snapshotTree(replica);

    await compare(primary, replica);
    await compareAndUpdate(primary, replica, { update: false, moves: false, deletions: false });
    await compareAndUpdate(primary, replica, { update: false, moves: false, deletions: true });
    assert.deepEqual(await snapshotTree(replica), replicaBefore, "comparing or declining never empties it");

    const result = await compareAndUpdate(primary, replica, APPROVED_WITH_DELETIONS);

    assert.deepEqual(result.moved, [{ path: "second.txt", size: 14 }]);
    assert.equal(result.emptiedHoldingArea, true);
    assert.deepEqual((await readdir(holding)).sort(), ["READ ME.txt", "second.txt"]);
  });

  it("keeps the previous Holding area through an approved Update whose deletions are not confirmed", async () => {
    const primary = await makeTree({ "a.txt": "same" });
    const replica = await makeTree({ "a.txt": "same", "first.txt": "deleted first" });
    await compareAndUpdate(primary, replica, APPROVED_WITH_DELETIONS);
    await writeFile(join(primary, "new.txt"), "new");
    await writeFile(join(replica, "second.txt"), "deleted second");
    const holding = join(replica, "sync-drive Holding Area");
    const holdingBefore = await snapshotTree(holding);

    const result = await compareAndUpdate(primary, replica, APPROVED);

    assert.deepEqual(result.copied, [{ path: "new.txt", size: 3 }]);
    assert.equal(result.emptiedHoldingArea, false);
    assert.deepEqual(await snapshotTree(holding), holdingBefore);
    assert.equal(await readFile(join(replica, "second.txt"), "utf8"), "deleted second");
  });

  it("moves deletions out of the way first, so a folder replaced by a file of the same name is copied", async () => {
    const primary = await makeTree({ "Trip": "now a file" });
    const replica = await makeTree({ "Trip/day1.jpg": "a photo" });

    const result = await compareAndUpdate(primary, replica, APPROVED_WITH_DELETIONS);

    assert.deepEqual(result.moved, [{ path: "Trip/day1.jpg", size: 7 }]);
    assert.deepEqual(result.copied, [{ path: "Trip", size: 10 }]);
    assert.deepEqual(result.failed, []);
    assert.equal(await readFile(join(replica, "sync-drive Holding Area", "Trip", "day1.jpg"), "utf8"), "a photo");
    assert.equal(await readFile(join(replica, "Trip"), "utf8"), "now a file");
  });

  it("removes folders the moves leave empty, but keeps those still on the Primary or still holding files", async () => {
    const primary = await makeTree({ "Kept/a.txt": "a" });
    await mkdir(join(primary, "Empty on Primary"));
    const replica = await makeTree({
      "Kept/a.txt": "a",
      "Kept/Gone/old.txt": "old",
      "Empty on Primary/old.txt": "old",
      "Mixed/old.txt": "old",
      "Mixed/.DS_Store": "finder",
    });

    await compareAndUpdate(primary, replica, APPROVED_WITH_DELETIONS);

    assert.deepEqual((await readdir(replica)).sort(), [".sync-drive-last-updated", "Empty on Primary", "Kept", "Mixed", "sync-drive Holding Area"]);
    assert.deepEqual(await readdir(join(replica, "Kept")), ["a.txt"]);
    assert.deepEqual(await readdir(join(replica, "Empty on Primary")), []);
    assert.deepEqual(await readdir(join(replica, "Mixed")), [".DS_Store"]);
  });

  it("lists a deleted file it could not move, leaving it in place, and moves the others", async () => {
    const primary = await makeTree();
    const replica = await makeTree({ "gone.txt": "gone", "vanished.txt": "x" });
    const primaryBefore = await snapshotTree(primary);
    const report = await compare(primary, replica);
    await rm(join(replica, "vanished.txt"));

    const result = await update(report, APPROVED_WITH_DELETIONS, { primary, replica, copier: new MacFileCopier() });

    assert.deepEqual(result.moved, [{ path: "gone.txt", size: 4 }]);
    assert.equal(result.notMoved.length, 1);
    assert.equal(result.notMoved[0]!.path, "vanished.txt");
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
  });


  it("leaves a deleted file in place when it is on the Primary again since the comparison, and moves the others", async () => {
    const primary = await makeTree();
    const replica = await makeTree({ "back.txt": "the Replica's copy", "Folder/back.jpg": "jpg", "gone.txt": "gone" });
    const report = await compare(primary, replica);
    // Back on the Primary between the comparison and Apply, one of them different from the Replica's copy.
    await writeFile(join(primary, "back.txt"), "restored, and edited");
    await mkdir(join(primary, "Folder"));
    await writeFile(join(primary, "Folder/back.jpg"), "jpg");
    const primaryBefore = await snapshotTree(primary);

    const result = await update(report, APPROVED_WITH_DELETIONS, { primary, replica, copier: new MacFileCopier() });

    assert.deepEqual(result.moved, [{ path: "gone.txt", size: 4 }]);
    assert.deepEqual(result.notMoved.map((file) => file.path), ["Folder/back.jpg", "back.txt"]);
    for (const file of result.notMoved) assert.match(file.reason, /on the Primary again since the comparison/);
    assert.equal(await readFile(join(replica, "back.txt"), "utf8"), "the Replica's copy");
    assert.equal(await readFile(join(replica, "Folder/back.jpg"), "utf8"), "jpg");
    const holding = join(replica, "sync-drive Holding Area");
    assert.deepEqual((await readdir(holding)).sort(), ["READ ME.txt", "gone.txt"]);
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
  });

  it("leaves a deleted file in place when a shortcut is at its path on the Primary again, even a broken one", async () => {
    const primary = await makeTree();
    const replica = await makeTree({ "now-a-shortcut": "y" });
    const report = await compare(primary, replica);
    await symlink("nowhere", join(primary, "now-a-shortcut"));
    const primaryBefore = await snapshotTree(primary);

    const result = await update(report, APPROVED_WITH_DELETIONS, { primary, replica, copier: new MacFileCopier() });

    assert.deepEqual(result.moved, []);
    assert.deepEqual(result.notMoved.map((file) => file.path), ["now-a-shortcut"]);
    assert.equal(await readFile(join(replica, "now-a-shortcut"), "utf8"), "y");
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
  });

  for (const [mode, what] of [[0o000, "cannot be opened"], [0o100, "can be opened but not listed"]] as const) {
    it(`leaves a deleted file in place when its folder on the Primary ${what} since the comparison, as a comparison would not call it deleted`, async () => {
      const primary = await makeTree();
      const replica = await makeTree({ "Private/diary.txt": "d", "gone.txt": "gone" });
      const report = await compare(primary, replica);
      await mkdir(join(primary, "Private"));
      const primaryBefore = await snapshotTree(primary);
      await chmod(join(primary, "Private"), mode);
      let result;
      try {
        result = await update(report, APPROVED_WITH_DELETIONS, { primary, replica, copier: new MacFileCopier() });
      } finally {
        await chmod(join(primary, "Private"), 0o755);
      }

      assert.deepEqual(result.moved, [{ path: "gone.txt", size: 4 }]);
      assert.deepEqual(result.notMoved.map((file) => file.path), ["Private/diary.txt"]);
      assert.match(result.notMoved[0]!.reason, /permission denied|cannot be read/);
      assert.equal(await readFile(join(replica, "Private/diary.txt"), "utf8"), "d");
      assert.deepEqual(await snapshotTree(primary), primaryBefore);
    });
  }

  it("leaves a deleted file in place when a folder of its name that cannot be read is on the Primary since the comparison", async () => {
    const primary = await makeTree();
    const replica = await makeTree({ "Private": "a file on the Replica" });
    const report = await compare(primary, replica);
    await mkdir(join(primary, "Private"));
    const primaryBefore = await snapshotTree(primary);
    await chmod(join(primary, "Private"), 0o000);
    let result;
    try {
      result = await update(report, APPROVED_WITH_DELETIONS, { primary, replica, copier: new MacFileCopier() });
    } finally {
      await chmod(join(primary, "Private"), 0o755);
    }

    assert.deepEqual(result.moved, []);
    assert.deepEqual(result.notMoved.map((file) => file.path), ["Private"]);
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
  });

  it("moves a deleted file when a folder of its name is on the Primary since the comparison, as a comparison would still call it deleted", async () => {
    const primary = await makeTree();
    const replica = await makeTree({ "now-a-folder": "x" });
    const report = await compare(primary, replica);
    await mkdir(join(primary, "now-a-folder"));

    const result = await update(report, APPROVED_WITH_DELETIONS, { primary, replica, copier: new MacFileCopier() });

    assert.deepEqual(result.moved, [{ path: "now-a-folder", size: 1 }]);
    assert.deepEqual(result.notMoved, []);
  });

  it("moves a deleted file whose folder on the Primary is now a file, since nothing is at its path", async () => {
    const primary = await makeTree();
    const replica = await makeTree({ "Old/gone.txt": "gone" });
    const report = await compare(primary, replica);
    await writeFile(join(primary, "Old"), "a file where the folder was");

    const result = await update(report, APPROVED_WITH_DELETIONS, { primary, replica, copier: new MacFileCopier() });

    assert.deepEqual(result.moved, [{ path: "Old/gone.txt", size: 4 }]);
    assert.deepEqual(result.notMoved, []);
  });

  it("refuses, writing nothing, a report path inside sync-drive's own folders", async () => {
    const primary = await makeTree();
    const replica = await makeTree({ "gone.txt": "gone" });
    const primaryBefore = await snapshotTree(primary);
    const replicaBefore = await snapshotTree(replica);
    const report = await compare(primary, replica);
    report.deleted.files[0]!.path = "sync-drive Holding Area/gone.txt";

    await assert.rejects(
      update(report, APPROVED_WITH_DELETIONS, { primary, replica, copier: new MacFileCopier() }),
      /inside sync-drive's own/,
    );
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
  });

  it("says what it had already done when it stops partway", async () => {
    const primary = await makeTree({ "new.txt": "new" });
    const replica = await makeTree({ "gone.txt": "gone", ".sync-drive-incoming/stuck": "left over" });
    const stuck = join(replica, ".sync-drive-incoming", "stuck");
    // Locked, so emptying the Incoming folder fails after the deletions have moved.
    await promisify(execFile)("chflags", ["uchg", stuck]);
    try {
      const report = await compare(primary, replica);

      const stopped = await update(report, APPROVED_WITH_DELETIONS, { primary, replica, copier: new MacFileCopier() }).then(
        () => assert.fail("the Update should have stopped"),
        (error: unknown) => error,
      );

      assert.ok(stopped instanceof UpdateStoppedError);
      assert.match(stopped.message, /EPERM/);
      assert.deepEqual(stopped.result.moved, [{ path: "gone.txt", size: 4 }]);
      assert.deepEqual(stopped.result.copied, []);
      assert.equal(await readFile(join(replica, "sync-drive Holding Area", "gone.txt"), "utf8"), "gone");
    } finally {
      await promisify(execFile)("chflags", ["nouchg", stuck]);
    }
  });
});

describe("Reading the Holding area", () => {
  it("gives the date in a READ ME written before overwritten copies were kept there too", async () => {
    const readme = [
      "sync-drive Holding Area",
      "",
      "These files were moved here by the sync-drive Update on 3 June 2026, because they",
      "were no longer on the Primary drive. They keep their original folder paths.",
      "",
    ].join("\n");
    const replica = await makeTree({ "sync-drive Holding Area/READ ME.txt": readme, "sync-drive Holding Area/Docs/a.txt": "abc" });

    assert.deepEqual(await readHoldingArea(replica), { count: 1, totalSize: 3, lastAddedOn: "3 June 2026" });
  });

  it("gives no date when the READ ME is missing or says none", async () => {
    const replica = await makeTree({ "sync-drive Holding Area/a.txt": "abc", "sync-drive Holding Area/READ ME.txt": "edited by hand" });

    assert.deepEqual(await readHoldingArea(replica), { count: 1, totalSize: 3 });
    assert.deepEqual(await readHoldingArea(await makeTree()), { count: 0, totalSize: 0 });
  });
});

describe("Update: moves", () => {
  it("renames moved files on the Replica, keeping their metadata, without copying or using the Holding area", async () => {
    const primary = await makeTree({ "Photos/2026/Iceland/a.jpg": "aaaa", "Photos/2026/Iceland/Day 2/b.jpg": "bb" });
    const replica = await makeTree({ "Photos/Iceland/a.jpg": "aaaa", "Photos/Iceland/Day 2/b.jpg": "bb" });
    const aBefore = await metadataOf(join(replica, "Photos/Iceland/a.jpg"));
    const copier: FileCopier = { copy: () => assert.fail("a move must never copy") };

    const result = await compareAndUpdate(primary, replica, APPROVED_WITH_MOVES, copier);

    assert.deepEqual(result.renamed, [
      { from: "Photos/Iceland/Day 2/b.jpg", to: "Photos/2026/Iceland/Day 2/b.jpg", size: 2 },
      { from: "Photos/Iceland/a.jpg", to: "Photos/2026/Iceland/a.jpg", size: 4 },
    ]);
    assert.deepEqual(result.notRenamed, []);
    assert.deepEqual(result.copied, []);
    assert.equal(await metadataOf(join(replica, "Photos/2026/Iceland/a.jpg")), aBefore);
    // The emptied old folders are removed, and the Holding area is never made.
    assert.deepEqual(await readdir(join(replica, "Photos")), ["2026"]);
    assert.deepEqual((await readdir(replica)).sort(), [".sync-drive-last-updated", "Photos"]);
    const after = await compare(primary, replica);
    assert.equal(after.new.count + after.changed.count + after.deleted.count + after.moves.count, 0);
  });

  it("leaves moved files at their old paths, and copies nothing to the new ones, without the moves Approval", async () => {
    const primary = await makeTree({ "New/a.jpg": "aaaa", "fresh.txt": "new" });
    const replica = await makeTree({ "Old/a.jpg": "aaaa" });
    const replicaBefore = await snapshotTree(replica);

    const result = await compareAndUpdate(primary, replica, APPROVED);

    assert.deepEqual(result.copied, [{ path: "fresh.txt", size: 3 }]);
    assert.deepEqual(result.renamed, []);
    const replicaAfter = withoutMarker(await snapshotTree(replica)).filter((line) => !line.includes("fresh.txt"));
    assert.deepEqual(replicaAfter, replicaBefore);
  });

  it("renames nothing with the moves Approval but no main approval", async () => {
    const primary = await makeTree({ "New/a.jpg": "aaaa" });
    const replica = await makeTree({ "Old/a.jpg": "aaaa" });
    const replicaBefore = await snapshotTree(replica);

    const result = await compareAndUpdate(primary, replica, { update: false, moves: true, deletions: false });

    assert.deepEqual(result.renamed, []);
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("leaves a moved file in place when it changed on either drive since the comparison, and renames the others", async () => {
    const primary = await makeTree({ "New/a.jpg": "aaaa", "New/b.jpg": "bbbb", "New/c.jpg": "cccc" });
    const replica = await makeTree({ "Old/a.jpg": "aaaa", "Old/b.jpg": "bbbb", "Old/c.jpg": "cccc" });
    const report = await compare(primary, replica);
    const later = new Date("2026-06-01T00:00:00Z");
    await utimes(join(primary, "New/a.jpg"), later, later);
    await writeFile(join(replica, "Old/b.jpg"), "edited");
    const primaryBefore = await snapshotTree(primary);

    const result = await update(report, APPROVED_WITH_MOVES, { primary, replica, copier: new MacFileCopier() });

    assert.deepEqual(result.renamed, [{ from: "Old/c.jpg", to: "New/c.jpg", size: 4 }]);
    assert.deepEqual(result.notRenamed.map((move) => move.from), ["Old/a.jpg", "Old/b.jpg"]);
    assert.match(result.notRenamed[0]!.reason, /changed .* since the comparison/);
    assert.equal(await readFile(join(replica, "Old/a.jpg"), "utf8"), "aaaa");
    assert.equal(await readFile(join(replica, "Old/b.jpg"), "utf8"), "edited");
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
  });

  it("never replaces a file that has appeared at a moved file's new path since the comparison", async () => {
    const primary = await makeTree({ "New/a.jpg": "aaaa" });
    const replica = await makeTree({ "Old/a.jpg": "aaaa" });
    const report = await compare(primary, replica);
    await mkdir(join(replica, "New"));
    await writeFile(join(replica, "New/a.jpg"), "someone else's");

    const result = await update(report, APPROVED_WITH_MOVES, { primary, replica, copier: new MacFileCopier() });

    assert.deepEqual(result.renamed, []);
    assert.match(result.notRenamed[0]!.reason, /already has a file at its new path/);
    assert.equal(await readFile(join(replica, "New/a.jpg"), "utf8"), "someone else's");
    assert.equal(await readFile(join(replica, "Old/a.jpg"), "utf8"), "aaaa");
  });

  it("refuses, writing nothing, a move whose path would lead outside the Replica or into sync-drive's own folders", async () => {
    for (const [side, path] of [["from", "../escape.jpg"], ["to", "sync-drive Holding Area/a.jpg"]] as const) {
      const primary = await makeTree({ "New/a.jpg": "aaaa" });
      const replica = await makeTree({ "Old/a.jpg": "aaaa" });
      const replicaBefore = await snapshotTree(replica);
      const report = await compare(primary, replica);
      report.moves.moves[0]![side] = path;

      await assert.rejects(update(report, APPROVED_WITH_MOVES, { primary, replica, copier: new MacFileCopier() }), /nothing was written/);
      assert.deepEqual(await snapshotTree(replica), replicaBefore);
    }
  });

  it("renames moves after the deletions, so a deleted file is out of the way of a moved folder of the same name", async () => {
    // "Projects" was a file on the Replica; on the Primary it is now a folder, holding a moved file.
    const primary = await makeTree({ "Projects/a.jpg": "aaaa" });
    const replica = await makeTree({ "Projects": "old file", "Old/a.jpg": "aaaa" });

    const result = await compareAndUpdate(primary, replica, { update: true, moves: true, deletions: true });

    assert.deepEqual(result.moved, [{ path: "Projects", size: 8 }]);
    assert.deepEqual(result.renamed, [{ from: "Old/a.jpg", to: "Projects/a.jpg", size: 4 }]);
  });
});

describe("Update: shortcuts, Finder aliases and special files on the Primary", () => {
  /** Makes a shortcut (symbolic link) at `path` under `root`, pointing at `target`, dated `date`. */
  async function shortcut(root: string, path: string, target: string, date = new Date("2026-02-03T04:05:06Z")): Promise<void> {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await symlink(target, join(root, path));
    await lutimes(join(root, path), date, date);
  }

  it("copies a shortcut as a shortcut with the same target and metadata, never following it", async () => {
    const elsewhere = await makeTree({ "secret.txt": "not on the Primary" });
    const primary = await makeTree();
    await shortcut(primary, "Links/to-secret", join(elsewhere, "secret.txt"));
    await shortcut(primary, "Links/to-folder", "../Photos");
    await run("xattr", ["-s", "-w", "com.example.tag", "kept", join(primary, "Links/to-secret")]);
    const replica = await makeTree();

    const result = await compareAndUpdate(primary, replica);

    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.copied.map((file) => file.path).sort(), ["Links/to-folder", "Links/to-secret"]);
    for (const path of ["Links/to-secret", "Links/to-folder"]) {
      const copy = await lstat(join(replica, path));
      assert.ok(copy.isSymbolicLink(), `${path} is a shortcut on the Replica`);
      assert.equal(await readlink(join(replica, path)), await readlink(join(primary, path)));
      assert.equal(await metadataOf(join(replica, path)), await metadataOf(join(primary, path)));
    }
    const again = await compare(primary, replica);
    assert.deepEqual([again.new.count, again.changed.count, again.deleted.count], [0, 0, 0]);
  });

  it("copies a broken shortcut as it is", async () => {
    const primary = await makeTree();
    await shortcut(primary, "broken", "nowhere/at/all");
    const replica = await makeTree();

    const result = await compareAndUpdate(primary, replica);

    assert.deepEqual(result.copied.map((file) => file.path), ["broken"]);
    assert.equal(await readlink(join(replica, "broken")), "nowhere/at/all");
  });

  it("replaces a Replica shortcut that points somewhere else, and not what it points to", async () => {
    const primary = await makeTree({ "2025/a.txt": "a", "2026/b.txt": "b" });
    const replica = await makeTree({ "2025/a.txt": "a", "2026/b.txt": "b" });
    await shortcut(primary, "Latest", "2026");
    await shortcut(replica, "Latest", "2025");
    const replicaFolders = await snapshotTree(join(replica, "2025"));

    const result = await compareAndUpdate(primary, replica);

    assert.deepEqual(result.copied.map((file) => file.path), ["Latest"]);
    assert.equal(await readlink(join(replica, "Latest")), "2026");
    assert.deepEqual(await snapshotTree(join(replica, "2025")), replicaFolders);
  });

  it("replaces a Replica file with the Primary's shortcut, and a Replica shortcut with the Primary's file", async () => {
    const primary = await makeTree({ "was-a-link.txt": "now a file" });
    await shortcut(primary, "was-a-file.txt", "somewhere.txt");
    const replica = await makeTree({ "was-a-file.txt": "a file" });
    await shortcut(replica, "was-a-link.txt", "somewhere-else.txt");

    const result = await compareAndUpdate(primary, replica);

    assert.deepEqual(result.failed, []);
    assert.equal(await readlink(join(replica, "was-a-file.txt")), "somewhere.txt");
    assert.ok((await lstat(join(replica, "was-a-link.txt"))).isFile());
    assert.equal(await readFile(join(replica, "was-a-link.txt"), "utf8"), "now a file");
  });

  it("copies a Finder alias as an alias file, never resolving it", async () => {
    const elsewhere = await makeTree({ "original.txt": "the original, not on the Primary" });
    const primary = await makeTree({ "Alias to original": "book\0\0\0\0mark bookmark data naming the original" });
    // A Finder alias is a file whose Finder info has the type "alis", the creator "MACS" and the alias flag.
    const finderInfo = "616C69734D414353" + "8000" + "0".repeat(44);
    await run("xattr", ["-w", "-x", "com.apple.FinderInfo", finderInfo, join(primary, "Alias to original")]);
    const replica = await makeTree();
    const elsewhereBefore = await snapshotTree(elsewhere);

    const result = await compareAndUpdate(primary, replica);

    assert.deepEqual(result.copied.map((file) => file.path), ["Alias to original"]);
    assert.deepEqual(withoutMarker(await snapshotTree(replica)), await snapshotTree(primary));
    assert.equal((await extendedAttributes(join(replica, "Alias to original")))["com.apple.FinderInfo"], finderInfo);
    assert.deepEqual(await snapshotTree(elsewhere), elsewhereBefore);
  });

  it("does not copy a special file such as a named pipe, and says why", async () => {
    const primary = await makeTree({ "ok.txt": "ok" });
    await run("mkfifo", [join(primary, "pipe")]);
    const replica = await makeTree();

    const result = await compareAndUpdate(primary, replica);

    assert.deepEqual(result.copied.map((file) => file.path), ["ok.txt"]);
    assert.deepEqual(result.failed.map((file) => file.path), ["pipe"]);
    assert.match(result.failed[0]!.reason, /special file/);
    assert.deepEqual((await readdir(replica)).sort(), [".sync-drive-last-updated", "ok.txt"]);
  });
});

describe("Update: shortcut folders on the Replica", () => {
  it("never copies through a shortcut folder to elsewhere on the Replica, and says why", async () => {
    // The Replica's "Photos" is a shortcut to its own "Archive", which backs up a different report.pdf.
    const primary = await makeTree({ "Photos/report.pdf": "this year's report", "notes.txt": "hello" });
    const replica = await makeTree({ "Archive/report.pdf": "last year's report" });
    await symlink("Archive", join(replica, "Photos"));
    const replicaBefore = await snapshotTree(replica);

    const result = await compareAndUpdate(primary, replica);

    assert.deepEqual(result.copied, [{ path: "notes.txt", size: 5 }]);
    assert.deepEqual(result.failed.map((file) => file.path), ["Photos/report.pdf"]);
    assert.match(result.failed[0]!.reason, /"Photos" is a shortcut/);
    const replicaAfter = withoutMarker(await snapshotTree(replica)).filter((line) => !line.includes("notes.txt"));
    assert.deepEqual(replicaAfter, replicaBefore, "nothing but notes.txt is written to the Replica");
  });

  it("copies into a real folder once the shortcut's deletion is approved in the same Update", async () => {
    const primary = await makeTree({ "Photos/report.pdf": "this year's report", "Archive/report.pdf": "last year's report" });
    const replica = await makeTree({ "Archive/report.pdf": "last year's report" });
    await symlink("Archive", join(replica, "Photos"));
    const archiveBefore = await snapshotTree(join(replica, "Archive"));

    const result = await compareAndUpdate(primary, replica, APPROVED_WITH_DELETIONS);

    assert.deepEqual(result.moved.map((file) => file.path), ["Photos"]);
    assert.deepEqual(result.copied.map((file) => file.path), ["Photos/report.pdf"]);
    assert.ok((await lstat(join(replica, "Photos"))).isDirectory());
    assert.ok((await lstat(join(replica, "sync-drive Holding Area/Photos"))).isSymbolicLink());
    assert.deepEqual(await snapshotTree(join(replica, "Archive")), archiveBefore);
    const after = await compare(primary, replica);
    assert.equal(after.new.count + after.changed.count + after.deleted.count, 0);
  });

  it("never makes a folder on the Primary through a Replica shortcut that points into it", async () => {
    const primary = await makeDiskImageTree({ "Photos/2026/beach.jpg": "a photo", "Other/kept.txt": "kept" }, { name: "Primary" });
    const replica = await makeDiskImageTree({}, { name: "Replica" });
    await symlink(join(primary, "Other"), join(replica, "Photos"));
    const replicaBefore = await snapshotTree(replica);

    // compareAndUpdate checks the Primary is unchanged, so no "Other/2026" was made on it.
    const result = await compareAndUpdate(primary, replica);

    assert.deepEqual(result.copied.map((file) => file.path), ["Other/kept.txt"]);
    assert.deepEqual(result.failed.map((file) => file.path), ["Photos/2026/beach.jpg"]);
    assert.match(result.failed[0]!.reason, /"Photos" is a shortcut/);
    const replicaAfter = withoutMarker(await snapshotTree(replica)).filter((line) => !/ Other(\/|$| )/.test(line));
    assert.deepEqual(replicaAfter, replicaBefore);
  });

  it("never moves a deleted file into the Holding area through a shortcut folder, and moves the others", async () => {
    const primary = await makeTree({ "Archive/gone.txt": "keep me" });
    const replica = await makeTree({ "Archive/gone.txt": "keep me", "Old/gone.txt": "gone", "lost.txt": "lost" });
    const report = await compare(primary, replica);
    // Since the comparison, the real folder "Old" has become a shortcut to "Archive".
    await rm(join(replica, "Old"), { recursive: true });
    await symlink("Archive", join(replica, "Old"));
    const archiveBefore = await snapshotTree(join(replica, "Archive"));
    const primaryBefore = await snapshotTree(primary);

    const result = await update(report, APPROVED_WITH_DELETIONS, { primary, replica, copier: new MacFileCopier() });

    assert.deepEqual(result.moved.map((file) => file.path), ["lost.txt"]);
    assert.deepEqual(result.notMoved.map((file) => file.path), ["Old/gone.txt"]);
    assert.match(result.notMoved[0]!.reason, /"Old" is a shortcut/);
    assert.deepEqual(await snapshotTree(join(replica, "Archive")), archiveBefore);
    assert.deepEqual(await readdir(join(replica, "sync-drive Holding Area")), ["READ ME.txt", "lost.txt"]);
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
  });

  it("never renames a move through a shortcut folder at its new path", async () => {
    // The Replica's "New" is a shortcut to its "Archive", where the move would land.
    const primary = await makeTree({ "New/a.jpg": "aaaa" });
    const replica = await makeTree({ "Old/a.jpg": "aaaa", "Archive/other.jpg": "other" });
    await symlink("Archive", join(replica, "New"));
    const replicaBefore = await snapshotTree(replica);

    const result = await compareAndUpdate(primary, replica, APPROVED_WITH_MOVES);

    assert.deepEqual(result.renamed, []);
    assert.deepEqual(result.notRenamed.map((move) => move.to), ["New/a.jpg"]);
    assert.match(result.notRenamed[0]!.reason, /"New" is a shortcut/);
    assert.deepEqual(withoutMarker(await snapshotTree(replica)), replicaBefore);
  });

  it("never renames a move through a shortcut folder at its old path", async () => {
    const primary = await makeTree({ "New/a.jpg": "aaaa" });
    const replica = await makeTree({ "Old/a.jpg": "aaaa" });
    const report = await compare(primary, replica);
    // Since the comparison, the real folder "Old" has been renamed "Elsewhere" and a shortcut put in its place.
    await rename(join(replica, "Old"), join(replica, "Elsewhere"));
    await symlink("Elsewhere", join(replica, "Old"));
    const replicaBefore = await snapshotTree(replica);
    const primaryBefore = await snapshotTree(primary);

    const result = await update(report, APPROVED_WITH_MOVES, { primary, replica, copier: new MacFileCopier() });

    assert.deepEqual(result.renamed, []);
    assert.deepEqual(result.notRenamed.map((move) => move.from), ["Old/a.jpg"]);
    assert.match(result.notRenamed[0]!.reason, /"Old" is a shortcut/);
    assert.deepEqual(withoutMarker(await snapshotTree(replica)), replicaBefore);
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
  });
});

/** `count` one-byte files named `<prefix>0.txt`, `<prefix>1.txt`, … */
function files(prefix: string, count: number): TreeSpec {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}.txt`, "x"]));
}

describe("Update: safety stops", () => {
  /** A Primary that has lost 101 of the Replica's 200 files, and gained a new one. */
  async function drivesPastTheSafetyStop() {
    const primary = await makeTree({ ...files("kept/", 99), "new.txt": "new" });
    const replica = await makeTree({ ...files("kept/", 99), ...files("gone/", 101) });
    return { primary, replica };
  }

  it("refuses, writing nothing, when the Safety stop applies, even if deletions are not confirmed", async () => {
    const { primary, replica } = await drivesPastTheSafetyStop();
    const primaryBefore = await snapshotTree(primary);
    const replicaBefore = await snapshotTree(replica);
    const report = await compare(primary, replica);
    assert.equal(report.safetyStop, true);

    for (const approvals of [APPROVED, APPROVED_WITH_DELETIONS]) {
      await assert.rejects(
        update(report, approvals, { primary, replica, copier: new MacFileCopier() }),
        /Safety stop applies.*nothing was written/,
      );
    }
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
  });

  it("counts the deletions itself, refusing past the Safety stop even when the Report's flag says it does not apply", async () => {
    const { primary, replica } = await drivesPastTheSafetyStop();
    const replicaBefore = await snapshotTree(replica);
    const report = { ...(await compare(primary, replica)), safetyStop: false };

    await assert.rejects(
      update(report, APPROVED_WITH_DELETIONS, { primary, replica, copier: new MacFileCopier() }),
      /Safety stop applies.*nothing was written/,
    );
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("goes ahead when the Safety stop is explicitly overridden", async () => {
    const { primary, replica } = await drivesPastTheSafetyStop();

    const result = await compareAndUpdate(primary, replica, { ...APPROVED_WITH_DELETIONS, overrideSafetyStop: true });

    assert.equal(result.copied.length, 1);
    assert.equal(result.moved.length, 101);
    const after = await compare(primary, replica);
    assert.equal(after.new.count + after.changed.count + after.deleted.count, 0);
  });

  it("refuses up front, writing nothing, when the Replica lacks the free space for the copies", async () => {
    const primary = await makeTree({ "small.txt": "fits", "film.mov": "x".repeat(20_000_000) });
    const replica = await makeDiskImageTree({ "gone.txt": "gone" }, { name: "Replica" });
    const primaryBefore = await snapshotTree(primary);
    const replicaBefore = await snapshotTree(replica);
    const report = await compare(primary, replica);

    await assert.rejects(
      update(report, APPROVED_WITH_DELETIONS, { primary, replica, copier: new MacFileCopier() }),
      /bytes free but the copies need .*nothing was written/,
    );
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
  });
});

describe("Overwriting content mismatches", () => {
  /** A Primary and a Replica whose `a.txt` and `b.txt` match by size and date but not by contents. */
  async function mismatchedDrives() {
    const primary = await makeTree({ "a.txt": "AAAA", "b.txt": "BBBB", "same.txt": "same", "new.txt": "new" });
    const replica = await makeTree({ "a.txt": "zzzz", "b.txt": "yyyy", "same.txt": "same" });
    return { primary, replica, primaryBefore: await snapshotTree(primary) };
  }

  it("leaves every content mismatch alone without a choice to overwrite it, copying the rest", async () => {
    const { primary, replica, primaryBefore } = await mismatchedDrives();
    const report = await compare(primary, replica, { deep: true });

    const result = await update(report, APPROVED, { primary, replica, copier: new MacFileCopier() });

    assert.deepEqual(result.copied, [{ path: "new.txt", size: 3 }]);
    assert.equal(await readFile(join(replica, "a.txt"), "utf8"), "zzzz");
    assert.equal(await readFile(join(replica, "b.txt"), "utf8"), "yyyy");
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
  });

  it("overwrites exactly the content mismatches chosen with the Primary's copy, confirmed by checksum, and keeps the others", async () => {
    const { primary, replica, primaryBefore } = await mismatchedDrives();
    const report = await compare(primary, replica, { deep: true });

    const result = await update(report, { ...APPROVED, overwrite: ["a.txt"] }, { primary, replica, copier: new MacFileCopier() });

    assert.deepEqual(result.copied, [{ path: "new.txt", size: 3 }, { path: "a.txt", size: 4 }]);
    assert.deepEqual(result.failed, []);
    assert.equal(await readFile(join(replica, "a.txt"), "utf8"), "AAAA");
    assert.equal(await metadataOf(join(replica, "a.txt")), await metadataOf(join(primary, "a.txt")));
    assert.equal(await readFile(join(replica, "sync-drive Holding Area", "a.txt"), "utf8"), "zzzz", "the Replica's copy is kept, not destroyed");
    assert.equal(await readFile(join(replica, "b.txt"), "utf8"), "yyyy");
    const after = await compare(primary, replica, { deep: true });
    assert.deepEqual(after.anomalies.contentMismatch.files, [{ path: "b.txt", size: 4 }]);
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
  });

  it("overwrites the chosen content mismatches even when the Report it is given holds no new or changed files", async () => {
    const { primary, replica } = await mismatchedDrives();
    const report = await compare(primary, replica, { deep: true });
    const none = { ...report.new, count: 0, totalSize: 0, files: [], folders: [] };

    const result = await update({ ...report, new: none, changed: none }, { ...APPROVED, overwrite: ["b.txt"] }, { primary, replica, copier: new MacFileCopier() });

    assert.deepEqual(result.copied, [{ path: "b.txt", size: 4 }]);
    assert.equal(await readFile(join(replica, "b.txt"), "utf8"), "BBBB");
  });

  it("refuses, writing nothing, a choice to overwrite a file that is not a content mismatch in the Report", async () => {
    const { primary, replica } = await mismatchedDrives();
    const report = await compare(primary, replica, { deep: true });
    const replicaBefore = await snapshotTree(replica);

    await assert.rejects(
      update(report, { ...APPROVED, overwrite: ["same.txt"] }, { primary, replica, copier: new MacFileCopier() }),
      /"same.txt" is not a content mismatch in the Report; nothing was written/,
    );
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("moves the Replica's copy into the Holding area at its own path, adding to what it holds without emptying it", async () => {
    const primary = await makeTree({ "Docs/a.txt": "AAAA" });
    const replica = await makeTree({ "Docs/a.txt": "zzzz", "sync-drive Holding Area/earlier.txt": "held", "sync-drive Holding Area/READ ME.txt": "old" });
    const report = await compare(primary, replica, { deep: true });

    const result = await update(report, { ...APPROVED, overwrite: ["Docs/a.txt"] }, {
      primary,
      replica,
      copier: new MacFileCopier(),
      now: new Date(2026, 10, 23, 9, 0),
    });

    assert.deepEqual(result.copied, [{ path: "Docs/a.txt", size: 4 }]);
    assert.equal(await readFile(join(replica, "Docs/a.txt"), "utf8"), "AAAA");
    const holding = join(replica, "sync-drive Holding Area");
    assert.equal(await readFile(join(holding, "Docs/a.txt"), "utf8"), "zzzz");
    assert.equal(await readFile(join(holding, "earlier.txt"), "utf8"), "held");
    const readme = await readFile(join(holding, "READ ME.txt"), "utf8");
    assert.match(readme, /most recently by the Update on 23 November 2026/);
    assert.match(readme, /chose to overwrite/);
  });

  it("leaves a chosen content mismatch alone if the Holding area already holds a file at its path", async () => {
    const { primary, replica } = await mismatchedDrives();
    await mkdir(join(replica, "sync-drive Holding Area"));
    await writeFile(join(replica, "sync-drive Holding Area", "a.txt"), "from an earlier Update");
    const report = await compare(primary, replica, { deep: true });

    const result = await update(report, { ...APPROVED, overwrite: ["a.txt"] }, { primary, replica, copier: new MacFileCopier() });

    assert.deepEqual(result.failed, [{ path: "a.txt", size: 4, reason: "the Holding area already holds a file at that path" }]);
    assert.equal(await readFile(join(replica, "a.txt"), "utf8"), "zzzz");
    assert.equal(await readFile(join(replica, "sync-drive Holding Area", "a.txt"), "utf8"), "from an earlier Update");
  });

  it("leaves a chosen content mismatch alone if its Replica copy changed since the comparison", async () => {
    const { primary, replica, primaryBefore } = await mismatchedDrives();
    const report = await compare(primary, replica, { deep: true });
    // The owner fixes the Replica's copy by hand after comparing.
    await writeFile(join(replica, "a.txt"), "fixed by hand");

    const result = await update(report, { ...APPROVED, overwrite: ["a.txt"] }, { primary, replica, copier: new MacFileCopier() });

    assert.deepEqual(result.failed, [{ path: "a.txt", size: 4, reason: "it changed on the Primary or the Replica since the comparison" }]);
    assert.equal(await readFile(join(replica, "a.txt"), "utf8"), "fixed by hand");
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
  });

  it("leaves a chosen content mismatch alone if its Primary file changed since the comparison", async () => {
    const { primary, replica } = await mismatchedDrives();
    const report = await compare(primary, replica, { deep: true });
    const later = Date.now() / 1000 + 60;
    await utimes(join(primary, "a.txt"), later, later);

    const result = await update(report, { ...APPROVED, overwrite: ["a.txt"] }, { primary, replica, copier: new MacFileCopier() });

    assert.deepEqual(result.failed, [{ path: "a.txt", size: 4, reason: "it changed on the Primary or the Replica since the comparison" }]);
    assert.equal(await readFile(join(replica, "a.txt"), "utf8"), "zzzz");
  });

  it("leaves a chosen content mismatch alone if its Replica copy changes while the Primary's is being copied", async () => {
    const { primary, replica } = await mismatchedDrives();
    const report = await compare(primary, replica, { deep: true });
    const mac = new MacFileCopier();
    const editsReplicaMeanwhile: FileCopier = {
      copy: async (source, destination) => {
        await mac.copy(source, destination);
        if (source === join(primary, "a.txt")) await writeFile(join(replica, "a.txt"), "edited meanwhile");
      },
    };

    const result = await update(report, { ...APPROVED, overwrite: ["a.txt"] }, { primary, replica, copier: editsReplicaMeanwhile });

    assert.deepEqual(result.failed, [{ path: "a.txt", size: 4, reason: "it changed on the Primary or the Replica since the comparison" }]);
    assert.equal(await readFile(join(replica, "a.txt"), "utf8"), "edited meanwhile");
    assert.deepEqual((await readdir(replica)).sort(), [".sync-drive-last-updated", "a.txt", "b.txt", "new.txt", "same.txt"]);
  });
});

/** A Finder tags list holding the single tag "Red", as Finder stores it (a binary property list). */
const RED_TAG_HEX =
  "62706C6973743030A101565265640A36080A0000000000000101000000000000000200000000000000000000000000000013";

describe("Update: Exclusions", () => {
  it("writes nothing when the report holds a path the Exclusions leave out, whether to copy, move or delete", async () => {
    const primary = await makeTree({ "Scratch/new.txt": "x", "New/photo.jpg": "same" });
    const replica = await makeTree({ "Scratch/old.txt": "x", "Old/photo.jpg": "same" });
    // Compared without the Exclusions, so the report holds Scratch: as from a Report made before they were added.
    const report = await compare(primary, replica);
    const replicaBefore = await snapshotTree(replica);

    for (const exclusions of [["Scratch"], ["/New"], ["/Old"]]) {
      await assert.rejects(
        update(report, { update: true, moves: true, deletions: true }, { primary, replica, copier: new MacFileCopier(), exclusions }),
        (error: Error) => error instanceof UpdateStoppedError && /left out by the Exclusions; nothing was written/.test(error.message),
      );
    }
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("goes ahead with a report made with the same Exclusions", async () => {
    const primary = await makeTree({ "Scratch/new.txt": "x", "keep.txt": "x" });
    const replica = await makeTree({ "Scratch/old.txt": "x" });
    const exclusions = ["Scratch"];

    const report = await compare(primary, replica, { exclusions });
    const result = await update(report, APPROVED_WITH_DELETIONS, { primary, replica, copier: new MacFileCopier(), exclusions });

    assert.deepEqual(result.copied, [{ path: "keep.txt", size: 1 }]);
    assert.deepEqual(await readdir(join(replica, "Scratch")), ["old.txt"]);
  });
});

describe("Update: limited to one folder", () => {
  it("copies, renames and moves into the Holding area only inside the folder, leaving everything outside it alone", async () => {
    const primary = await makeTree({
      "Photos/2019/new.jpg": "n",
      "Photos/2019/Iceland/moved.jpg": "m",
      "Photos/2020/new.jpg": "n",
      "Elsewhere/arrived.jpg": "a",
    });
    const replica = await makeTree({
      "Photos/2019/moved.jpg": "m",
      "Photos/2019/gone.jpg": "g",
      "Photos/2019/arrived.jpg": "a",
      "Photos/2020/gone.jpg": "g",
      "old.txt": "o",
    });
    const primaryBefore = await snapshotTree(primary);
    /** The Replica outside the folder (and outside the Holding area), from a snapshot line: its kind, then its path. */
    const outside = (lines: string[]) => lines.filter((line) => !/^\S+\s+(Photos\/2019|sync-drive Holding Area)(\/| )/.test(line));
    const outsideBefore = outside(await snapshotTree(replica));

    const report = await compare(primary, replica, { only: "Photos/2019" });
    const result = await update(report, { update: true, moves: true, deletions: true }, { primary, replica, copier: new MacFileCopier(), only: "Photos/2019" });

    assert.deepEqual(result.copied, [{ path: "Photos/2019/new.jpg", size: 1 }]);
    assert.deepEqual(result.renamed, [{ from: "Photos/2019/moved.jpg", to: "Photos/2019/Iceland/moved.jpg", size: 1 }]);
    // Moved out of the folder on the Primary: it cannot be recognised as a move, so it is a deletion.
    assert.deepEqual(result.moved.map((file) => file.path), ["Photos/2019/arrived.jpg", "Photos/2019/gone.jpg"]);
    assert.deepEqual(outside(withoutMarker(await snapshotTree(replica))), outsideBefore);
    assert.deepEqual(await snapshotTree(primary), primaryBefore, "the Primary must never be written to");
  });

  it("writes nothing when the report holds a path outside the folder, whether to copy, move or delete", async () => {
    const primary = await makeTree({ "Photos/2019/a.jpg": "a", "Other/new.txt": "x", "New/photo.jpg": "same" });
    const replica = await makeTree({ "Other/old.txt": "x", "Old/photo.jpg": "same" });
    // Compared without the folder, as from a Report made for the whole drive.
    const report = await compare(primary, replica);
    const replicaBefore = await snapshotTree(replica);

    await assert.rejects(
      update(report, { update: true, moves: true, deletions: true }, { primary, replica, copier: new MacFileCopier(), only: "Photos/2019" }),
      (error: Error) => error instanceof UpdateStoppedError && /is outside the folder "Photos\/2019" the Update is limited to; nothing was written/.test(error.message),
    );
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("matches the folder whatever its letter case on the Replica", async () => {
    const primary = await makeTree({ "Photos/2019/a.jpg": "a" });
    const replica = await makeTree({ "photos/2019/gone.jpg": "g" });

    const report = await compare(primary, replica, { only: "Photos/2019" });
    const result = await update(report, APPROVED_WITH_DELETIONS, { primary, replica, copier: new MacFileCopier(), only: "Photos/2019" });

    assert.deepEqual(result.moved, [{ path: "photos/2019/gone.jpg", size: 1 }]);
    assert.deepEqual(result.copied, [{ path: "Photos/2019/a.jpg", size: 1 }]);
  });

  for (const [what, change] of [
    ["is gone from the Primary", (primary: string) => rm(join(primary, "Photos"), { recursive: true })],
    ["is now a shortcut on the Primary", async (primary: string) => {
      await rename(join(primary, "Photos"), join(primary, "Real"));
      await symlink("Real", join(primary, "Photos"));
    }],
  ] as const) {
    it(`leaves every deletion in place, and the Holding area as it was, when the folder ${what} since the comparison`, async () => {
      const primary = await makeTree({ "Photos/2019/kept.jpg": "k" });
      const replica = await makeTree({ "Photos/2019/kept.jpg": "k", "Photos/2019/Day 1/gone.jpg": "g", "sync-drive Holding Area/earlier.jpg": "e" });
      const report = await compare(primary, replica, { only: "Photos/2019" });
      await change(primary);
      const replicaBefore = await snapshotTree(replica);

      const result = await update(report, APPROVED_WITH_DELETIONS, { primary, replica, copier: new MacFileCopier(), only: "Photos/2019" });

      assert.deepEqual(result.moved, []);
      assert.deepEqual(result.notMoved, [
        { path: "Photos/2019/Day 1/gone.jpg", size: 1, reason: `the folder "Photos/2019" ${what === "is gone from the Primary" ? "is no longer on the Primary" : "is no longer a folder on the Primary"} since the comparison` },
      ]);
      assert.deepEqual(await snapshotTree(replica), replicaBefore, "not even the last-updated marker");
      assert.equal(result.notRecorded, result.notMoved[0]?.reason);
    });
  }
});

describe("Update: the last-updated marker", () => {
  const NOW = new Date("2026-11-24T10:30:00Z");
  const LATER = new Date("2026-12-02T08:00:00Z");

  it("records on the Replica when an Update of the whole drive finished", async () => {
    const primary = await makeTree({ "notes.txt": "hello" });
    const replica = await makeTree();
    assert.equal(await readLastUpdated(replica), undefined, "never updated");

    await update(await compare(primary, replica), APPROVED, { primary, replica, copier: new MacFileCopier(), now: NOW });

    assert.deepEqual(await readLastUpdated(replica), { wholeDrive: { updated: NOW.toISOString() }, folders: [] });
  });

  it("records an Update limited to one folder apart, keeping when the whole drive was last updated", async () => {
    const primary = await makeTree({ "notes.txt": "hello", "Photos/a.jpg": "a", "Music/b.mp3": "b" });
    const replica = await makeTree();
    await update(await compare(primary, replica), APPROVED, { primary, replica, copier: new MacFileCopier(), now: NOW });
    await writeFile(join(primary, "Photos/c.jpg"), "c");

    await update(await compare(primary, replica, { only: "Photos" }), APPROVED, { primary, replica, copier: new MacFileCopier(), only: "Photos", now: LATER });

    assert.deepEqual(await readLastUpdated(replica), { wholeDrive: { updated: NOW.toISOString() }, folders: [{ folder: "Photos", updated: LATER.toISOString() }] });
  });

  it("keeps one entry per folder, and forgets them all at the next Update of the whole drive", async () => {
    const primary = await makeTree({ "Photos/a.jpg": "a", "Music/b.mp3": "b" });
    const replica = await makeTree();
    const updateOnly = async (only: string, now: Date) =>
      update(await compare(primary, replica, { only }), APPROVED, { primary, replica, copier: new MacFileCopier(), only, now });

    await updateOnly("Photos", NOW);
    await updateOnly("Music", NOW);
    await updateOnly("Photos", LATER);

    assert.deepEqual(await readLastUpdated(replica), {
      folders: [
        { folder: "Music", updated: NOW.toISOString() },
        { folder: "Photos", updated: LATER.toISOString() },
      ],
    }, "no Update of the whole drive yet");

    await update(await compare(primary, replica), APPROVED, { primary, replica, copier: new MacFileCopier(), now: LATER });

    assert.deepEqual(await readLastUpdated(replica), { wholeDrive: { updated: LATER.toISOString() }, folders: [] });
  });

  it("records an Update as partial, with how many items it left undone that the owner wanted done", async () => {
    const primary = await makeTree({ "a.txt": "AAAA", "b.txt": "BBBB", "c.txt": "CCCC", "new.txt": "new", "broken.txt": "x" });
    const replica = await makeTree({ "a.txt": "zzzz", "b.txt": "yyyy", "c.txt": "xxxx", "only-here.txt": "o" });
    const compared = await compare(primary, replica, { deep: true });
    const report = { ...compared, unreadable: [{ path: "Locked", folder: true, reason: "permission denied" }] };
    const failing: FileCopier = {
      copy: (source, destination) =>
        source.endsWith("broken.txt") ? Promise.reject(new Error("the drive was disconnected")) : new MacFileCopier().copy(source, destination),
    };

    // a.txt overwritten, b.txt kept as chosen, c.txt with no choice; the deletion declined.
    const result = await update(report, { ...APPROVED, overwrite: ["a.txt"], keep: ["b.txt"] }, { primary, replica, copier: failing, now: NOW });

    assert.deepEqual(result.failed.map((file) => file.path), ["broken.txt"]);
    // broken.txt not copied, c.txt with no choice made, the unreadable folder.
    assert.deepEqual(await readLastUpdated(replica), { wholeDrive: { updated: NOW.toISOString(), leftUndone: 3 }, folders: [] });
  });

  it("records a folder-limited Update as partial too", async () => {
    const primary = await makeTree({ "Photos/a.jpg": "a" });
    const replica = await makeTree();
    const failing: FileCopier = { copy: () => Promise.reject(new Error("the drive was disconnected")) };

    await update(await compare(primary, replica, { only: "Photos" }), APPROVED, { primary, replica, copier: failing, only: "Photos", now: NOW });

    assert.deepEqual(await readLastUpdated(replica), { folders: [{ folder: "Photos", updated: NOW.toISOString(), leftUndone: 1 }] });
  });

  it("does not record an Update limited to a folder that is gone from the Primary since the comparison, saying why", async () => {
    const primary = await makeTree({ "Photos/kept.jpg": "k" });
    const replica = await makeTree({ "Photos/kept.jpg": "k", "Photos/gone.jpg": "g" });
    const report = await compare(primary, replica, { only: "Photos" });
    await rm(join(primary, "Photos"), { recursive: true });

    const result = await update(report, APPROVED_WITH_DELETIONS, { primary, replica, copier: new MacFileCopier(), only: "Photos", now: NOW });

    assert.equal(await readLastUpdated(replica), undefined);
    assert.equal(result.notRecorded, 'the folder "Photos" is no longer on the Primary since the comparison');
  });

  it("finishes the Update when only its record cannot be written, saying why it was not recorded", async () => {
    const primary = await makeTree({ "notes.txt": "hello" });
    // A folder where the marker goes, which renaming the marker into place cannot replace.
    const replica = await makeTree({ ".sync-drive-last-updated/in the way.txt": "x" });

    const result = await update(await compare(primary, replica), APPROVED, { primary, replica, copier: new MacFileCopier(), now: NOW });

    assert.deepEqual(result.copied, [{ path: "notes.txt", size: 5 }]);
    assert.match(result.notRecorded ?? "", /^sync-drive could not write it there \(.+\)$/);
    assert.deepEqual((await readdir(replica)).sort(), [".sync-drive-last-updated", "notes.txt"], "the Incoming folder is still removed");
  });

  it("records nothing when the Update stops before it finishes", async () => {
    const primary = await makeTree({ "notes.txt": "hello" });
    const replica = await makeTree({ "old.txt": "o" });
    const report = await compare(primary, replica);

    await assert.rejects(update(report, APPROVED, { primary, replica, copier: new MacFileCopier(), exclusions: ["notes.txt"] }));

    assert.equal(await readLastUpdated(replica), undefined);
  });

  it("rejects a damaged marker, saying so", async () => {
    const replica = await makeTree({ ".sync-drive-last-updated": "not what sync-drive wrote" });

    await assert.rejects(readLastUpdated(replica), /record of when the Replica was last updated is damaged/);
  });

  it("writes the marker with its format version first", async () => {
    const primary = await makeTree({ "notes.txt": "hello" });
    const replica = await makeTree();

    await update(await compare(primary, replica), APPROVED, { primary, replica, copier: new MacFileCopier(), now: NOW });

    const marker = JSON.parse(await readFile(join(replica, ".sync-drive-last-updated"), "utf8"));
    assert.equal(marker.version, 1);
    assert.equal(Object.keys(marker)[0], "version");
  });

  it("rejects a marker from a newer sync-drive, saying so rather than calling it damaged", async () => {
    const replica = await makeTree({ ".sync-drive-last-updated": '{"version":2,"wholeDrive":{"updated":"2026-01-01T12:00:00.000Z"},"folders":[]}' });

    await assert.rejects(readLastUpdated(replica), (error: Error) => {
      assert.match(error.message, /written by a newer version of sync-drive/);
      assert.doesNotMatch(error.message, /damaged/);
      return true;
    });
  });

  it("rejects a marker without a format version, or with one that is not a positive whole number, as damaged", async () => {
    for (const version of [undefined, 0, -1, 1.5, "1", null]) {
      const marker = { ...(version === undefined ? {} : { version }), wholeDrive: { updated: "2026-01-01T12:00:00.000Z" }, folders: [] };
      const replica = await makeTree({ ".sync-drive-last-updated": JSON.stringify(marker) });

      await assert.rejects(readLastUpdated(replica), /record of when the Replica was last updated is damaged/, `version ${String(version)}`);
    }
  });

  it("replaces a damaged marker at the next Update", async () => {
    const primary = await makeTree({ "notes.txt": "hello" });
    const replica = await makeTree({ ".sync-drive-last-updated": "not what sync-drive wrote" });

    await update(await compare(primary, replica), APPROVED, { primary, replica, copier: new MacFileCopier(), now: NOW });

    assert.deepEqual(await readLastUpdated(replica), { wholeDrive: { updated: NOW.toISOString() }, folders: [] });
  });
});
