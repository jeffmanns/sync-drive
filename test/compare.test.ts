import assert from "node:assert/strict";
import { chmod, lstat, lutimes, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { checkExclusion, compare, Sha256Hasher, type CompareProgress, type Hasher, type ItemCounter } from "../src/engine/index.ts";
import { DEFAULT_MTIME, makeCaseSensitiveTree, makeTree, removeTrees, snapshotTree } from "./helpers/trees.ts";

after(removeTrees);

describe("Quick compare", () => {
  it("reports a file only on the Primary as new, with its path and size", async () => {
    const primary = await makeTree({ "Photos/beach.jpg": "12345" });
    const replica = await makeTree();

    const report = await compare(primary, replica);

    assert.deepEqual(report.new.files, [{ path: "Photos/beach.jpg", size: 5 }]);
    assert.deepEqual(report.changed.files, []);
    assert.deepEqual(report.deleted.files, []);
  });

  it("reports a file only on the Replica as deleted, with its Replica size", async () => {
    const primary = await makeTree();
    const replica = await makeTree({ "Docs/old.pdf": "abc" });

    const report = await compare(primary, replica);

    assert.deepEqual(report.deleted.files, [{ path: "Docs/old.pdf", size: 3 }]);
    assert.deepEqual(report.new.files, []);
  });

  it("reports a file whose size differs as changed, with its Primary size", async () => {
    const primary = await makeTree({ "notes.txt": "longer text" });
    const replica = await makeTree({ "notes.txt": "short" });

    const report = await compare(primary, replica);

    assert.deepEqual(report.changed.files, [{ path: "notes.txt", size: 11 }]);
    assert.deepEqual(report.new.files, []);
    assert.deepEqual(report.deleted.files, []);
  });

  it("reports a file with the same size but a different modification date as changed", async () => {
    const primary = await makeTree({
      "notes.txt": { content: "edited", mtime: new Date("2026-03-01T09:00:00Z") },
    });
    const replica = await makeTree({
      "notes.txt": { content: "before", mtime: new Date("2026-02-01T09:00:00Z") },
    });

    const report = await compare(primary, replica);

    assert.deepEqual(report.changed.files, [{ path: "notes.txt", size: 6 }]);
  });

  it("judges files equal by size and modification date alone, without reading contents", async () => {
    const primary = await makeTree({ "Photos/a.jpg": "AAAA", "Photos/b.jpg": "same" });
    const replica = await makeTree({ "Photos/a.jpg": "ZZZZ", "Photos/b.jpg": "same" });

    const report = await compare(primary, replica);

    assert.deepEqual(report.new.files, []);
    assert.deepEqual(report.changed.files, []);
    assert.deepEqual(report.deleted.files, []);
  });

  it("always skips the macOS system files", async () => {
    const primary = await makeTree({
      ".Spotlight-V100/Store-V2/index": "x",
      ".fseventsd/0000000001": "x",
      ".Trashes/501/gone.jpg": "x",
      ".DS_Store": "x",
      "Photos/.DS_Store": "x",
      ".TemporaryItems/folders.501/tmp": "x",
      ".DocumentRevisions-V100/db": "x",
    });
    const replica = await makeTree({ "Photos/.DS_Store": "a different size", ".Trashes/old": "x" });

    const report = await compare(primary, replica);

    assert.deepEqual(report.new.files, []);
    assert.deepEqual(report.changed.files, []);
    assert.deepEqual(report.deleted.files, []);
  });

  it("still compares a folder deeper down that shares a name with a drive-level system folder", async () => {
    const primary = await makeTree({ "Projects/.fseventsd/notes.txt": "mine" });
    const replica = await makeTree();

    const report = await compare(primary, replica);

    assert.deepEqual(report.new.files, [{ path: "Projects/.fseventsd/notes.txt", size: 4 }]);
  });

  it("writes nothing to either drive", async () => {
    const primary = await makeTree({
      "Photos/2026/a.jpg": "aaaa",
      "Photos/2026/b.jpg": { content: "bb", mtime: new Date("2026-05-05T05:05:05Z") },
      "Docs/new.pdf": "new",
      ".DS_Store": "x",
    });
    const replica = await makeTree({
      "Photos/2026/a.jpg": "aaaa",
      "Photos/2026/b.jpg": "b",
      "Docs/old.pdf": "old",
      ".Trashes/501/x": "x",
    });
    const primaryBefore = await snapshotTree(primary);
    const replicaBefore = await snapshotTree(replica);

    await compare(primary, replica);

    assert.deepEqual(await snapshotTree(primary), primaryBefore);
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("lists files in path order", async () => {
    const primary = await makeTree({ "b/2.txt": "x", "a/1.txt": "x", "a.txt": "x", "b/1.txt": "x" });
    const replica = await makeTree();

    const report = await compare(primary, replica);

    assert.deepEqual(
      report.new.files.map((file) => file.path),
      ["a.txt", "a/1.txt", "b/1.txt", "b/2.txt"],
    );
  });

  it("totals each section and groups it by folder", async () => {
    const primary = await makeTree({
      "Photos/2026/a.jpg": "1234567890",
      "Photos/2026/b.jpg": "12345",
      "Photos/c.jpg": "12",
      "top.txt": "1",
    });
    const replica = await makeTree();

    const report = await compare(primary, replica);

    assert.equal(report.new.count, 4);
    assert.equal(report.new.totalSize, 18);
    assert.deepEqual(report.new.folders, [
      { folder: "", count: 1, totalSize: 1, files: [{ path: "top.txt", size: 1 }] },
      {
        folder: "Photos",
        count: 1,
        totalSize: 2,
        files: [{ path: "Photos/c.jpg", size: 2 }],
      },
      {
        folder: "Photos/2026",
        count: 2,
        totalSize: 15,
        files: [
          { path: "Photos/2026/a.jpg", size: 10 },
          { path: "Photos/2026/b.jpg", size: 5 },
        ],
      },
    ]);
    assert.equal(report.deleted.count, 0);
    assert.equal(report.deleted.totalSize, 0);
    assert.deepEqual(report.deleted.folders, []);
  });

  it("fails rather than reporting differences when a drive folder does not exist", async () => {
    const primary = await makeTree({ "a.txt": "x" });
    const missing = join(await makeTree(), "not-here");

    await assert.rejects(compare(primary, missing), /Replica.*not-here/);
    await assert.rejects(compare(missing, primary), /Primary.*not-here/);
  });

  it("reports a shortcut on one drive and a file on the other as changed, even with the same size and date", async () => {
    // A symbolic link's own size is the length of the path it points to: here 5, like "hello".
    const primary = await makeTree({ "link": "hello" });
    const replica = await makeTree();
    await symlink("xxxxx", join(replica, "link"));
    await lutimes(join(replica, "link"), DEFAULT_MTIME, DEFAULT_MTIME);

    const report = await compare(primary, replica);

    assert.deepEqual(report.changed.files, [{ path: "link", size: 5 }]);
  });

  it("matches files whose paths differ only by letter case", async () => {
    const primary = await makeTree({ "Photos/Iceland/IMG_001.JPG": "same" });
    const replica = await makeTree({ "photos/iceland/img_001.jpg": "same" });

    const report = await compare(primary, replica);

    assert.deepEqual(report.new.files, []);
    assert.deepEqual(report.deleted.files, []);
  });

  it("fails rather than hiding a file when one drive holds two paths that differ only by case", async () => {
    const primary = await makeCaseSensitiveTree({ "Photos/IMG_1.jpg": "1", "photos/img_1.JPG": "2" });
    const replica = await makeTree();

    await assert.rejects(compare(primary, replica), (error: Error) => {
      assert.match(error.message, /Primary/);
      assert.match(error.message, /Photos\/IMG_1\.jpg/);
      assert.match(error.message, /photos\/img_1\.JPG/);
      return true;
    });
  });

  it("treats a name stored in two different Unicode forms as two different files", async () => {
    const composed = "Caf\u00e9.txt"; // é as one character (NFC)
    const decomposed = "Cafe\u0301.txt"; // e followed by a combining accent (NFD)
    const primary = await makeTree({ [composed]: "x" });
    const replica = await makeTree({ [decomposed]: "x" });

    const report = await compare(primary, replica);

    assert.deepEqual(report.new.files, [{ path: composed, size: 1 }]);
    assert.deepEqual(report.deleted.files, [{ path: decomposed, size: 1 }]);
  });

  it("counts modification dates less than a hundredth of a second apart as the same", async () => {
    const base = DEFAULT_MTIME.getTime();
    const primary = await makeTree({
      "close.jpg": { content: "x", mtime: new Date(base) },
      "apart.jpg": { content: "x", mtime: new Date(base) },
    });
    const replica = await makeTree({
      "close.jpg": { content: "x", mtime: new Date(base + 9) },
      "apart.jpg": { content: "x", mtime: new Date(base + 11) },
    });

    const report = await compare(primary, replica);

    assert.deepEqual(report.changed.files, [{ path: "apart.jpg", size: 1 }]);
  });

  it("refuses to compare when the Primary has an item named like sync-drive's own", async () => {
    for (const [name, item] of [
      ["sync-drive Holding Area", "sync-drive Holding Area/mine.txt"],
      ["SYNC-DRIVE holding area", "SYNC-DRIVE holding area/mine.txt"],
      [".sync-drive-incoming", ".sync-drive-incoming/mine.txt"],
      [".sync-drive-last-updated", ".sync-drive-last-updated"],
    ] as const) {
      const primary = await makeTree({ [item]: "the user's own file" });
      const replica = await makeTree();

      const primaryBefore = await snapshotTree(primary);

      await assert.rejects(compare(primary, replica), new RegExp(`Primary has an item named "${name}"`));
      assert.deepEqual(await snapshotTree(primary), primaryBefore);
    }
  });

  it("leaves the Replica's last-updated marker out of the comparison", async () => {
    const primary = await makeTree({ "notes.txt": "hello" });
    const replica = await makeTree({ "notes.txt": "hello", ".sync-drive-last-updated": '{"wholeDrive":{"updated":"2026-01-01T12:00:00.000Z"},"folders":[]}' });

    const report = await compare(primary, replica);

    assert.equal(report.deleted.count, 0);
    assert.deepEqual(report.replica, { count: 1, totalSize: 5 });
  });

  it("suggests renaming the folder when the whole Holding area was copied back to the Primary", async () => {
    const primary = await makeTree({ "sync-drive Holding Area/Taxes/2019.pdf": "a tax return" });
    const replica = await makeTree();

    await assert.rejects(
      compare(primary, replica),
      /If you restored files by copying the whole Holding area, rename that folder on the Primary \(e\.g\. to "Restored files"\), then compare again\./,
    );
  });
});

describe("Move detection", () => {
  it("reports a folder moved on the Primary as moves grouped by folder, not as new and deleted files", async () => {
    const primary = await makeTree({ "Photos/2026/Iceland/a.jpg": "aaaa", "Photos/2026/Iceland/b.jpg": "bb" });
    const replica = await makeTree({ "Photos/Iceland/a.jpg": "aaaa", "Photos/Iceland/b.jpg": "bb" });

    const report = await compare(primary, replica);

    assert.deepEqual(report.new.files, []);
    assert.deepEqual(report.deleted.files, []);
    assert.equal(report.moves.count, 2);
    assert.equal(report.moves.totalSize, 6);
    assert.deepEqual(report.moves.folders, [
      {
        from: "Photos/Iceland",
        to: "Photos/2026/Iceland",
        count: 2,
        totalSize: 6,
        moves: [
          { from: "Photos/Iceland/a.jpg", to: "Photos/2026/Iceland/a.jpg", size: 4 },
          { from: "Photos/Iceland/b.jpg", to: "Photos/2026/Iceland/b.jpg", size: 2 },
        ],
      },
    ]);
  });

  it("treats a candidate whose contents differ as a new file and a deleted file, not a move", async () => {
    // Same name, size and date, but different contents: perhaps the Replica copy is damaged.
    const primary = await makeTree({ "Photos/2026/a.jpg": "good" });
    const replica = await makeTree({ "Photos/a.jpg": "bad!" });

    const report = await compare(primary, replica);

    assert.equal(report.moves.count, 0);
    assert.deepEqual(report.new.files, [{ path: "Photos/2026/a.jpg", size: 4 }]);
    assert.deepEqual(report.deleted.files, [{ path: "Photos/a.jpg", size: 4 }]);
  });

  it("falls back to new plus deleted when two Replica files could be the one moved", async () => {
    const primary = await makeTree({ "Photos/2026/IMG_0001.jpg": "same" });
    const replica = await makeTree({ "Photos/Iceland/IMG_0001.jpg": "same", "Photos/Norway/IMG_0001.jpg": "same" });

    const report = await compare(primary, replica);

    assert.equal(report.moves.count, 0);
    assert.deepEqual(report.new.files, [{ path: "Photos/2026/IMG_0001.jpg", size: 4 }]);
    assert.equal(report.deleted.count, 2);
  });

  it("falls back to new plus deleted when two Primary files could be the one moved", async () => {
    const primary = await makeTree({ "A/IMG_0001.jpg": "same", "B/IMG_0001.jpg": "same" });
    const replica = await makeTree({ "Old/IMG_0001.jpg": "same" });

    const report = await compare(primary, replica);

    assert.equal(report.moves.count, 0);
    assert.equal(report.new.count, 2);
    assert.deepEqual(report.deleted.files, [{ path: "Old/IMG_0001.jpg", size: 4 }]);
  });

  it("still finds a move when a same-named file of another size or date is also on one side only", async () => {
    const primary = await makeTree({ "New/a.jpg": "same" });
    const replica = await makeTree({
      "Old/a.jpg": "same",
      "Other/a.jpg": "longer",
      "Dated/a.jpg": { content: "same", mtime: new Date("2025-01-01T00:00:00Z") },
    });

    const report = await compare(primary, replica);

    assert.deepEqual(report.moves.moves, [{ from: "Old/a.jpg", to: "New/a.jpg", size: 4 }]);
    assert.equal(report.deleted.count, 2);
  });

  it("does not treat a file renamed to another name as a move", async () => {
    const primary = await makeTree({ "Docs/report-final.pdf": "same" });
    const replica = await makeTree({ "Docs/report.pdf": "same" });

    const report = await compare(primary, replica);

    assert.equal(report.moves.count, 0);
  });

  it("groups a moved folder's subfolders under the folder that moved", async () => {
    const primary = await makeTree({
      "Photos/2026/Iceland/a.jpg": "a",
      "Photos/2026/Iceland/Day 2/b.jpg": "bb",
      "Archive/notes.txt": "nnn",
    });
    const replica = await makeTree({
      "Photos/Iceland/a.jpg": "a",
      "Photos/Iceland/Day 2/b.jpg": "bb",
      "notes.txt": "nnn",
    });

    const report = await compare(primary, replica);

    assert.deepEqual(
      report.moves.folders.map(({ from, to, count, totalSize }) => ({ from, to, count, totalSize })),
      [
        { from: "", to: "Archive", count: 1, totalSize: 3 },
        { from: "Photos/Iceland", to: "Photos/2026/Iceland", count: 2, totalSize: 3 },
      ],
    );
  });

  it("does not count moves towards the Safety stop", async () => {
    // 150 files moved out of a Replica of 150: as deletions this would be 100% of the Replica.
    const moved = (prefix: string) =>
      Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`${prefix}/${i}.txt`, `file ${i}`]));
    const primary = await makeTree(moved("Photos/2026/Iceland"));
    const replica = await makeTree(moved("Photos/Iceland"));

    const report = await compare(primary, replica);

    assert.equal(report.moves.count, 150);
    assert.equal(report.deleted.count, 0);
    assert.equal(report.safetyStop, false);
  });

  it("writes nothing to either drive while confirming moves", async () => {
    const primary = await makeTree({ "New/a.jpg": "same", "New/b.jpg": "good" });
    const replica = await makeTree({ "Old/a.jpg": "same", "Old/b.jpg": "bad!" });
    const primaryBefore = await snapshotTree(primary);
    const replicaBefore = await snapshotTree(replica);

    const report = await compare(primary, replica);

    assert.equal(report.moves.count, 1);
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("groups a folder renamed in place, subfolders and all, as one move", async () => {
    const primary = await makeTree({ "Photos/Islande/a.jpg": "a", "Photos/Islande/Day 1/b.jpg": "bb", "Photos/Islande/Day 2/c.jpg": "ccc" });
    const replica = await makeTree({ "Photos/Iceland/a.jpg": "a", "Photos/Iceland/Day 1/b.jpg": "bb", "Photos/Iceland/Day 2/c.jpg": "ccc" });

    const report = await compare(primary, replica);

    assert.deepEqual(
      report.moves.folders.map(({ from, to, count }) => ({ from, to, count })),
      [{ from: "Photos/Iceland", to: "Photos/Islande", count: 3 }],
    );
  });

  it("groups a folder moved into another, subfolders and all, under its own name, apart from a sibling moved with it", async () => {
    const primary = await makeTree({
      "Photos/2026/Iceland/Day 1/a.jpg": "a",
      "Photos/2026/Iceland/Day 2/b.jpg": "bb",
      "Photos/2026/Norway/c.jpg": "ccc",
    });
    const replica = await makeTree({
      "Photos/Iceland/Day 1/a.jpg": "a",
      "Photos/Iceland/Day 2/b.jpg": "bb",
      "Photos/Norway/c.jpg": "ccc",
    });

    const report = await compare(primary, replica);

    assert.deepEqual(
      report.moves.folders.map(({ from, to, count }) => ({ from, to, count })),
      [
        { from: "Photos/Iceland", to: "Photos/2026/Iceland", count: 2 },
        { from: "Photos/Norway", to: "Photos/2026/Norway", count: 1 },
      ],
    );
  });

  it("treats a candidate it cannot read as a new file and a deleted file, and still compares the rest", async () => {
    const primary = await makeTree({ "New/a.jpg": "aaaa", "New/b.jpg": "bbbb" });
    const replica = await makeTree({ "Old/a.jpg": "aaaa", "Old/b.jpg": "bbbb" });
    const sha256 = new Sha256Hasher();
    const unreadable: Hasher = {
      checksum: (path) => (path.endsWith("Old/b.jpg") ? Promise.reject(new Error("EIO: i/o error")) : sha256.checksum(path)),
    };

    const report = await compare(primary, replica, { hasher: unreadable });

    assert.deepEqual(report.moves.moves, [{ from: "Old/a.jpg", to: "New/a.jpg", size: 4 }]);
    assert.deepEqual(report.new.files, [{ path: "New/b.jpg", size: 4 }]);
    assert.deepEqual(report.deleted.files, [{ path: "Old/b.jpg", size: 4 }]);
  });
});

describe("Shortcuts on the Primary", () => {
  /** Makes a shortcut (symbolic link) at `path` under `root`, pointing at `target`, dated `DEFAULT_MTIME`. */
  async function shortcut(root: string, path: string, target: string): Promise<void> {
    await symlink(target, join(root, path));
    await lutimes(join(root, path), DEFAULT_MTIME, DEFAULT_MTIME);
  }

  /** Compares, then checks the Primary came through untouched: its shortcuts and what they point to. */
  async function compareUnchanged(primary: string, replica: string) {
    const before = await snapshotTree(primary);
    const report = await compare(primary, replica);
    assert.deepEqual(await snapshotTree(primary), before, "the Primary must never be written to");
    return report;
  }

  it("judges two shortcuts with the same target, size and date equal", async () => {
    const primary = await makeTree();
    const replica = await makeTree();
    await shortcut(primary, "link", "Photos/beach.jpg");
    await shortcut(replica, "link", "Photos/beach.jpg");

    const report = await compareUnchanged(primary, replica);

    assert.deepEqual([report.new.count, report.changed.count, report.deleted.count], [0, 0, 0]);
  });

  it("reports a shortcut pointing somewhere else as changed, even with the same size and date", async () => {
    const primary = await makeTree();
    const replica = await makeTree();
    await shortcut(primary, "link", "Photos/2026");
    await shortcut(replica, "link", "Photos/2025");

    const report = await compareUnchanged(primary, replica);

    assert.deepEqual(report.changed.files, [{ path: "link", size: 11 }]);
  });

  it("never follows a shortcut to a folder: what it points to is not compared", async () => {
    const primary = await makeTree({ "Real/a.txt": "a" });
    const replica = await makeTree({ "Real/a.txt": "a" });
    await shortcut(primary, "Alias of Real", "Real");

    const report = await compareUnchanged(primary, replica);

    assert.deepEqual(report.new.files, [{ path: "Alias of Real", size: 4 }]);
  });
});

describe("Unreadable files on the Primary", () => {
  /**
   * Compares with `paths` (under the Primary) unreadable to everyone, then makes them readable
   * again, and checks the Primary came through untouched.
   */
  async function compareWithUnreadable(primary: string, replica: string, paths: string[]) {
    const before = await snapshotTree(primary);
    const modes = await Promise.all(paths.map(async (path) => (await lstat(join(primary, path))).mode & 0o7777));
    await Promise.all(paths.map((path) => chmod(join(primary, path), 0o000)));
    try {
      return await compare(primary, replica);
    } finally {
      await Promise.all(paths.map((path, i) => chmod(join(primary, path), modes[i]!)));
      assert.deepEqual(await snapshotTree(primary), before, "the Primary must never be written to");
    }
  }

  it("lists a folder that cannot be read, keeps its Replica files out of the deletions, and compares the rest", async () => {
    const primary = await makeTree({ "Private/diary.txt": "d", "Private/Deeper/notes.txt": "n", "Photos/new.jpg": "j" });
    const replica = await makeTree({ "Private/diary.txt": "d", "private/Deeper/old.txt": "o", "Old/gone.txt": "g" });

    const report = await compareWithUnreadable(primary, replica, ["Private"]);

    assert.deepEqual(report.unreadable, [{ path: "Private", folder: true, reason: "permission denied" }]);
    assert.deepEqual(report.new.files, [{ path: "Photos/new.jpg", size: 1 }]);
    assert.deepEqual(report.deleted.files, [{ path: "Old/gone.txt", size: 1 }]);
  });

  it("skips a new file that cannot be read, and lists it instead", async () => {
    const primary = await makeTree({ "locked.txt": "secret", "open.txt": "open" });
    const replica = await makeTree();

    const report = await compareWithUnreadable(primary, replica, ["locked.txt"]);

    assert.deepEqual(report.new.files, [{ path: "open.txt", size: 4 }]);
    assert.deepEqual(report.unreadable, [{ path: "locked.txt", folder: false, reason: "permission denied" }]);
  });

  it("skips a changed file that cannot be read, and keeps its Replica copy out of the deletions", async () => {
    const primary = await makeTree({ "locked.txt": "edited since" });
    const replica = await makeTree({ "locked.txt": "older" });

    const report = await compareWithUnreadable(primary, replica, ["locked.txt"]);

    assert.deepEqual([report.changed.count, report.deleted.count], [0, 0]);
    assert.deepEqual(report.unreadable, [{ path: "locked.txt", folder: false, reason: "permission denied" }]);
  });

  it("lists nothing for a file that cannot be read but matches its Replica copy, as there is nothing to copy", async () => {
    const primary = await makeTree({ "locked.txt": "same" });
    const replica = await makeTree({ "locked.txt": "same" });

    const report = await compareWithUnreadable(primary, replica, ["locked.txt"]);

    assert.deepEqual(report.unreadable, []);
    assert.deepEqual([report.new.count, report.changed.count, report.deleted.count], [0, 0, 0]);
  });

  it("keeps out of the deletions the Replica copy of a moved file that cannot be read on the Primary", async () => {
    const primary = await makeTree({ "New/photo.jpg": "pixels" });
    const replica = await makeTree({ "Old/photo.jpg": "pixels" });

    const report = await compareWithUnreadable(primary, replica, ["New/photo.jpg"]);

    assert.deepEqual([report.new.count, report.moves.count, report.deleted.count], [0, 0, 0]);
    assert.deepEqual(report.unreadable, [{ path: "New/photo.jpg", folder: false, reason: "permission denied" }]);
  });

  it("keeps out of the deletions every Replica file that looks like a moved file that cannot be read, even when more than one does", async () => {
    const primary = await makeTree({ "New/photo.jpg": "pixels" });
    const replica = await makeTree({ "Old/photo.jpg": "pixels", "Older/photo.jpg": "pixels", "Old/other.jpg": "pixels" });

    const report = await compareWithUnreadable(primary, replica, ["New/photo.jpg"]);

    assert.deepEqual(report.deleted.files, [{ path: "Old/other.jpg", size: 6 }]);
    assert.deepEqual(report.unreadable, [{ path: "New/photo.jpg", folder: false, reason: "permission denied" }]);
  });

  it("keeps a Replica file that looks like a moved file that cannot be read out of the moves too", async () => {
    // A/photo.jpg is changed and cannot be read, so the Replica's Old/photo.jpg may be its only backup.
    // B/photo.jpg alone would make Old/photo.jpg a move to B: it must stay where it is instead.
    const primary = await makeTree({ "A/photo.jpg": "pixels", "B/photo.jpg": "pixels" });
    const replica = await makeTree({ "A/photo.jpg": "older", "Old/photo.jpg": "pixels" });

    const report = await compareWithUnreadable(primary, replica, ["A/photo.jpg"]);

    assert.equal(report.moves.count, 0);
    assert.deepEqual(report.new.files, [{ path: "B/photo.jpg", size: 6 }]);
    assert.deepEqual([report.changed.count, report.deleted.count], [0, 0]);
    assert.deepEqual(report.unreadable, [{ path: "A/photo.jpg", folder: false, reason: "permission denied" }]);
  });

  it("names a cause it has no words for, rather than showing the bare code", async () => {
    const primary = await makeTree({ "New/photo.jpg": "pixels" });
    const replica = await makeTree({ "Old/photo.jpg": "pixels" });
    const sha256 = new Sha256Hasher();
    const failing: Hasher = {
      checksum: (path) =>
        path.startsWith(primary)
          ? Promise.reject(Object.assign(new Error("ELOOP: too many symbolic links"), { code: "ELOOP" }))
          : sha256.checksum(path),
    };

    const report = await compare(primary, replica, { hasher: failing });

    assert.deepEqual(report.unreadable, [{ path: "New/photo.jpg", folder: false, reason: "unexpected reason: ELOOP" }]);
  });

  it("does not count a Replica file kept back this way towards the Safety stop", async () => {
    const files = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`Private/${i}.txt`, "x"]));
    const primary = await makeTree(files);
    const replica = await makeTree(files);

    const report = await compareWithUnreadable(primary, replica, ["Private"]);

    assert.equal(report.deleted.count, 0);
    assert.equal(report.safetyStop, false);
  });
});

describe("Exclusions", () => {
  it("leaves a file matching an Exclusion's name, in any folder, out of the report on both drives", async () => {
    const primary = await makeTree({ "notes.tmp": "x", "Work/draft.tmp": "x", "Work/keep.txt": "x" });
    const replica = await makeTree({ "Old/gone.tmp": "x" });

    const report = await compare(primary, replica, { exclusions: ["*.tmp"] });

    assert.deepEqual(report.new.files, [{ path: "Work/keep.txt", size: 1 }]);
    assert.deepEqual(report.deleted.files, []);
  });

  it("reads a pattern with a / as a path from the top level, excluding a folder and everything in it", async () => {
    const primary = await makeTree({ "Movies/Cache/a.bin": "x", "Movies/Cache/deep/b.bin": "x", "Movies/film.mov": "x", "Work/Movies/Cache/c.bin": "x" });
    const replica = await makeTree();

    const report = await compare(primary, replica, { exclusions: ["/Movies/Cache"] });

    assert.deepEqual(report.new.files.map((file) => file.path), ["Movies/film.mov", "Work/Movies/Cache/c.bin"]);
  });

  it("excludes a folder named in any folder by a pattern with no /", async () => {
    const primary = await makeTree({ "a/node_modules/x/index.js": "x", "b/c/node_modules/y.js": "x", "b/node_modules.txt": "x" });
    const replica = await makeTree({ "old/node_modules/z.js": "x" });

    const report = await compare(primary, replica, { exclusions: ["node_modules"] });

    assert.deepEqual(report.new.files.map((file) => file.path), ["b/node_modules.txt"]);
    assert.deepEqual(report.deleted.files, []);
  });

  it("reads ** as any number of folders, including none, and ? as one character", async () => {
    const primary = await makeTree({
      "Projects/build/a": "x",
      "Projects/app/build/b": "x",
      "Projects/app/src/build.ts": "x",
      "Other/build/c": "x",
      "Logs/day1.log": "x",
      "Logs/day10.log": "x",
    });
    const replica = await makeTree();

    const report = await compare(primary, replica, { exclusions: ["Projects/**/build", "Logs/day?.log"] });

    assert.deepEqual(report.new.files.map((file) => file.path), ["Logs/day10.log", "Other/build/c", "Projects/app/src/build.ts"]);
  });

  it("ignores letter case and Unicode forms when matching an Exclusion", async () => {
    const decomposed = "Cafe\u0301";
    const primary = await makeTree({ "SCRATCH/a": "x", [`${decomposed}/menu.pdf`]: "x", "keep": "x" });
    const replica = await makeTree();

    const report = await compare(primary, replica, { exclusions: ["scratch", "Café".normalize("NFC")] });

    assert.deepEqual(report.new.files.map((file) => file.path), ["keep"]);
  });

  it("still skips the macOS system files alongside the Exclusions", async () => {
    const primary = await makeTree({ ".DS_Store": "x", "Photos/.DS_Store": "x", "a.tmp": "x", "keep": "x" });
    const replica = await makeTree({ ".Trashes/old": "x" });

    const report = await compare(primary, replica, { exclusions: ["*.tmp"] });

    assert.deepEqual(report.new.files.map((file) => file.path), ["keep"]);
    assert.deepEqual(report.deleted.files, []);
  });

  it("does not read an excluded folder, so lists nothing in it as unreadable", async () => {
    const primary = await makeTree({ "Private/secret": "x", "keep": "x" });
    const replica = await makeTree();
    await chmod(join(primary, "Private"), 0o000);
    try {
      const report = await compare(primary, replica, { exclusions: ["Private"] });

      assert.deepEqual(report.unreadable, []);
      assert.deepEqual(report.new.files.map((file) => file.path), ["keep"]);
    } finally {
      await chmod(join(primary, "Private"), 0o755);
    }
  });

  it("never pairs an excluded file as one end of a move, nor counts excluded Replica files towards the Safety stop", async () => {
    const primary = await makeTree({ "New/photo.jpg": "same" });
    const replica = await makeTree({ "Old/photo.jpg": "same", "Scratch/1": "x", "Scratch/2": "x" });

    const report = await compare(primary, replica, { exclusions: ["/Old", "Scratch"] });

    assert.deepEqual(report.moves.moves, []);
    assert.deepEqual(report.new.files.map((file) => file.path), ["New/photo.jpg"]);
    assert.deepEqual(report.deleted.files, []);
    assert.deepEqual(report.replica, { count: 0, totalSize: 0 });
  });

  it("finds the folder on the Replica whatever its letter case there, reporting each file as stored on its drive", async () => {
    const primary = await makeTree({ "Photos/2019/a.jpg": "a", "Photos/2019/new.jpg": "n" });
    const replica = await makeTree({ "photos/2019/a.jpg": "a", "photos/2019/gone.jpg": "g" });

    const report = await compare(primary, replica, { only: "Photos/2019" });

    assert.deepEqual(report.new.files, [{ path: "Photos/2019/new.jpg", size: 1 }]);
    assert.deepEqual(report.changed.files, []);
    assert.deepEqual(report.deleted.files, [{ path: "photos/2019/gone.jpg", size: 1 }]);
  });

  it("refuses a folder that is not on the Primary, or is not a folder there", async () => {
    const primary = await makeTree({ "Photos/2020/a.jpg": "a", "notes.txt": "n" });
    const replica = await makeTree({ "Photos/2019/a.jpg": "a" });

    await assert.rejects(compare(primary, replica, { only: "Photos/2019" }), /The Primary has no folder "Photos\/2019"/);
    await assert.rejects(compare(primary, replica, { only: "notes.txt" }), /"notes.txt" on the Primary is not a folder/);
  });

  it("refuses a folder reached through a shortcut on the Primary, which a comparison of the whole drive would not follow", async () => {
    const primary = await makeTree({ "Real/2019/a.jpg": "a" });
    const replica = await makeTree({ "Real/2019/a.jpg": "a" });
    await symlink("Real", join(primary, "Photos"));

    await assert.rejects(compare(primary, replica, { only: "Photos/2019" }), /"Photos" on the Primary is a shortcut/);
  });

  it("refuses a folder whose path on the Replica goes through a shortcut or a file", async () => {
    const primary = await makeTree({ "Photos/2019/a.jpg": "a", "Docs/2019/b.txt": "b" });
    const replica = await makeTree({ "Real/2019/a.jpg": "a", "Docs": "a file" });
    await symlink("Real", join(replica, "Photos"));

    await assert.rejects(compare(primary, replica, { only: "Photos/2019" }), /"Photos" on the Replica is a shortcut/);
    await assert.rejects(compare(primary, replica, { only: "Docs/2019" }), /"Docs" on the Replica is not a folder/);
  });

  it("refuses a folder that cannot be read, or that sits in a folder that cannot be listed, on the Primary", async () => {
    const primary = await makeTree({ "Photos/2019/a.jpg": "a" });
    const replica = await makeTree();
    const before = await snapshotTree(primary);
    for (const [locked, mode] of [["Photos/2019", 0o000], ["Photos", 0o311]] as const) {
      await chmod(join(primary, locked), mode);
      try {
        await assert.rejects(compare(primary, replica, { only: "Photos/2019" }), /on the Primary cannot be read/);
      } finally {
        await chmod(join(primary, locked), 0o755);
      }
    }
    assert.deepEqual(await snapshotTree(primary), before, "the Primary must never be written to");
  });

  it("refuses a folder that is not plainly a folder inside the drive, is sync-drive's own, or is left out by the Exclusions", async () => {
    const primary = await makeTree({ "Photos/2019/a.jpg": "a", "Cache/x": "x" });
    const replica = await makeTree();

    for (const only of ["", "/Photos", "Photos/../Photos", "Photos//2019", "Photos/./2019", "Photos/2019/"]) {
      await assert.rejects(compare(primary, replica, { only }), /is not a folder inside the drive/, only);
    }
    await assert.rejects(compare(primary, replica, { only: "sync-drive Holding Area/Photos" }), /sync-drive's own/);
    await assert.rejects(compare(primary, replica, { only: "Cache", exclusions: ["cache"] }), /left out by the Exclusions/);
  });

  it("gives no scanning total, as the drives' item counts are for the whole drives", async () => {
    const primary = await makeTree({ "Photos/2019/a.jpg": "a" });
    const replica = await makeTree();
    const seen: CompareProgress[] = [];

    await compare(primary, replica, { only: "Photos/2019", itemCounter: { itemCount: async () => 1000 }, onProgress: (p) => seen.push(p) });

    assert.ok(seen.length > 0);
    assert.ok(seen.every((p) => p.phase === "scanning" && p.total === undefined));
  });

  it("writes nothing to either drive", async () => {
    const primary = await makeTree({ "Photos/2019/a.jpg": "a", "Photos/2019/moved/b.jpg": "b" });
    const replica = await makeTree({ "photos/2019/old.jpg": "o", "Photos/2019/b.jpg": "b" });
    const [primaryBefore, replicaBefore] = await Promise.all([snapshotTree(primary), snapshotTree(replica)]);

    await compare(primary, replica, { only: "Photos/2019" });

    assert.deepEqual(await snapshotTree(primary), primaryBefore);
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("still refuses to compare when the Primary has an item named like sync-drive's own, even if excluded", async () => {
    const primary = await makeTree({ "sync-drive Holding Area/a.jpg": "x" });
    const replica = await makeTree();

    await assert.rejects(compare(primary, replica, { exclusions: ["sync-drive Holding Area"] }), /sync-drive keeps that name/);
  });

  it("rejects an Exclusion that is not as checked, rather than guess what it leaves out", async () => {
    const primary = await makeTree({ "a": "x" });
    const replica = await makeTree();

    await assert.rejects(compare(primary, replica, { exclusions: ["*"] }), /everything on the drive/);
  });
});

describe("Limiting a comparison to one folder", () => {
  it("compares only that folder, reporting paths from the top of the drive and ignoring everything outside it", async () => {
    const primary = await makeTree({ "Photos/2019/new.jpg": "n", "Photos/2019/edited.jpg": "longer", "Photos/2020/new.jpg": "n", "top.txt": "t" });
    const replica = await makeTree({ "Photos/2019/edited.jpg": "short", "Photos/2019/gone.jpg": "g", "Photos/2020/gone.jpg": "g", "old.txt": "o" });

    const report = await compare(primary, replica, { only: "Photos/2019" });

    assert.deepEqual(report.new.files, [{ path: "Photos/2019/new.jpg", size: 1 }]);
    assert.deepEqual(report.changed.files, [{ path: "Photos/2019/edited.jpg", size: 6 }]);
    assert.deepEqual(report.deleted.files, [{ path: "Photos/2019/gone.jpg", size: 1 }]);
  });

  it("measures the Safety stop against the folder's contents, not the whole Replica", async () => {
    const outside = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`Other/${i}.txt`, "x"]));
    const inFolder = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`Photos/2019/${i}.jpg`, "x"]));
    const primary = await makeTree({ ...outside, "Photos/2019/kept.jpg": "k" });
    const replica = await makeTree({ ...outside, ...inFolder, "Photos/2019/kept.jpg": "k" });

    const report = await compare(primary, replica, { only: "Photos/2019" });

    assert.deepEqual(report.replica, { count: 151, totalSize: 151 });
    assert.equal(report.deleted.count, 150);
    assert.equal(report.safetyStop, true);
  });

  it("still needs more than 100 deleted files for the Safety stop, however small the folder", async () => {
    const inFolder = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`Photos/2019/${i}.jpg`, "x"]));
    const primary = await makeTree({ "Photos/2019/kept.jpg": "k" });
    const replica = await makeTree({ ...inFolder, "Photos/2019/kept.jpg": "k" });

    const report = await compare(primary, replica, { only: "Photos/2019" });

    assert.equal(report.deleted.count, 100);
    assert.equal(report.safetyStop, false);
  });

  it("reports a file moved across the folder's edge as new or deleted, as it cannot be recognised as a move", async () => {
    const primary = await makeTree({ "Photos/2019/arrived.jpg": "a", "Elsewhere/left.jpg": "l" });
    const replica = await makeTree({ "Elsewhere/arrived.jpg": "a", "Photos/2019/left.jpg": "l" });

    const report = await compare(primary, replica, { only: "Photos/2019" });

    assert.deepEqual(report.moves.moves, []);
    assert.deepEqual(report.new.files, [{ path: "Photos/2019/arrived.jpg", size: 1 }]);
    assert.deepEqual(report.deleted.files, [{ path: "Photos/2019/left.jpg", size: 1 }]);
  });

  it("still finds moves within the folder", async () => {
    const primary = await makeTree({ "Photos/2019/Iceland/a.jpg": "a" });
    const replica = await makeTree({ "Photos/2019/a.jpg": "a" });

    const report = await compare(primary, replica, { only: "Photos/2019" });

    assert.deepEqual(report.moves.moves, [{ from: "Photos/2019/a.jpg", to: "Photos/2019/Iceland/a.jpg", size: 1 }]);
  });

  it("treats a folder not yet on the Replica as empty there: everything in it is new", async () => {
    const primary = await makeTree({ "Photos/2019/a.jpg": "a" });
    const replica = await makeTree({ "Other/b.jpg": "b" });

    const report = await compare(primary, replica, { only: "Photos/2019" });

    assert.deepEqual(report.new.files, [{ path: "Photos/2019/a.jpg", size: 1 }]);
    assert.deepEqual(report.deleted.files, []);
    assert.deepEqual(report.replica, { count: 0, totalSize: 0 });
  });
});

describe("Compare progress", () => {
  /** An item counter that gives each drive's count as listed, and no usable count for any other. */
  function itemCounts(counts: Record<string, number>): ItemCounter {
    return { itemCount: async (mountPoint) => counts[mountPoint] };
  }

  it("reports items scanned (files plus folders) out of both drives' item counts, read before scanning", async () => {
    const primary = await makeTree({ "Photos/a.jpg": "a", "Photos/b.jpg": "b", "notes.txt": "n" });
    const replica = await makeTree({ "Docs/old.pdf": "abc" });
    const seen: CompareProgress[] = [];

    await compare(primary, replica, { itemCounter: itemCounts({ [primary]: 10, [replica]: 20 }), onProgress: (p) => seen.push(p) });

    assert.deepEqual(seen[0], { phase: "scanning", scanned: 0, total: 30 });
    // Photos, a.jpg, b.jpg, notes.txt on the Primary; Docs, old.pdf on the Replica.
    assert.deepEqual(seen.at(-1), { phase: "scanning", scanned: 6, total: 30 });
    const scanned = seen.map((p) => (p.phase === "scanning" ? p.scanned : -1));
    assert.deepEqual(scanned, [...scanned].sort((a, b) => a - b), "never goes backwards");
  });

  it("reports no total when either drive has no usable item count", async () => {
    const primary = await makeTree({ "notes.txt": "n" });
    const replica = await makeTree();
    const seen: CompareProgress[] = [];

    await compare(primary, replica, { itemCounter: itemCounts({ [primary]: 10 }), onProgress: (p) => seen.push(p) });

    assert.deepEqual(seen[0], { phase: "scanning", scanned: 0 });
    assert.deepEqual(seen.at(-1), { phase: "scanning", scanned: 1 });
  });

  it("reports no total when an item count cannot be read, and compares all the same", async () => {
    const primary = await makeTree({ "notes.txt": "n" });
    const replica = await makeTree();
    const seen: CompareProgress[] = [];
    const failing: ItemCounter = { itemCount: () => Promise.reject(new Error("statfs failed")) };

    const report = await compare(primary, replica, { itemCounter: failing, onProgress: (p) => seen.push(p) });

    assert.deepEqual(seen.at(-1), { phase: "scanning", scanned: 1 });
    assert.deepEqual(report.new.files, [{ path: "notes.txt", size: 1 }]);
  });

  it("then reports bytes read to confirm moves, out of each candidate's size on both drives", async () => {
    const primary = await makeTree({ "New/x.jpg": "12345", "New/y.jpg": "123" });
    const replica = await makeTree({ "Old/x.jpg": "12345", "Old/y.jpg": "123" });
    const seen: CompareProgress[] = [];

    const report = await compare(primary, replica, { onProgress: (p) => seen.push(p) });

    assert.equal(report.moves.count, 2);
    const checking = seen.filter((p) => p.phase === "checking moves");
    assert.deepEqual(checking[0], { phase: "checking moves", checkedBytes: 0, totalBytes: 16 });
    assert.deepEqual(checking.at(-1), { phase: "checking moves", checkedBytes: 16, totalBytes: 16 });
    assert.equal(seen.findIndex((p) => p.phase === "checking moves"), seen.length - checking.length, "after all the scanning");
  });

  it("reports no move checking when there are no candidates", async () => {
    const primary = await makeTree({ "New/x.jpg": "12345" });
    const replica = await makeTree();
    const seen: CompareProgress[] = [];

    await compare(primary, replica, { onProgress: (p) => seen.push(p) });

    assert.ok(seen.every((p) => p.phase === "scanning"));
  });

  it("makes the same Report with progress reported, even to a listener that throws", async () => {
    const spec = { "New/x.jpg": "12345", "notes.txt": "edited", "only-primary.txt": "p" };
    const primary = await makeTree(spec);
    const replica = await makeTree({ "Old/x.jpg": "12345", "notes.txt": "old", "only-replica.txt": "r" });
    const without = await compare(primary, replica);

    const withProgress = await compare(primary, replica, {
      itemCounter: itemCounts({ [primary]: 5, [replica]: 5 }),
      onProgress: () => {
        throw new Error("the screens went away");
      },
    });

    assert.deepEqual(withProgress, without);
  });
});

describe("Checking an Exclusion as typed", () => {
  it("trims it and takes off a trailing /, keeping a leading / that anchors it", () => {
    assert.equal(checkExclusion("  Movies/Cache/ "), "Movies/Cache");
    assert.equal(checkExclusion("/Scratch/"), "/Scratch");
    assert.equal(checkExclusion("*.tmp"), "*.tmp");
  });

  it("refuses an empty pattern, an empty, . or .. name, and one that would leave out everything", () => {
    for (const typed of ["", "   ", "/", "a//b", "./a", "a/../b"]) assert.throws(() => checkExclusion(typed), Error, typed);
    for (const typed of ["*", "**", "/*", "*/*", "**/*", "?*", "*?", "/?*", "**/?*"]) assert.throws(() => checkExclusion(typed), /everything on the drive/, typed);
  });
});

describe("Deep verify", () => {
  it("reports a file whose size and date match but whose contents differ as a content mismatch, not as changed", async () => {
    const primary = await makeTree({ "Photos/a.jpg": "AAAA", "Photos/b.jpg": "same" });
    const replica = await makeTree({ "Photos/a.jpg": "ZZZZ", "Photos/b.jpg": "same" });

    const report = await compare(primary, replica, { deep: true });

    assert.deepEqual(report.anomalies.contentMismatch.files, [{ path: "Photos/a.jpg", size: 4 }]);
    assert.deepEqual(report.changed.files, []);
    assert.deepEqual(report.new.files, []);
    assert.deepEqual(report.deleted.files, []);
  });

  it("reports bytes read to verify contents, out of each file's size on both drives, after scanning and before confirming moves", async () => {
    const primary = await makeTree({ "a.txt": "12345", "b.txt": "123", "New/x.jpg": "xx" });
    const replica = await makeTree({ "a.txt": "12345", "b.txt": "123", "Old/x.jpg": "xx" });
    const seen: CompareProgress[] = [];

    await compare(primary, replica, { deep: true, onProgress: (p) => seen.push(p) });

    const phases = seen.map((p) => p.phase).filter((phase, i, all) => phase !== all[i - 1]);
    assert.deepEqual(phases, ["scanning", "verifying", "checking moves"]);
    const verifying = seen.filter((p) => p.phase === "verifying");
    assert.deepEqual(verifying[0], { phase: "verifying", checkedBytes: 0, totalBytes: 16 });
    assert.deepEqual(verifying.at(-1), { phase: "verifying", checkedBytes: 16, totalBytes: 16 });
    const checked = verifying.map((p) => p.checkedBytes);
    assert.deepEqual(checked, [...checked].sort((a, b) => a - b), "never goes backwards");
  });

  it("lists a Primary file it cannot read in full as unreadable, and never treats its Replica copy or a lookalike as deleted", async () => {
    const primary = await makeTree({ "Docs/a.txt": "aaaa", "b.txt": "bbbb" });
    const replica = await makeTree({ "Docs/a.txt": "aaaa", "Old/a.txt": "aaaa", "b.txt": "BBBB" });
    const sha256 = new Sha256Hasher();
    const damaged: Hasher = {
      checksum: (path) =>
        path === join(primary, "Docs/a.txt") ? Promise.reject(Object.assign(new Error("EIO: i/o error"), { code: "EIO" })) : sha256.checksum(path),
    };

    const report = await compare(primary, replica, { deep: true, hasher: damaged });

    assert.deepEqual(report.unreadable, [{ path: "Docs/a.txt", folder: false, reason: "the drive could not read it (EIO)" }]);
    assert.deepEqual(report.deleted.files, []);
    assert.deepEqual(report.anomalies.contentMismatch.files, [{ path: "b.txt", size: 4 }]);
  });

  it("reports a Replica copy it cannot read in full as a content mismatch, saying why, and still compares the rest", async () => {
    const primary = await makeTree({ "a.txt": "aaaa", "b.txt": "bbbb" });
    const replica = await makeTree({ "a.txt": "aaaa", "b.txt": "bbbb" });
    const sha256 = new Sha256Hasher();
    const damaged: Hasher = {
      checksum: (path) =>
        path === join(replica, "a.txt") ? Promise.reject(Object.assign(new Error("EIO: i/o error"), { code: "EIO" })) : sha256.checksum(path),
    };

    const report = await compare(primary, replica, { deep: true, hasher: damaged });

    assert.deepEqual(report.anomalies.contentMismatch.files, [
      { path: "a.txt", size: 4, replicaReadFailure: "the drive could not read it (EIO)" },
    ]);
    assert.deepEqual(report.unreadable, []);
  });

  it("stops when a Replica copy cannot be read for any reason but damage, rather than call it a content mismatch", async () => {
    const primary = await makeTree({ "a.txt": "aaaa", "b.txt": "bbbb" });
    const replica = await makeTree({ "a.txt": "aaaa", "b.txt": "bbbb" });
    const sha256 = new Sha256Hasher();
    for (const code of ["ENOENT", "EACCES", "ENXIO"]) {
      const failing: Hasher = {
        checksum: (path) =>
          path === join(replica, "a.txt") ? Promise.reject(Object.assign(new Error(`${code}: failed`), { code })) : sha256.checksum(path),
      };

      await assert.rejects(compare(primary, replica, { deep: true, hasher: failing }), /The Replica's copy of a\.txt could not be read/, code);
    }
  });

  it("reports a file edited on the Primary while it was being verified as changed, not as a content mismatch", async () => {
    const primary = await makeTree({ "notes.txt": "before" });
    const replica = await makeTree({ "notes.txt": "before" });
    const sha256 = new Sha256Hasher();
    const editedMeanwhile: Hasher = {
      checksum: async (path) => {
        if (path !== join(primary, "notes.txt")) return sha256.checksum(path);
        // The owner saves the file as it is read.
        await writeFile(path, "after, and longer");
        return sha256.checksum(path);
      },
    };

    const report = await compare(primary, replica, { deep: true, hasher: editedMeanwhile });

    assert.deepEqual(report.changed.files, [{ path: "notes.txt", size: 6 }]);
    assert.deepEqual(report.anomalies.contentMismatch.files, []);
  });

  it("writes nothing to either drive", async () => {
    const primary = await makeTree({ "a.txt": "AAAA", "b.txt": "same", "New/x.jpg": "xx" });
    const replica = await makeTree({ "a.txt": "ZZZZ", "b.txt": "same", "Old/x.jpg": "xx" });
    const primaryBefore = await snapshotTree(primary);
    const replicaBefore = await snapshotTree(replica);

    await compare(primary, replica, { deep: true });

    assert.deepEqual(await snapshotTree(primary), primaryBefore);
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("reads only what a Quick compare with the same Folder limit and Exclusions compares", async () => {
    const primary = await makeTree({ "Photos/a.jpg": "AAAA", "Photos/cache.tmp": "CCCC", "Docs/b.txt": "BBBB" });
    const replica = await makeTree({ "Photos/a.jpg": "ZZZZ", "Photos/cache.tmp": "zzzz", "Docs/b.txt": "zzzz" });
    const read: string[] = [];
    const sha256 = new Sha256Hasher();
    const watching: Hasher = { checksum: (path, onRead) => (read.push(path), sha256.checksum(path, onRead)) };

    const report = await compare(primary, replica, { deep: true, only: "Photos", exclusions: ["*.tmp"], hasher: watching });

    assert.deepEqual(report.anomalies.contentMismatch.files, [{ path: "Photos/a.jpg", size: 4 }]);
    assert.deepEqual(read.sort(), [join(primary, "Photos/a.jpg"), join(replica, "Photos/a.jpg")].sort());
  });

  it("reports a file changed on the Replica while it was being verified as changed, not as a content mismatch", async () => {
    const primary = await makeTree({ "notes.txt": "before" });
    const replica = await makeTree({ "notes.txt": "before" });
    const sha256 = new Sha256Hasher();
    const changedMeanwhile: Hasher = {
      checksum: async (path) => {
        if (path === join(replica, "notes.txt")) await writeFile(path, "BEFORE");
        return sha256.checksum(path);
      },
    };

    const report = await compare(primary, replica, { deep: true, hasher: changedMeanwhile });

    assert.deepEqual(report.changed.files, [{ path: "notes.txt", size: 6 }]);
    assert.deepEqual(report.anomalies.contentMismatch.files, []);
  });
});

describe("Anomalies: Replica newer", () => {
  it("flags a changed file whose Replica copy is newer than the Primary's, keeping it among the changed files", async () => {
    const primary = await makeTree({
      "older-here.txt": { content: "primary", mtime: new Date("2026-02-01T09:00:00Z") },
      "newer-here.txt": { content: "primary", mtime: new Date("2026-04-01T09:00:00Z") },
    });
    const replica = await makeTree({
      "older-here.txt": { content: "replica", mtime: new Date("2026-03-01T09:00:00Z") },
      "newer-here.txt": { content: "replica", mtime: new Date("2026-03-01T09:00:00Z") },
    });

    for (const deep of [false, true]) {
      const report = await compare(primary, replica, { deep });

      assert.deepEqual(report.anomalies.replicaNewer.files, [{ path: "older-here.txt", size: 7 }]);
      assert.deepEqual(report.changed.files, [
        { path: "newer-here.txt", size: 7 },
        { path: "older-here.txt", size: 7 },
      ]);
    }
  });
});

