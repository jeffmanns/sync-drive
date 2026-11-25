import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { _electron as electron } from "playwright-core";
import { pairDrives, writePairing } from "../src/engine/index.ts";
import { formatDay } from "../src/format.ts";
import { MacVolumes } from "../src/macos/volume-identity.ts";
import { makeDiskImageTree, makeTree, removeTrees, snapshotTree } from "./helpers/trees.ts";

after(async () => {
  const started = performance.now();
  await removeTrees();
  // Not a test diagnostic: the test has ended by now.
  console.log(`e2e phase: cleanup ${Math.round(performance.now() - started)} ms`);
});

const PROJECT = fileURLToPath(new URL("..", import.meta.url));

describe("the desktop app", () => {
  it("launches and runs a Deep verify and an Update with copies, an overwritten content mismatch and deletions from Start to Result", async (t) => {
    const phase = phaseTimer(t);
    const primary = await makeDiskImageTree(
      { "Photos/a.jpg": "new photo", "readme.txt": "changed!", "Photos/scratch.tmp": "excluded", "notes.txt": "AAAA" },
      { name: "Smoke Primary" },
    );
    const replica = await makeDiskImageTree(
      // notes.txt matches by size and date, but not by contents: only a Deep verify finds it.
      { "readme.txt": "old", "old.txt": "only here", "sync-drive Holding Area/earlier.txt": "held", "notes.txt": "zzzz" },
      { name: "Smoke Replica" },
    );
    const pairingFile = join(await makeTree(), "pairing.json");
    const volumes = new MacVolumes();
    // The disk images are written straight into the Pairing: the guided Pairing needs exactly two drives that can be paired, and a Mac running the tests may have others.
    await writePairing(pairingFile, pairDrives(await volumes.volumeAt(primary), await volumes.volumeAt(replica)));
    const primaryBefore = await primarySnapshot(primary);
    phase("disk images and Pairing");
    // Tests run with ELECTRON_RUN_AS_NODE; the app must not, or it would start as plain Node.
    const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;

    const app = await electron.launch({
      // Electron sometimes takes nearly 30 s to start on the CI runner, even with no other test running
      // (#45). The test checks what the app does, not how fast it starts.
      timeout: 90_000,
      // The tests run on Electron's own runtime, so this is the Electron the app runs on.
      executablePath: process.execPath,
      args: [PROJECT],
      env: { ...env, SYNC_DRIVE_PAIRING_FILE: pairingFile },
    });
    phase("launch");
    try {
      const window = await app.firstWindow();
      window.setDefaultTimeout(30_000);
      phase("first window");
      await window.getByText('"Smoke Primary"').waitFor();
      await window.getByText("sync-drive has not updated the whole Replica yet.").waitFor();
      phase("Start screen");
      await window.getByLabel("Exclude:").fill("*.tmp");
      // A trial click fails if anything covers the button, as the step's own buttons once did (found by the rehearsal, #16).
      await window.getByRole("button", { name: "Limit to one folder…" }).click({ trial: true, timeout: 5_000 });
      await window.getByRole("button", { name: "Add" }).click();
      await window.getByRole("button", { name: "Remove *.tmp" }).waitFor();
      await window.getByLabel(/^Deep verify/).click();
      await window.locator("input[type=checkbox]:checked").waitFor();
      await window.getByRole("button", { name: "Compare" }).click();
      await window.getByRole("heading", { name: "Copies" }).waitFor({ timeout: 30_000 });
      phase("compare");
      assert.equal(await window.locator(".warning").count(), 0, "no Holding area warning before the copies Approval");
      await window.getByRole("button", { name: /Photos\// }).click();
      await window.getByText("a.jpg").waitFor();
      // The tick shows once the flow in the main process has the Approval, so wait for it.
      await window.getByLabel("Copy all 2 files").click();
      await window.locator("input[type=checkbox]:checked").waitFor();
      await window.getByRole("button", { name: "Next" }).click();
      await window.getByRole("heading", { name: "Anomalies" }).waitFor();
      await window.getByText("notes.txt").waitFor();
      await window.getByLabel("Overwrite with the Primary's").click();
      await window.locator("input[type=radio]:checked").waitFor();
      await window.getByRole("button", { name: "Next" }).click();
      await window.getByRole("heading", { name: "Deletions" }).waitFor();
      await window.getByRole("button", { name: /top level/ }).click();
      await window.getByText("old.txt").waitFor();
      // The warning sits right before the deletions Approval (ADR 0006).
      await window.locator("p.warning + label.confirm").waitFor();
      assert.match(await window.locator("p.warning").innerText(), /holds 1 file \(4 B\) from an earlier Update\. Approving these deletions deletes it permanently\./);
      await window.getByLabel("Move all 1 file").click();
      await window.locator("input[type=checkbox]:checked").waitFor();
      await window.getByRole("button", { name: "Next" }).click();
      await window.getByText("Copy 2 files (17 B) from the Primary to the Replica.").waitFor();
      await window.getByText("Overwrite 1 file (4 B) with a content mismatch on the Replica with the Primary's copy, as you chose.").waitFor();
      await window.getByText("Move 1 file (9 B) no longer on the Primary into the Holding area.").waitFor();
      await window.getByText("Permanently delete the 1 file (4 B) in the Holding area from an earlier Update.").waitFor();
      phase("review steps");
      await window.getByRole("button", { name: "Apply" }).click();
      await window.getByRole("heading", { name: "Update done" }).waitFor({ timeout: 30_000 });
      phase("Update, including remounting the Primary");
      await window.getByText("Copied: 3 files (21 B)").waitFor();
      await window.getByText("Content mismatches overwritten with the Primary's copy: 1 file (4 B)").waitFor();
      await window.getByText("Moved into the Holding area: 1 file (9 B)").waitFor();
      // The deleted file and the overwritten content mismatch's Replica copy.
      await window.getByText(`The Holding area on the Replica holds 2 files (13 B), last added to by the Update on ${formatDay(new Date())}.`).waitFor();
      await window.getByText(/^This Update is logged on this Mac in .* Update\.txt$/).waitFor();
      await window.getByRole("button", { name: "Done" }).click();
      await window.getByText("Replica last updated today, on " + formatDay(new Date()) + ".").waitFor();
    } finally {
      await app.close();
      phase("close");
    }

    assert.equal(await readFile(join(replica, "Photos", "a.jpg"), "utf8"), "new photo");
    assert.equal(await readFile(join(replica, "readme.txt"), "utf8"), "changed!");
    assert.equal(await readFile(join(replica, "notes.txt"), "utf8"), "AAAA", "the content mismatch is overwritten, as chosen");
    assert.equal(await readdir(join(replica, "Photos")).then((names) => names.includes("scratch.tmp")), false, "the Exclusion is never copied");
    assert.equal(await readFile(join(replica, "sync-drive Holding Area", "old.txt"), "utf8"), "only here");
    assert.equal(await readdir(join(replica, "sync-drive Holding Area")).then((names) => names.includes("earlier.txt")), false);
    assert.deepEqual(await primarySnapshot(primary), primaryBefore);
    phase("checks");
  });
});

/**
 * Everything on the Primary but `.fseventsd`: macOS's own log of file changes, which macOS itself
 * writes on any drive mounted normally, as the Primary is again after the Update. sync-drive never
 * writes it, and every comparison skips it.
 */
async function primarySnapshot(primary: string): Promise<string[]> {
  return (await snapshotTree(primary)).filter((line) => !/^(dir |file) \.fseventsd(\/| )/.test(line));
}

/**
 * Reports, as a test diagnostic, how long each phase of the test took since the previous one
 * (#45), so a slow run on CI shows where the time went.
 */
function phaseTimer(t: { diagnostic(message: string): void }): (name: string) => void {
  let last = performance.now();
  return (name) => {
    const now = performance.now();
    t.diagnostic(`e2e phase: ${name} ${Math.round(now - last)} ms`);
    last = now;
  };
}
