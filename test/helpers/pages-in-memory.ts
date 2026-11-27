import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HELPER, helperFailure } from "../../src/macos/helper.ts";

const run = promisify(execFile);

/**
 * How many of the regular file at `path`'s pages are in memory, and how many it has, from the
 * native helper's `--pages-in-memory` mode (ADR 0021). Reads nothing.
 */
export async function pagesInMemory(path: string): Promise<{ resident: number; total: number }> {
  try {
    const { stdout } = await run(HELPER, ["--pages-in-memory", path]);
    const [resident, total] = stdout.trim().split(" ").map(Number);
    return { resident: resident!, total: total! };
  } catch (error) {
    throw await helperFailure(error);
  }
}
