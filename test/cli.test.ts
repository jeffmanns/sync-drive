import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { run } from "../src/cli/run.ts";
import { FakeVolumes } from "./helpers/fake-volumes.ts";
import { MacFileCopier } from "../src/macos/file-copier.ts";
import { makeTree, removeTrees, snapshotTree, type TreeSpec } from "./helpers/trees.ts";

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
  /** How the user answers each approval question (by default, every one the same), and the questions asked so far. */
  answer: boolean | ((question: string) => boolean) = false;
  readonly questions: string[] = [];

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
      copier: new MacFileCopier(),
      confirm: async (question) => {
        this.questions.push(question);
        return typeof this.answer === "function" ? this.answer(question) : this.answer;
      },
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

  it("refuses with a clear message when a paired drive is not connected", async () => {
    const { mac, replica } = await pairedMac();

    mac.volumes.disconnect(replica);
    const missing = await mac.run("compare");
    assert.equal(missing.code, 1);
    assert.equal(missing.stdout, "");
    assert.match(missing.stderr, /Replica .* is not connected/);
  });

  it("takes no drive paths, so the roles can never be given the wrong way round", async () => {
    const { mac, primary, replica } = await pairedMac();

    const { code, stdout, stderr } = await mac.run("compare", replica, primary);

    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /Usage: .*sync-drive compare \[--list\]/s);
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

const COPY_QUESTION = "Copy 3 new and changed files (1.5 MB) to the Replica?";
const MOVE_QUESTION = "Move 1 deleted file (3 B) into the Holding area on the Replica?";

/** Connects and pairs two drives with the given trees. */
async function pairedMacWith(primarySpec: TreeSpec, replicaSpec: TreeSpec) {
  const mac = await TestMac.create();
  const primary = await makeTree(primarySpec);
  const replica = await makeTree(replicaSpec);
  mac.volumes.connect(primary, "PRIMARY-ID");
  mac.volumes.connect(replica, "REPLICA-ID");
  assert.equal((await mac.run("pair", primary, replica)).code, 0);
  return { mac, primary, replica };
}

describe("sync-drive update", () => {
  it("shows the report, asks for approval, then copies new and changed files", async () => {
    const { mac, primary, replica } = await pairedMac();
    const primaryBefore = await snapshotTree(primary);
    mac.answer = (question) => question === COPY_QUESTION;

    const { code, stdout, stderr } = await mac.run("update");

    assert.equal(code, 0, stderr);
    assert.match(stdout, /^New: 2 files, 1\.5 MB$/m);
    assert.match(stdout, /^Changed: 1 file, 8 B$/m);
    assert.deepEqual(mac.questions, [COPY_QUESTION, MOVE_QUESTION]);
    assert.match(stdout, /^Copied 3 files, 1\.5 MB\.$/m);
    assert.match(stdout, /^Deleted files were left on the Replica\.$/m);
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
    const after = await mac.run("compare");
    assert.match(after.stdout, /^New: none$/m);
    assert.match(after.stdout, /^Changed: none$/m);
    assert.match(after.stdout, /^Deleted: 1 file, 3 B$/m);
    assert.equal(await readFile(join(replica, "readme.txt"), "utf8"), "changed!");
  });

  it("moves deleted files into the Holding area only after their own confirmation", async () => {
    const { mac, primary, replica } = await pairedMac();
    const primaryBefore = await snapshotTree(primary);
    mac.answer = true;

    const { code, stdout, stderr } = await mac.run("update");

    assert.equal(code, 0, stderr);
    assert.deepEqual(mac.questions, [COPY_QUESTION, MOVE_QUESTION]);
    assert.match(stdout, /^Moved 1 file, 3 B, into the Holding area\.$/m);
    assert.equal(await readFile(join(replica, "sync-drive Holding Area", "Docs", "old.pdf"), "utf8"), "abc");
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
    const after = await mac.run("compare");
    assert.match(after.stdout, /^Deleted: none$/m);
  });

  it("writes nothing, and asks nothing more, when the user declines the main approval", async () => {
    const { mac, primary, replica } = await pairedMac();
    const primaryBefore = await snapshotTree(primary);
    const replicaBefore = await snapshotTree(replica);
    mac.answer = false;

    const { code, stdout } = await mac.run("update", "--list");

    assert.equal(code, 0);
    assert.match(stdout, /^ {4}a\.jpg +1\.5 MB$/m);
    assert.deepEqual(mac.questions, [COPY_QUESTION]);
    assert.match(stdout, /^Nothing was written to the Replica\.$/m);
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("asks only about deletions when there is nothing to copy", async () => {
    const { mac, primary, replica } = await pairedMacWith({ "a.txt": "same" }, { "a.txt": "same", "old.txt": "x" });
    const primaryBefore = await snapshotTree(primary);
    const replicaBefore = await snapshotTree(replica);

    const declined = await mac.run("update");

    assert.equal(declined.code, 0);
    assert.deepEqual(mac.questions, ["Move 1 deleted file (1 B) into the Holding area on the Replica?"]);
    assert.match(declined.stdout, /^Nothing was written to the Replica\.$/m);
    assert.deepEqual(await snapshotTree(replica), replicaBefore);

    mac.answer = true;
    const moved = await mac.run("update");

    assert.equal(moved.code, 0, moved.stderr);
    assert.match(moved.stdout, /^Moved 1 file, 1 B, into the Holding area\.$/m);
    assert.doesNotMatch(moved.stdout, /Copied/);
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
  });

  it("does not ask when nothing differs", async () => {
    const { mac, replica } = await pairedMacWith({ "a.txt": "same" }, { "a.txt": "same" });
    const replicaBefore = await snapshotTree(replica);

    const { code, stdout } = await mac.run("update");

    assert.equal(code, 0);
    assert.deepEqual(mac.questions, []);
    assert.match(stdout, /^Nothing to update\.$/m);
    assert.deepEqual(await snapshotTree(replica), replicaBefore);
  });

  it("warns before asking that approving empties the previous Holding area for good", async () => {
    const { mac, replica } = await pairedMacWith({ "a.txt": "same" }, { "a.txt": "same", "Docs/first.txt": "12345" });
    mac.answer = true;
    await mac.run("update");
    await writeFile(join(replica, "second.txt"), "x");
    mac.answer = false;

    const { stdout } = await mac.run("update");

    assert.match(stdout, /^The Holding area on the Replica holds 1 file, 5 B, from the previous Update\. Approving this Update deletes it permanently\.$/m);
    assert.equal(await readFile(join(replica, "sync-drive Holding Area", "Docs", "first.txt"), "utf8"), "12345");
  });

  it("takes no drive paths, so the roles can never be given the wrong way round", async () => {
    const { mac, primary, replica } = await pairedMac();
    const primaryBefore = await snapshotTree(primary);
    mac.answer = true;

    const { code, stderr } = await mac.run("update", replica, primary);

    assert.equal(code, 2);
    assert.match(stderr, /sync-drive update \[--list\]/);
    assert.deepEqual(mac.questions, []);
    assert.deepEqual(await snapshotTree(primary), primaryBefore);
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
    assert.match(failed.stderr, /sync-drive compare \[--list\]/);
  });
});
