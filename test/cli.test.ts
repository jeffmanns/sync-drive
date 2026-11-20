import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { run } from "../src/cli/run.ts";
import { FakeVolumes } from "./helpers/fake-volumes.ts";
import { makeTree, removeTrees, snapshotTree } from "./helpers/trees.ts";

after(removeTrees);

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** A Mac with its own place for the Pairing and its own connected drives. */
class TestMac {
  readonly volumes = new FakeVolumes();
  readonly pairingFile: string;

  private constructor(pairingFile: string) {
    this.pairingFile = pairingFile;
  }

  static async create(): Promise<TestMac> {
    return new TestMac(join(await makeTree(), "sync-drive", "pairing.json"));
  }

  async run(...args: string[]): Promise<CliRun> {
    let stdout = "";
    let stderr = "";
    const code = await run(args, {
      volumes: this.volumes,
      pairingFile: this.pairingFile,
      out: (text) => (stdout += text + "\n"),
      err: (text) => (stderr += text + "\n"),
    });
    return { code, stdout, stderr };
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

/** A Mac with the example drives connected and paired. */
async function pairedMac(): Promise<{ mac: TestMac; primary: string; replica: string }> {
  const mac = await TestMac.create();
  const { primary, replica } = await exampleDrives();
  mac.volumes.connect(primary, "PRIMARY-ID");
  mac.volumes.connect(replica, "REPLICA-ID");
  const paired = await mac.run("pair", primary, replica);
  assert.equal(paired.code, 0, paired.stderr);
  return { mac, primary, replica };
}

describe("sync-drive compare", () => {
  it("compares the paired drives when given no arguments", async () => {
    const { mac, primary, replica } = await pairedMac();

    const { code, stdout } = await mac.run("compare");

    assert.equal(code, 0);
    assert.match(stdout, new RegExp(`^Primary: .*${primary}`, "m"));
    assert.match(stdout, new RegExp(`^Replica: .*${replica}`, "m"));
    assert.match(stdout, /^New: 2 files, 1\.5 MB$/m);
    assert.match(stdout, /^ {2}Photos\/2026\/ +2 files +1\.5 MB$/m);
    assert.match(stdout, /^Changed: 1 file, 8 B$/m);
    assert.match(stdout, /^ {2}\(top level\) +1 file +8 B$/m);
    assert.match(stdout, /^Deleted: 1 file, 3 B$/m);
    assert.match(stdout, /^ {2}Docs\/ +1 file +3 B$/m);
    assert.doesNotMatch(stdout, /a\.jpg/);
  });

  it("refuses, saying how to pair, when the drives have not been paired", async () => {
    const mac = await TestMac.create();
    const { primary, replica } = await exampleDrives();
    mac.volumes.connect(primary, "PRIMARY-ID");
    mac.volumes.connect(replica, "REPLICA-ID");

    const { code, stdout, stderr } = await mac.run("compare");

    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /not been paired.*sync-drive pair/);
  });

  it("refuses with a clear message when the paired drives are not the ones connected", async () => {
    const { mac, primary, replica } = await pairedMac();

    const swapped = await mac.run("compare", replica, primary);
    assert.equal(swapped.code, 1);
    assert.equal(swapped.stdout, "");
    assert.match(swapped.stderr, /^sync-drive: The Primary and the Replica are swapped/);

    mac.volumes.disconnect(replica);
    const missing = await mac.run("compare");
    assert.equal(missing.code, 1);
    assert.equal(missing.stdout, "");
    assert.match(missing.stderr, /Replica .* is not connected/);
  });

  it("checks drives given by path against the Pairing and compares them", async () => {
    const { mac, primary, replica } = await pairedMac();

    const { code, stdout } = await mac.run("compare", primary, replica);

    assert.equal(code, 0);
    assert.match(stdout, /^New: 2 files, 1\.5 MB$/m);
  });

  it("shows the full file-by-file list with --list", async () => {
    const { mac } = await pairedMac();

    const { code, stdout } = await mac.run("compare", "--list");

    assert.equal(code, 0);
    assert.match(stdout, /^ {4}a\.jpg +1\.5 MB$/m);
    assert.match(stdout, /^ {4}b\.jpg +5 B$/m);
    assert.match(stdout, /^ {4}old\.pdf +3 B$/m);
  });

  it("says so when the Replica matches the Primary", async () => {
    const mac = await TestMac.create();
    const primary = await makeTree({ "a.txt": "same" });
    const replica = await makeTree({ "a.txt": "same" });
    mac.volumes.connect(primary, "PRIMARY-ID");
    mac.volumes.connect(replica, "REPLICA-ID");
    await mac.run("pair", primary, replica);

    const { code, stdout } = await mac.run("compare");

    assert.equal(code, 0);
    assert.match(stdout, /^New: none$/m);
    assert.match(stdout, /^Changed: none$/m);
    assert.match(stdout, /^Deleted: none$/m);
  });
});

describe("sync-drive pair", () => {
  it("refuses to replace an existing Pairing unless asked to with --replace", async () => {
    const { mac, primary, replica } = await pairedMac();
    const newReplica = await makeTree({ "readme.txt": "old", "Docs/old.pdf": "abc" });
    mac.volumes.connect(newReplica, "NEW-REPLICA-ID");

    const refused = await mac.run("pair", primary, newReplica);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /already paired/);
    assert.match(refused.stderr, /--replace/);
    assert.match((await mac.run("compare")).stdout, new RegExp(`^Replica: .*${replica}`, "m"));

    const replaced = await mac.run("pair", primary, newReplica, "--replace");
    assert.equal(replaced.code, 0, replaced.stderr);
    const { code, stdout } = await mac.run("compare");
    assert.equal(code, 0);
    assert.match(stdout, new RegExp(`^Replica: .*${newReplica}`, "m"));
  });

  it("treats a damaged Pairing as one that only --replace may overwrite", async () => {
    const { mac, primary, replica } = await pairedMac();
    await writeFile(mac.pairingFile, "{ not json");

    const refused = await mac.run("pair", primary, replica);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /damaged.*--replace/);
    assert.equal(await readFile(mac.pairingFile, "utf8"), "{ not json");

    assert.equal((await mac.run("pair", primary, replica, "--replace")).code, 0);
    assert.equal((await mac.run("compare")).code, 0);
  });

  it("refuses to pair a drive with itself, and stores nothing", async () => {
    const mac = await TestMac.create();
    const drive = await makeTree();
    mac.volumes.connect(drive, "SAME-ID");

    const paired = await mac.run("pair", drive, drive);
    assert.equal(paired.code, 1);
    assert.match(paired.stderr, /same drive/);
    assert.match((await mac.run("compare")).stderr, /not been paired/);
  });
});

describe("sync-drive", () => {
  it("writes nothing to either drive while pairing and comparing", async () => {
    const mac = await TestMac.create();
    const { primary, replica } = await exampleDrives();
    mac.volumes.connect(primary, "PRIMARY-ID");
    mac.volumes.connect(replica, "REPLICA-ID");
    const primaryBefore = await snapshotTree(primary);
    const replicaBefore = await snapshotTree(replica);

    assert.equal((await mac.run("pair", primary, replica)).code, 0);
    assert.equal((await mac.run("compare", "--list")).code, 0);

    assert.deepEqual(await snapshotTree(primary), primaryBefore);
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("explains how to use it when the command is incomplete", async () => {
    const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const failed = await promisify(execFile)(process.execPath, [CLI, "pair"]).then(
      () => assert.fail("expected the CLI to fail"),
      (error: { code: number; stderr: string }) => error,
    );

    assert.equal(failed.code, 2);
    assert.match(failed.stderr, /Usage: sync-drive pair <primary> <replica>/);
    assert.match(failed.stderr, /sync-drive compare \[<primary> <replica>\]/);
  });
});
