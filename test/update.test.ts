import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, lutimes, mkdir, readdir, readFile, readlink, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { compare, update, UpdateStoppedError, type Approvals, type FileCopier } from "../src/engine/index.ts";
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

    assert.deepEqual(await readdir(replica), ["a.txt"]);
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
    assert.deepEqual((await readdir(replica)).sort(), ["Photos", "notes.txt"], "no copy is left behind");
  });

  it("writes nothing to the Replica without the main approval", async () => {
    const primary = await makeTree({ "new.txt": "new", "notes.txt": "edited" });
    const replica = await makeTree({
      "notes.txt": { content: "before", mtime: new Date("2025-01-01") },
      ".sync-drive-incoming/leftover": "x",
    });
    const replicaBefore = await snapshotTree(replica);

    const result = await compareAndUpdate(primary, replica, { update: false, moves: false, deletions: false });

    assert.deepEqual(result, { copied: [], failed: [], renamed: [], notRenamed: [], moved: [], notMoved: [] });
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
    assert.deepEqual(await readdir(replica), []);
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
    const replicaAfter = (await snapshotTree(replica)).filter((line) => !line.includes("new.txt"));
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

    assert.deepEqual((await readdir(replica)).sort(), ["Empty on Primary", "Kept", "Mixed", "sync-drive Holding Area"]);
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
    assert.deepEqual((await readdir(replica)).sort(), ["Photos"]);
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
    const replicaAfter = (await snapshotTree(replica)).filter((line) => !line.includes("fresh.txt"));
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
    assert.deepEqual(await snapshotTree(replica), await snapshotTree(primary));
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
    assert.deepEqual(await readdir(replica), ["ok.txt"]);
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
    const replicaAfter = (await snapshotTree(replica)).filter((line) => !line.includes("notes.txt"));
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
    const replicaAfter = (await snapshotTree(replica)).filter((line) => !/ Other(\/|$| )/.test(line));
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
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
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
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
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

/** A Finder tags list holding the single tag "Red", as Finder stores it (a binary property list). */
const RED_TAG_HEX =
  "62706C6973743030A101565265640A36080A0000000000000101000000000000000200000000000000000000000000000013";
