import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { NotReadableFromDriveError, sha256, type Hasher } from "../engine/index.ts";
import { HELPER, helperFailure } from "./helper.ts";

const run = promisify(execFile);

/** The helper's exit status for a file stored compressed, which it cannot read from the drive itself. */
const STORED_COMPRESSED = 3;

/**
 * SHA-256 of a file read from the drive itself, never from the copies of its pages macOS keeps in
 * memory. Update checks each copy with it, so a copy damaged on its way to the drive (a bad cable, a
 * failing drive) is caught before it is renamed into place: a copy just written would otherwise be
 * read back from memory. The native helper does the reading, as only it can drop the file's pages
 * from memory and confirm they stayed out; the hashing is the same as `Sha256Hasher`'s (ADR 0021).
 * Rejects with `NotReadableFromDriveError` for a file stored compressed, which macOS always reads
 * through memory. Never follows a shortcut, and never writes to the file.
 */
export class MacUncachedHasher implements Hasher {
  async checksum(path: string, onRead?: (bytes: number) => void): Promise<string> {
    const reader = spawn(HELPER, ["--read-from-drive", path], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    reader.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text));
    const exited = new Promise<void>((resolve, reject) => {
      reader.on("error", reject);
      reader.on("close", (code, signal) => {
        if (code === 0) resolve();
        else reject(Object.assign(new Error(`the read-back stopped (${signal ?? `exit status ${code}`})`), { code }));
      });
    });
    // A partial stream is never a checksum: only a helper that read the whole file and exited cleanly counts.
    const [sum] = await Promise.all([sha256(reader.stdout, onRead), exited]).catch(async (error: unknown) => {
      reader.kill();
      await exited.catch(() => undefined);
      if ((error as { code?: unknown }).code === STORED_COMPRESSED) throw new NotReadableFromDriveError(stderr.trim());
      throw await helperFailure(error, stderr);
    });
    return sum;
  }
}

/** How many of the regular file at `path`'s pages are in memory, and how many it has. Reads nothing. */
export async function pagesInMemory(path: string): Promise<{ resident: number; total: number }> {
  try {
    const { stdout } = await run(HELPER, ["--pages-in-memory", path]);
    const [resident, total] = stdout.trim().split(" ").map(Number);
    return { resident: resident!, total: total! };
  } catch (error) {
    throw await helperFailure(error, (error as { stderr?: string }).stderr);
  }
}
