import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readLimiter, readsAtOnce, type DriveKind } from "../src/engine/index.ts";

/** A DriveKind that says what `kinds` gives for each mount point, and rejects for any other. */
function driveKinds(kinds: Record<string, boolean | undefined>): DriveKind {
  return {
    async isSolidState(mountPoint) {
      if (!(mountPoint in kinds)) throw new Error(`no such drive ${mountPoint}`);
      return kinds[mountPoint];
    },
  };
}

describe("How many files are read at once from a drive", () => {
  const kinds = driveKinds({ "/Volumes/SSD": true, "/Volumes/Spinning": false, "/Volumes/Unknown": undefined });

  it("reads several files at once from a solid-state drive", async () => {
    assert.equal(await readsAtOnce(kinds, "/Volumes/SSD"), 8);
  });

  it("reads one file at a time from a spinning drive, so it is not made to seek", async () => {
    assert.equal(await readsAtOnce(kinds, "/Volumes/Spinning"), 1);
  });

  it("reads one file at a time from a drive whose kind is unknown or cannot be told, or without a way to tell", async () => {
    assert.equal(await readsAtOnce(kinds, "/Volumes/Unknown"), 1);
    assert.equal(await readsAtOnce(kinds, "/Volumes/Gone"), 1);
    assert.equal(await readsAtOnce(undefined, "/Volumes/SSD"), 1);
  });
});

describe("Read limiter", () => {
  it("runs no more than its limit at once, starting them in the order given, and gives each its own result", async () => {
    const limit = readLimiter(2);
    let running = 0;
    let most = 0;
    const started: number[] = [];
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((n) =>
        limit(async () => {
          started.push(n);
          running++;
          most = Math.max(most, running);
          await new Promise((resolve) => setTimeout(resolve, 5 - n));
          running--;
          return n * 10;
        }),
      ),
    );
    assert.deepEqual(results, [0, 10, 20, 30, 40]);
    assert.deepEqual(started, [0, 1, 2, 3, 4]);
    assert.equal(most, 2);
  });

  it("passes on a task's rejection and goes on to the next", async () => {
    const limit = readLimiter(1);
    const failed = limit(async () => {
      throw new Error("could not read");
    });
    const next = limit(async () => "read");
    await assert.rejects(failed, /could not read/);
    assert.equal(await next, "read");
  });
});
