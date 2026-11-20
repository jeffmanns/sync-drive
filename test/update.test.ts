import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { compare, update, type Approvals, type FileCopier } from "../src/engine/index.ts";
import { MacFileCopier } from "../src/macos/file-copier.ts";
import { extendedAttributes, makeDiskImageTree, makeTree, metadataOf, removeTrees, snapshotTree } from "./helpers/trees.ts";

after(removeTrees);

const APPROVED: Approvals = { update: true };

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
    const run = promisify(execFile);
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

  it("writes nothing to the Replica without the main approval", async () => {
    const primary = await makeTree({ "new.txt": "new", "notes.txt": "edited" });
    const replica = await makeTree({
      "notes.txt": { content: "before", mtime: new Date("2025-01-01") },
      ".sync-drive-incoming/leftover": "x",
    });
    const replicaBefore = await snapshotTree(replica);

    const result = await compareAndUpdate(primary, replica, { update: false });

    assert.deepEqual(result, { copied: [], failed: [] });
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

  it("never follows a shortcut on the Primary, and says it was not copied", async () => {
    const elsewhere = await makeTree({ "secret.txt": "not on the Primary" });
    const primary = await makeTree();
    await symlink(join(elsewhere, "secret.txt"), join(primary, "link.txt"));
    const replica = await makeTree();

    const result = await compareAndUpdate(primary, replica);

    assert.deepEqual(result.copied, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]!.path, "link.txt");
    assert.match(result.failed[0]!.reason, /shortcut/);
    assert.deepEqual(await readdir(replica), []);
  });

  it("refuses, writing nothing, when the Replica is the Primary or inside it", async () => {
    const primary = await makeTree({ "a.txt": "a", "Backup/old.txt": "x" });
    const primaryBefore = await snapshotTree(primary);
    const report = await compare(primary, join(primary, "Backup"));

    for (const replica of [primary, join(primary, "Backup"), join(primary, "Backup", "..")]) {
      await assert.rejects(update(report, APPROVED, { primary, replica, copier: new MacFileCopier() }), /overlap/);
    }
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
  });

  it("refuses, writing nothing, a report path that would lead outside the Replica", async () => {
    const outside = await makeTree();
    const primary = await makeTree({ "escape.txt": "x" });
    const replica = join(outside, "Replica");
    await mkdir(replica);
    const report = await compare(primary, replica);
    report.new.files[0]!.path = "../escape.txt";

    await assert.rejects(
      update(report, APPROVED, { primary, replica, copier: new MacFileCopier() }),
      /"\.\.\/escape\.txt" is not a path inside the drive/,
    );
    assert.deepEqual(await readdir(outside), ["Replica"]);
    assert.deepEqual(await readdir(replica), []);
  });
});

/** A Finder tags list holding the single tag "Red", as Finder stores it (a binary property list). */
const RED_TAG_HEX =
  "62706C6973743030A101565265640A36080A0000000000000101000000000000000200000000000000000000000000000013";
