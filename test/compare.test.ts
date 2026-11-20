import assert from "node:assert/strict";
import { lutimes, symlink } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { compare } from "../src/engine/index.ts";
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
    for (const name of ["sync-drive Holding Area", "SYNC-DRIVE holding area", ".sync-drive-incoming"]) {
      const primary = await makeTree({ [`${name}/mine.txt`]: "the user's own file" });
      const replica = await makeTree();

      await assert.rejects(compare(primary, replica), new RegExp(`Primary has an item named "${name}"`));
    }
  });
});
