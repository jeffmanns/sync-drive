# Copies are read back from the drive, not from memory

ADR 0010 checks every copy by SHA-256 before it is renamed into place, and records as a known limitation that the read-back "almost certainly" came from macOS's memory, not the Replica. Then the check could not catch bytes damaged on their way to the drive (a bad cable, a failing drive). #33 makes the read-back come from the drive itself. This ADR resolves ADR 0010's known limitation, records how, and records what was found on the way. The owner settled the approach in triage, and chose how to treat compressed files while it was built.

## Findings, from primary sources

XNU `xnu-12377.121.6` (commit `f6217f8`) and Apple's copyfile (commit `9f91eb6`):

- **`F_NOCACHE` alone does not keep a read out of memory.** [`bsd/kern/kern_descrip.c`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_descrip.c) (`F_NOCACHE`) only sets `FNOCACHE` on the open file. [`bsd/vfs/vfs_cluster.c`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/vfs/vfs_cluster.c) then lets a read go straight to the drive (`cluster_read_ext`, `cluster_read_direct`), but `cluster_read_direct` first looks for the pages in memory with `ubc_range_op(..., UPL_ROP_ABSENT, ...)`. Any that are there are served from memory, through the copy path.
- **`msync(MS_INVALIDATE)` drops a file's pages from memory.** [`bsd/kern/kern_mman.c`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_mman.c) (`msync_nocancel`) turns it into `VM_SYNC_INVALIDATE`, which [`osfmk/vm/vm_map.c`](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/vm/vm_map.c) (`vm_map_msync`) describes as "discard pages". With `MS_SYNC`, any page not yet on the drive is written there first.
- **`copyfile()` already writes uncached.** [`copyfile.c`](https://github.com/apple-oss-distributions/copyfile/blob/main/copyfile.c) (`copyfile`) sets `F_NOCACHE` on both files before copying the data. So a fresh copy usually has none of its pages in memory, and ADR 0010's read-back often did reach the drive. Nothing guaranteed it: any other app reading the new copy (Spotlight, for one) brings its pages into memory before the check reads it.
- **A file stored compressed (APFS/HFS+ compression, `UF_COMPRESSED`) is always read through memory.** [`bsd/kern/decmpfs.c`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/decmpfs.c) decompresses into the file's pages in memory (`cluster_copy_ubc_data`, `cluster_copy_upl_data`), whatever `F_NOCACHE` says, and `msync` does not drop those pages. `copyfile()` keeps a compressed file compressed on the copy.

Checked on this Mac (Apple M4, macOS 15.7.9) on APFS disk images, counting the bytes the disk image read (`iostat -I`), and the file's pages in memory (`mincore(2)` on a mapping of it):

| Read of a 50 MB file (47.69 MiB) | Read from the drive | Pages in memory after |
| --- | --- | --- |
| Fresh copy from `copy-with-metadata` | (none in memory before) | 0 of 3052 |
| `F_NOCACHE`, with its pages in memory (written by a plain `write`) | 0 MB | 3052 of 3052 |
| `msync(MS_SYNC \| MS_INVALIDATE)`, then `F_NOCACHE` | 47.69 MB, every time | 0 |
| A compressed copy, `F_NOCACHE` | 0 MB | all |

## The decision

- **The native helper reads the copy, and Node hashes it.** `copy-with-metadata --read-from-drive <file>` writes the file's contents to stdout, read from the drive. `MacUncachedHasher` (`src/macos/uncached-hasher.ts`) hashes that stream with the same SHA-256 code as `Sha256Hasher` (`sha256()` in `src/engine/hashing.ts`). So ADR 0010's "same algorithm, same code path" still holds.
- **Each 1 MiB part is checked to come from the drive.** In turn, each part's pages are dropped with `msync(MS_SYNC | MS_INVALIDATE)` and confirmed absent with `mincore`. The part is read with `F_NOCACHE` into a page-aligned buffer, which puts nothing in memory, then confirmed absent again. A page in memory before or after the read means another app read the file meanwhile, so the read may have come from memory. The part is then tried again, waiting a little longer before each try (up to 80 ms), and after 5 tries the copy fails and is discarded. The helper never hands on a part it could not show came from the drive.
- **Only the copy's side is read this way.** Update's `copyHasher` reads the copy and `primaryHasher` reads the Primary file, which keeps its ordinary read (`Sha256Hasher`). The app always passes `MacUncachedHasher` (it is required in the Flow's dependencies). `update()` falls back to `primaryHasher` when given none, so engine tests can use fakes. Deep verify (#31) keeps its ordinary read: it reads the Replica long after the copy.
- **A copy stored compressed is checked as read through memory, as before #33, and listed. Chosen by the owner.** The helper exits with status 3 for a `UF_COMPRESSED` file, and `MacUncachedHasher` rejects with `NotReadableFromDriveError`. `update()` then checks that copy with `primaryHasher` and lists it in `UpdateResult.checkedInMemory`. The Update log has a section for these files: "Checked as read through memory, not read back from the Replica, as stored compressed". A mismatch still fails the copy, as for any other file. The owner rarely has compressed files, and with this none is checked less well than before #33.
- **Shortcuts are still checked by comparing both targets** (`readlink`), never by checksum (ADR 0015).

## Considered Options

- **`F_NOCACHE` on the read alone:** returns pages already in memory, as above.
- **Writing the copy with `F_NOCACHE`, or dropping its pages after `F_FULLFSYNC`, in the copy step:** `copyfile()` already writes uncached, and dropping pages after the copy does not stop another app from reading them back in before the check. They have to be dropped, and shown absent, as the copy is read.
- **Hashing in the helper:** a second SHA-256 implementation, against ADR 0010's single code path.
- **Storing compressed files uncompressed on the Replica,** so they too could be read from the drive: it would cost space on the Replica and lose the "compressed" flag, which changes what ADR 0005's copy keeps. The owner chose the fallback above instead.
- **Reading a compressed file's resource fork from the drive:** it can be (measured), but small compressed files keep their data inside an extended attribute, which cannot be. It is complex and still has gaps.

## Consequences

- **What a read from the drive does not cover.** It reaches the drive, but the drive may answer from its own cache rather than its disk or flash, which macOS cannot bypass. `F_FULLFSYNC` (ADR 0005) has asked the drive to put the data on its disk or flash. Damage on the way to the drive, across the cable and its controller, is caught. A disk or flash area that fails to hold the data afterwards may only show in a later Deep verify. On a disk image, the "drive" is a file on the Mac, which macOS may itself hold in memory.
- **Time.** `node scripts/read-back-timing.ts <folder on a drive> [files] [MB per file]` measures the extra time per copy. On an APFS disk image on this Mac's internal SSD: about 25 ms extra per 50 MB copy (a plain read about 2,050 MB/s, the read from the drive about 1,000 MB/s), and about 1.2 ms extra per 1 MB copy. Reads from the drive get no read-ahead. The owner measures a real external drive in the PR.
- **A file that another app keeps reading during the check fails its copy,** with the reason given. The next Update copies it again.
- **The helper has two more modes,** `--read-from-drive` and `--pages-in-memory` (for tests and checks). Neither writes to the file.
