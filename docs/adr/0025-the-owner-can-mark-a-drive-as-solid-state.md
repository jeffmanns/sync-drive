# The owner can mark a drive as solid state when macOS cannot tell

ADR 0022 reads one file at a time from a drive whose kind macOS cannot tell. The real Replica, "Backup 1TB", is an SSD in a USB enclosure that does not report its kind: `diskutil info` says `Solid State: Info not available`. The Primary and the Replica are read together, so the Replica sets the pace for both. The #13 benchmark gave `Primary 8, Replica 1`, and Deep verify ran at about 35 MB/s per drive. #70 lets the owner fill in what macOS cannot tell. This adds to ADR 0022 and changes nothing it says about drives macOS can tell. The rules were chosen while building #70, and the owner reviews them in that PR.

## The decision

- **A Solid-state mark only fills in "unknown".** When macOS says a drive is solid state or spinning, that answer is used, and the mark is neither offered nor applied. So a wrong mark can never make a drive that macOS reports as spinning seek. A marked drive is read 8 files at once (`SOLID_STATE_READS`), as any SSD is.
- **Offered on Start, beside each paired drive whose kind macOS cannot tell,** as a checkbox, "This drive is an SSD: read several files at once", unticked at first. Above it, a note in the amber of the app's warnings says why it is offered: macOS couldn't tell whether the drive is an SSD or a spinning hard disk, so it is read one file at a time. It is not shown in red, as nothing is wrong. The owner can untick it again. A drive that is not connected is not offered it, because its kind cannot be asked.
- **Kept by Volume ID on the Mac, beside the Pairing, in `solid-state-marks.json`,** as the Exclusions are (ADR 0016). It survives quitting the app and Re-pairing the same drive, and it follows the drive when it is renamed. A mark counts only for a drive in the current Pairing. Marks on other drives stay in the file, unused, so a drive paired again later keeps its mark.
- **A missing or damaged file means no marks.** The app still compares, and saving a mark replaces the damaged file. This is the opposite of the Exclusions, where a damaged file stops the comparison (ADR 0016). Losing the Exclusions would offer to delete what they left out. Losing a mark only makes reading slower.
- **Applied in one place, `MarkedDriveKind`** (`src/engine/solid-state-marks.ts`). It wraps macOS's `DriveKind` and finds a drive's Volume ID from its mount point. Comparisons (#64), Updates (#65) and `scripts/benchmark.ts` are all given it. The benchmark's `Files read at once` line says which numbers come from a mark, e.g. `Replica 8 (marked as solid state)`.
- **Performance only, as ADR 0022 says.** A mark changes how many files are read or copied at once, never what a comparison finds or what an Update writes. Reports and Updates are the same with or without it. The mark writes nothing to either drive.

## Considered Options

- **Letting the mark override macOS's answer:** it could make a spinning drive that macOS reports correctly seek on every Deep verify, because of one wrong tick.
- **Keeping the mark in the Pairing file:** Re-pairing replaces that file, so the mark would be lost each time. A separate file also keeps a damaged mark from making the Pairing look damaged.
- **Treating every drive of unknown kind as solid state:** already rejected by ADR 0022.
- **A setting for how many files to read at once:** the owner would have to choose a number. A mark asks only what kind of drive it is, which the owner knows.

## Consequences

- Start asks macOS the kind of each connected paired drive when it opens and when drives change: about 0.1 s for a drive, and twice that for a disk image (ADR 0022). It does not wait to show Start, so the checkbox shows once the answer comes.
- Marking an SSD that is really spinning makes it seek, and is undone by unticking. Nothing found or written depends on it.
- After #70 is merged, the owner reruns the #13 benchmark with the Replica marked.
