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

/**
 * What a Hasher rejects with when it reads files only from the drive itself and cannot read this one
 * that way: macOS always reads a file stored compressed through memory (ADR 0021). The file may be
 * fine; it can only be checked as read through memory.
 */
export class NotReadableFromDriveError extends Error {
  override name = "NotReadableFromDriveError";
}

/** Read size for hashing: large reads keep a spinning or USB drive streaming. */
const CHUNK_BYTES = 1024 * 1024;

/** SHA-256 using Node's built-in crypto, which runs in native code. Checksums are lowercase hex. */
export class Sha256Hasher implements Hasher {
  checksum(path: string, onRead?: (bytes: number) => void): Promise<string> {
    return sha256(createReadStream(path, { highWaterMark: CHUNK_BYTES }), onRead);
  }
}

/**
 * The SHA-256 of everything `contents` yields, as lowercase hex, calling `onRead` with the size of
 * each part. Every Hasher hashes through this, so a checksum means the same thing whichever way the
 * file was read (ADR 0010).
 */
export async function sha256(contents: AsyncIterable<Buffer>, onRead?: (bytes: number) => void): Promise<string> {
  const hash = createHash("sha256");
  for await (const part of contents) {
    hash.update(part);
    onRead?.(part.length);
  }
  return hash.digest("hex");
}
