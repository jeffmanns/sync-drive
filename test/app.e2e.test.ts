import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { _electron as electron } from "playwright-core";
import { pair, writePairing } from "../src/engine/index.ts";
import { MacVolumes } from "../src/macos/volume-identity.ts";
import { makeDiskImageTree, makeTree, removeTrees, snapshotTree } from "./helpers/trees.ts";

after(removeTrees);

const PROJECT = fileURLToPath(new URL("..", import.meta.url));

describe("the desktop app", () => {
  it("launches and runs an Update with copies and deletions from Start to Result", async () => {
    const primary = await makeDiskImageTree({ "Photos/a.jpg": "new photo", "readme.txt": "changed!" }, { name: "Smoke Primary" });
    const replica = await makeDiskImageTree(
      { "readme.txt": "old", "old.txt": "only here", "sync-drive Holding Area/earlier.txt": "held" },
      { name: "Smoke Replica" },
    );
    const pairingFile = join(await makeTree(), "pairing.json");
    await writePairing(pairingFile, await pair(primary, replica, new MacVolumes()));
    const primaryBefore = await primarySnapshot(primary);
    // Tests run with ELECTRON_RUN_AS_NODE; the app must not, or it would start as plain Node.
    const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;

    const app = await electron.launch({
      timeout: 30_000,
      // The tests run on Electron's own runtime, so this is the Electron the app runs on.
      executablePath: process.execPath,
      args: [PROJECT],
      env: { ...env, SYNC_DRIVE_PAIRING_FILE: pairingFile },
    });
    try {
      const window = await app.firstWindow();
      window.setDefaultTimeout(30_000);
      await window.getByText('"Smoke Primary"').waitFor();
      await window.getByRole("button", { name: "Compare" }).click();
      await window.getByRole("heading", { name: "Copies" }).waitFor({ timeout: 30_000 });
      assert.equal(await window.locator(".warning").count(), 0, "no Holding area warning before the copies Approval");
      await window.getByRole("button", { name: /Photos\// }).click();
      await window.getByText("a.jpg").waitFor();
      // The tick shows once the flow in the main process has the Approval, so wait for it.
      await window.getByLabel("Copy all 2 files").click();
      await window.locator("input[type=checkbox]:checked").waitFor();
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
      await window.getByText("Move 1 file (9 B) no longer on the Primary into the Holding area.").waitFor();
      await window.getByText("Permanently delete the 1 file (4 B) in the Holding area from an earlier Update.").waitFor();
      await window.getByRole("button", { name: "Apply" }).click();
      await window.getByRole("heading", { name: "Update done" }).waitFor({ timeout: 30_000 });
      await window.getByText("Copied: 2 files (17 B)").waitFor();
      await window.getByText("Moved into the Holding area: 1 file (9 B)").waitFor();
    } finally {
      await app.close();
    }

    assert.equal(await readFile(join(replica, "Photos", "a.jpg"), "utf8"), "new photo");
    assert.equal(await readFile(join(replica, "readme.txt"), "utf8"), "changed!");
    assert.equal(await readFile(join(replica, "sync-drive Holding Area", "old.txt"), "utf8"), "only here");
    assert.equal(await readdir(join(replica, "sync-drive Holding Area")).then((names) => names.includes("earlier.txt")), false);
    assert.deepEqual(await primarySnapshot(primary), primaryBefore);
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
