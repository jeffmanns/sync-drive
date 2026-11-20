import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { makeTree, removeTrees, snapshotTree } from "./helpers/trees.ts";

after(removeTrees);

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(...args: string[]): Promise<CliRun> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

async function exampleDrives(): Promise<{ primary: string; replica: string }> {
  const primary = await makeTree({
    "Photos/2026/a.jpg": "x".repeat(1_500_000),
    "Photos/2026/b.jpg": "12345",
    "readme.txt": "changed!",
  });
  const replica = await makeTree({
    "readme.txt": "old",
    "Docs/old.pdf": "abc",
  });
  return { primary, replica };
}

describe("sync-drive compare", () => {
  it("prints each section grouped by folder with file counts and total sizes", async () => {
    const { primary, replica } = await exampleDrives();

    const { code, stdout } = await runCli("compare", primary, replica);

    assert.equal(code, 0);
    assert.match(stdout, /^New: 2 files, 1\.5 MB$/m);
    assert.match(stdout, /^ {2}Photos\/2026\/ +2 files +1\.5 MB$/m);
    assert.match(stdout, /^Changed: 1 file, 8 B$/m);
    assert.match(stdout, /^ {2}\(top level\) +1 file +8 B$/m);
    assert.match(stdout, /^Deleted: 1 file, 3 B$/m);
    assert.match(stdout, /^ {2}Docs\/ +1 file +3 B$/m);
    assert.doesNotMatch(stdout, /a\.jpg/);
  });

  it("shows the full file-by-file list with --list", async () => {
    const { primary, replica } = await exampleDrives();

    const { code, stdout } = await runCli("compare", primary, replica, "--list");

    assert.equal(code, 0);
    assert.match(stdout, /^ {4}a\.jpg +1\.5 MB$/m);
    assert.match(stdout, /^ {4}b\.jpg +5 B$/m);
    assert.match(stdout, /^ {4}old\.pdf +3 B$/m);
  });

  it("writes nothing to either drive while reporting differences", async () => {
    const { primary, replica } = await exampleDrives();
    const primaryBefore = await snapshotTree(primary);
    const replicaBefore = await snapshotTree(replica);

    const { code } = await runCli("compare", primary, replica, "--list");

    assert.equal(code, 0);
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("says so when the Replica matches the Primary", async () => {
    const primary = await makeTree({ "a.txt": "same" });
    const replica = await makeTree({ "a.txt": "same" });

    const { code, stdout } = await runCli("compare", primary, replica);

    assert.equal(code, 0);
    assert.match(stdout, /^New: none$/m);
    assert.match(stdout, /^Changed: none$/m);
    assert.match(stdout, /^Deleted: none$/m);
  });

  it("explains how to use it when the drives are not given", async () => {
    const { code, stderr } = await runCli("compare");

    assert.equal(code, 2);
    assert.match(stderr, /Usage: sync-drive compare <primary> <replica>/);
  });
});
