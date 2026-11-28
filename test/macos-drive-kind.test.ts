import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { MacDriveKind } from "../src/macos/drive-kind.ts";
import { makeDiskImageTree, makeTree, removeTrees } from "./helpers/trees.ts";

after(removeTrees);

describe("Drive kind on macOS", () => {
  it("tells whether the Mac's own disk is solid state", async () => {
    // Every Mac that runs sync-drive has a solid-state disk of its own, but a virtual Mac may not say.
    assert.notEqual(await new MacDriveKind().isSolidState("/"), false);
  });

  it("judges a disk image by the drive its image file is stored on, as that is the drive read", async () => {
    // Test disk images are stored in the Mac's temporary folder, on its own disk.
    const drive = await makeDiskImageTree();
    const kind = new MacDriveKind();

    assert.equal(await kind.isSolidState(drive), await kind.isSolidState("/"));
  });

  it("cannot tell for a folder that is not the top level of a drive", async () => {
    assert.equal(await new MacDriveKind().isSolidState(await makeTree()), undefined);
  });
});
