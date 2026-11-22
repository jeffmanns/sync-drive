# Copies are verified by SHA-256 before they are renamed into place

An Update must not count a file as copied until the copy is confirmed identical to the Primary's. The size and dates matching (ADR 0005) does not prove the contents match. So after each copy, Update reads the Primary file and the copy in full and compares their SHA-256 checksums. Only a match is renamed into place. A Shortcut is checked by reading both targets instead, as a checksum would follow it (ADR 0015, #10). A mismatch is discarded from the Incoming folder and listed as failed, so the Replica keeps its earlier version, if any. The owner settled this while building #7.

## The decision

- **SHA-256, through Node's built-in crypto.** On this Mac (Apple M4, Node v26) it hashes about 3.1 GB/s on one core, using the CPU's SHA instructions. That is faster than any external drive the tool reads, so hashing does not slow an Update. The disks do, as ADR 0001 expected.
- **Behind the `Hasher` interface** (`src/engine/hashing.ts`), as ADR 0001 requires. Update uses SHA-256 unless it is given another hasher. Deep verify (#31) uses the same interface and the same algorithm, so a checksum means the same thing everywhere.
- **The Primary is re-checked after hashing.** If its size or dates changed during the copy or the read-back, the file fails as "changed on the Primary", not as a checksum mismatch.
- **Only file contents are checksummed.** The metadata (dates, Finder tags, extended attributes, flags) is kept by the copy helper and checked by size and dates only.

## Known limitation

The copy has just been written, so reading it back almost certainly returns macOS's cached pages rather than the bytes on the Replica. The check reliably catches a copy that was written wrong. It does not yet catch bytes damaged on their way to the drive, for example by a bad cable or a failing drive. Making the read-back come from the drive itself is #33. Until then, Deep verify (#31) catches such damage later, because it reads the Replica long after the cache has moved on.

## Considered Options

- **Faster non-cryptographic hashes (xxHash, BLAKE3).** Node has neither built in, so they would add a native dependency. The drives, not SHA-256, limit speed.
- **BLAKE2 (built into Node).** It is no faster than hardware-accelerated SHA-256 here, and SHA-256 is the more widely known choice: a checksum can be checked with `shasum -a 256`.
- **SHA-512 or MD5.** Both are slower on this Mac (about 1.8 GB/s and 0.9 GB/s). MD5 is also broken, which matters if checksums are ever stored and trusted.
- **Trusting size and dates alone.** These are exactly what a corrupted copy can still match.

## Consequences

- Every copied file is read twice from the Primary (once to copy, once to hash) and once more from the Replica. Hashing while copying is left to performance work (#12).
- If checksums are ever stored, for example for Deep verify, changing the algorithm means recomputing or migrating them.
