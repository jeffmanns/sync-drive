# Several files copied at once, each drive held to how many it reads at once

ADR 0022 chose how many files are read at once from each drive, and left Update (#65) to use the same choice. This ADR records how an Update uses it. It widens what ADR 0022's numbers limit: there they are files read at once from a drive; in an Update they are files copied to or read from it at once, so they hold writes as well as reads. It was decided while building #65, and the owner reviews it in the PR.

## The decision

- **An Update copies as many files at once as the faster drive reads at once.** `readsAtOnce` chooses for each drive (8 for a solid-state drive, 1 for a spinning drive or one whose kind cannot be told), and `readLimiter` holds each drive to its number, as in a comparison (ADR 0022). Each file is copied, its copy read back from the Replica and checked (ADR 0021), and renamed into place, as before. Without a `driveKind` (the engine tests, unless they give one) one file is copied at a time, as before #65.
- **A copy counts on both drives.** The copy helper reads the Primary file and writes the Replica, so while it runs it counts as one of the files at once on each drive. It is counted on the Primary first, then waits its turn on the Replica. Nothing counted on the Replica ever waits for the Primary, so two copies can never each wait for the other. Checking a copy reads the Primary file under the Primary's limit and the copy under the Replica's, side by side. So a spinning Replica is written to or read from one file at a time, even beside a solid-state Primary.
- **The result is what copying one at a time gives.** What happened to each file is listed in `copied`, `checkedInMemory` and `failed` in the Report's order, however the copies finished. So the Update log and the last-updated marker's `leftUndone` come out the same. A file whose path (ignoring letter case, as files are paired) is already being copied waits for that copy to settle, and is not started if the Update stopped meanwhile, so a Report naming a path twice gives the same result as before.
- **Quitting starts no new copy.** Once the app is quitting, the Flow's copier rejects every copy not yet started, as before (ADR 0013). `update()` resolves only once every copy under way has settled, so the Primary is never remounted normally while a copy is still reading it.
- **The Holding area's `READ ME.txt` is written once,** though several content mismatches may be moved into it at once (ADR 0018). It is written before the Replica's copy is moved in, so an overwrite that cannot write it changes nothing, as ADR 0018 requires. Before #65 it was written after the move, and a failure left the Replica's copy in the Holding area.
- **The Updating bar moves when a copy settles,** by that file's size, as before. Copies settle in any order, so it never goes back and ends at the approved total (#29).

## Measurement

`node scripts/update-timing.ts <folder on a drive> [files] [MB per file] [rounds]` updates a new folder on a drive from files on the Mac, once one at a time and once as chosen, and times both. On an APFS disk image on the internal SSD of an Apple M4 Mac (macOS 15.7.9), 8 files at once on each side, two rounds each:

| Files | One at a time | 8 at once |
| --- | --- | --- |
| 200 of 5 MB | 11.7 s, 12.1 s (about 84 MB/s) | 9.7 s, 8.0 s (104–125 MB/s) |
| 2,000 of 0.1 MB | 28.9 s, 28.7 s (7 MB/s) | 10.5 s, 10.5 s (19 MB/s) |

Small files gain most: each copy waits for its `F_FULLFSYNC` (ADR 0005), and those waits now overlap. No spinning drive was connected while #65 was built, so the one-at-a-time choice for one has not been measured in an Update.

## Considered Options

- **Hashing the Primary file while copying it:** still open (ADR 0021 rules out only hashing the copy that way). Copies in flight already keep the Primary busy, so it was left for later.
- **Running the copy helper once for many files:** out of scope (#65); worth a follow-up only if a measurement shows the per-copy start-up matters.
- **Counting a copy on the Replica alone:** a spinning Primary would then be read for several copies at once and made to seek.

## Consequences

- An Update asks macOS about both drives' kinds once, while it deals with the deletions and moves (about 0.1–0.2 s, ADR 0022).
- Up to 8 temporary copies can sit in the Incoming folder at once. Each is removed if it fails, and the folder is removed when the Update ends, as before.
