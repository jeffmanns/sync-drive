import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { NotReadableFromDriveError } from "../src/engine/index.ts";
import { MacUncachedHasher, pagesInMemory } from "../src/macos/uncached-hasher.ts";
import { makeDiskImageTree, makeTree, metadataOf, removeTrees } from "./helpers/trees.ts";

after(removeTrees);

const run = promisify(execFile);

const hasher = new MacUncachedHasher();

describe("Reading a copy back from the drive on macOS", () => {
  it("gives the SHA-256 of a file's contents", async () => {
    const dir = await makeTree({ "hello.txt": "hello", "empty.txt": "" });

    assert.equal(await hasher.checksum(join(dir, "hello.txt")), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    assert.equal(await hasher.checksum(join(dir, "empty.txt")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("reads a file larger than one read, reporting every byte for progress", async () => {
    const dir = await makeTree();
    const path = join(dir, "big.bin");
    // 3 MiB and 5 bytes of the same byte: several reads, and a last one shorter than a page.
    await writeFile(path, Buffer.alloc(3 * 1024 * 1024 + 5, 0x61));
    const read: number[] = [];

    const sum = await hasher.checksum(path, (bytes) => read.push(bytes));

    // From `head -c 3145733 /dev/zero | tr '\0' a | shasum -a 256`.
    assert.equal(sum, "aff2c7498aae939dfb2fb1dc6c0c83fa3708b069428e51338801af7f5dc2bf0f");
    assert.equal(read.reduce((total, bytes) => total + bytes, 0), 3 * 1024 * 1024 + 5);
  });

  it("reads a just-written file from the drive, leaving none of its pages in memory, and never changes it", async () => {
    const drive = await makeDiskImageTree({}, { size: "64m" });
    const path = join(drive, "copy.bin");
    // Written through the cache, so all its pages are in memory, as another app reading the copy would leave them.
    await writeFile(path, randomBytes(20 * 1024 * 1024 + 123));
    const before = await metadataOf(path);
    const inMemory = await pagesInMemory(path);
    assert.ok(inMemory.resident > 0, "the test needs a file with pages in memory");

    await hasher.checksum(path);

    assert.deepEqual(await pagesInMemory(path), { resident: 0, total: inMemory.total });
    assert.equal(await metadataOf(path), before);
  });

  it("gives the bytes on the drive, not a stale copy", async () => {
    const drive = await makeDiskImageTree({}, { size: "16m" });
    const path = join(drive, "copy.bin");
    await writeFile(path, "first version");
    await hasher.checksum(path);
    await writeFile(path, "other version");

    // shasum -a 256 of "other version".
    assert.equal(await hasher.checksum(path), "e2eb5819d249f80a4a944556e67f65ed5c35ff5fa9284c70939ec0e52e45436b");
  });

  it("rejects a missing file, and a shortcut rather than following it", async () => {
    const dir = await makeTree({ "target.txt": "hello" });
    await symlink(join(dir, "target.txt"), join(dir, "shortcut"));

    await assert.rejects(hasher.checksum(join(dir, "missing.txt")), /No such file/);
    await assert.rejects(hasher.checksum(join(dir, "shortcut")), /not a regular file/);
  });

  it("refuses a file stored compressed, which macOS always reads through memory", async () => {
    const dir = await makeTree({ "plain.txt": "compressible text ".repeat(10_000) });
    const path = join(dir, "compressed.txt");
    await run("ditto", ["--hfsCompression", join(dir, "plain.txt"), path]);
    assert.match((await run("ls", ["-lO", path])).stdout, /compressed/, "the test needs a compressed file");

    await assert.rejects(hasher.checksum(path), (error: unknown) => error instanceof NotReadableFromDriveError && /compressed/.test(error.message));
  });
});
