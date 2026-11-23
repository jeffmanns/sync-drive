import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * Computes a checksum of a file's full contents. The engine reaches hashing only through this
 * interface, so it can be swapped for a native module if hashing turns out to be the bottleneck
 * on the real drives (ADR 0001).
 */
export interface Hasher {
  /**
   * Reads the regular file at `path` from start to end and resolves to a checksum of its
   * contents. Files with different contents have different checksums, barring a collision
   * too unlikely to matter. Calls `onRead`, if given, with the number of bytes in each part read,
   * for progress. Never writes to `path`.
   */
  checksum(path: string, onRead?: (bytes: number) => void): Promise<string>;
}

/** Read size for hashing: large reads keep a spinning or USB drive streaming. */
const CHUNK_BYTES = 1024 * 1024;

/** SHA-256 using Node's built-in crypto, which runs in native code. Checksums are lowercase hex. */
export class Sha256Hasher implements Hasher {
  async checksum(path: string, onRead?: (bytes: number) => void): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { highWaterMark: CHUNK_BYTES })) {
      hash.update(chunk as Buffer);
      onRead?.((chunk as Buffer).length);
    }
    return hash.digest("hex");
  }
}
