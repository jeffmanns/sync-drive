# The Updating bar moves within each file

Before #55, the Updating bar (#29) moved only when a file's copy settled, by that file's size. A large file, such as a 20 GB video, left it still for minutes. #55 makes it move during each file's copy too. The owner chose the approach in triage: watch each copy's size as it grows, and count the read-back that checks it. The native copier is unchanged.

## Findings

On this Mac (Apple M4, macOS 15.7.9), copying a 2 GB file to an APFS disk image with `copy-with-metadata` (`copyfile(3)`, `COPYFILE_ALL`): the copy's size (`st_size`) grew steadily, by about 30–130 MB every 0.2 s. Its blocks (`st_blocks`) were reserved in full from the start. So the size is a usable measure of how far a copy has got, and the blocks are not.

## The decision

- **A copy under way is watched by its size only.** While the copier runs, `update()` looks at the size of the copy's temporary file in the Incoming folder (`lstat`) every 250 ms (`UpdateSetup.copySizeEveryMs`). It never opens or reads the copy: that would bring its pages into memory and make the read-back retry, and eventually fail the copy (ADR 0021). Nothing it finds changes what the Update does.
- **The read-back counts too,** through the copy hasher's `onRead`. Reading the Primary file side by side is not counted. If the copy is read through memory instead (ADR 0021), that read counts from the start again, and the bar waits until it passes where it had got to.
- **Each file under way counts half its size for its copy and half for its read-back,** each capped at its size as compared. A shortcut is checked without a read-back, so it counts only its copy until it settles.
- **`UpdateProgress.copies.copyingBytes` holds the files under way,** summed across the copies at once (ADR 0023). When a file settles, its share leaves `copyingBytes` and its whole size joins `copiedBytes` or `notCopiedBytes` in the same report. So the three together never go back, and they end at the approved total, with `copyingBytes` at 0.
- **The bar's label still counts only files copied and confirmed** ("Copied 1.0 MB of 8.0 MB"). Counting bytes under way would make the label go back whenever a file failed part-way.

## Considered Options

- **Having the copier report bytes copied** (`COPYFILE_STATE_STATUS_CB` in the native binary): more exact, but it changes the binary that writes to the Replica.
- **Counting the copy alone:** the read-back takes about as long as the copy, so the bar would stand still for half of each file.

## Consequences

- During a copy, the bar stands still while `F_FULLFSYNC` waits for the drive (ADR 0005), after the size has stopped growing and before the read-back starts.
- Progress is reported about once per 1 MiB read back, and every 250 ms while a copy grows. The Flow already sends the screens at most one state per interval (`throttleProgress`).
