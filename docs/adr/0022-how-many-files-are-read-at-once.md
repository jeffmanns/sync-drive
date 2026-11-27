# How many files are read at once, chosen per drive by whether it is solid state

ADR 0018 had Deep verify read one file at a time, and ADR 0011 had moves confirmed one candidate at a time. Both left the choice of how many to read at once to performance work. #64 makes that choice. It was made while building #64, and the owner reviews it in the PR.

## The decision

- **A solid-state drive has 8 files read at once. A spinning drive has 1.** An SSD reads several places as fast as one, so it is kept busy. A spinning drive would have to seek between files, so it reads them one after another. `readsAtOnce` in `src/engine/reads-at-once.ts` makes the choice, for each drive on its own. A Primary on an SSD paired with a spinning Replica reads 8 files at once from the Primary and 1 from the Replica. `readLimiter` holds each drive to its number. Both are exported so Update (#65) can use them.
- **A drive whose kind cannot be told has 1 file read at a time.** That is safe on any drive. A spinning drive is never made to seek because it did not say what it is.
- **macOS says whether a drive is solid state** (`diskutil info`, "Solid State"). This goes through the `DriveKind` interface, which tests replace with a fake. It is never used to decide what a comparison finds.
- **A disk image counts as the kind of drive its image file is stored on.** macOS gives a disk image no kind of its own ("Info not available"). Reading from it reads its image file, so the drive holding that file is what matters. `MacDriveKind` finds the image file with `hdiutil info` and the drive it is on with `df`. It follows images stored inside other images, up to 4 levels deep. The rehearsal drives are disk images on the Mac's own SSD, so they read 8 files at once.
- **8, from measurement.** `scripts/benchmark.ts` was run on two APFS disk images on the Mac's own SSD, with 1.3 GB on each. Deep verify's "Verifying contents" phase read about 1.0 GB/s one at a time, 1.2 GB/s with 2 at once, 1.4 GB/s with 4 or 8, and about 1.5 GB/s with 16 or 32. Gains flatten after 4 to 8: SHA-256 runs in one thread, and Node reads files with a small, fixed set of threads. 8 is near the top without keeping many more files open. No spinning drive was connected while #64 was built, so the setting for spinning drives has not been measured on one.
- **The Report is exactly what reading one file at a time gives.** Each file's result is taken in the order the files were listed, however the reads finished. When a Replica copy cannot be read for any reason but damage (ADR 0018), no further files are started. The comparison waits for the files already being read, then stops with the first such copy in that order. The bytes-read bars count each file's bytes up to its size, and all of them once it is done, so they never go back and end at their totals (#29).
- **Both drives are listed at the same time, as they already were.** A Folder limit's folder is also found on both drives at once (ADR 0017). When it cannot be found on either, the Primary's reason is the one given, as before.

## Considered Options

- **The same number for every drive:** it either leaves an SSD idle or makes a spinning drive seek.
- **Treating a drive of unknown kind as solid state:** a spinning drive that does not say what it is would be made to seek on every Deep verify.
- **Judging a disk image by its own "Solid State" entry:** it never has one, so every rehearsal would read one file at a time and look slower than a real SSD would.
- **Limiting pairs of files, not reads per drive:** a fast Primary paired with a spinning Replica would have to read at the spinning drive's pace, or the spinning drive would be made to seek.

## Consequences

- Asking macOS takes about 0.1 s for a drive, and about 0.2 s for a disk image (two `diskutil` calls). A Deep verify asks while the drives are listed, and its first read waits for the answer. A Quick compare asks only when it has moves to confirm. On the 1.3 GB disk images, listing both drives took 0.07 s, so the wait showed: "Reading both drives" went from 0.07 s to 0.25 s in the benchmark. It is a fixed cost per comparison, while listing a real drive takes far longer, but that has not been measured on a real drive.
- A comparison without a `driveKind` (the tests, unless they give one) reads one file at a time, as before #64.
