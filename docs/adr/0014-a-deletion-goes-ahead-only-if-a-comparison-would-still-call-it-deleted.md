# A deletion goes ahead only if a comparison would still call it deleted

The Report's deleted files are judged at compare time, but the Update moves them into the Holding area later, at Apply. In between, a file can come back on the Primary: the owner restores it, or the Primary was only partly visible during the comparison and has since been reconnected. Before #48, the Update moved the Replica's copy into the Holding area anyway. That left the Replica missing a file the Primary has, and if the next Update's deletions were approved but its copies were not, the copy was deleted for good (ADR 0006). The owner settled how the Update checks this while building #48.

## The decision

- **Just before moving each deleted file into the Holding area, the Update checks its path on the Primary.** If a comparison run now would no longer call the file deleted, the Replica's copy is left where it is. It is listed as not moved into the Holding area, with the reason "it is on the Primary again since the comparison". The other approved deletions still go ahead.
- **Path alone decides, not size and date.** Anything at the path that isn't a folder stops the move, whether or not it matches the Replica's copy. That includes a file, a shortcut (even a broken one) or a special file. This is the cautious choice: the Update never moves a file the Primary has. A file that differs is left for the next comparison, which shows it as changed.
- **A folder at the path doesn't count.** A comparison only sees entries that aren't folders, so a Replica file stays deleted when the Primary has a folder of the same name (a file replaced by a folder). A Replica file can never mirror a Primary folder.
- **Nothing is at the path when a folder along it is missing or is now a file.** In that case the deletion goes ahead.
- **Any other error reading the Primary at that path leaves the file in place**, for example a folder that can't be read. The error is given as the reason. When the Primary can't be read, the Update never takes that as proof that a file is gone.

## Considered Options

- **Back only if it matches the Replica's copy by size and date:** this mirrors the re-check moves get (ADR 0011). But a file restored and then edited would still be moved, leaving the Replica without a file the Primary has.
- **Any entry at the path, folders included:** this would never move a Replica file that a folder of the same name replaced on the Primary. That breaks the swap from a file to a folder that the Report already lists as a deletion.

## Consequences

- Each deleted file costs one `lstat` on the Primary at Apply. It only reads, and the Primary is mounted read-only during the Update anyway (ADR 0013).
- Later work that changes what counts as deleted must keep this check matching the comparison: shortcuts and unreadable files (#10), and limiting a run to one folder (#15). The Update's check and the comparison must agree on what "on the Primary" means.
