# Deep verify reads only what a Quick compare calls equal, and content mismatches wait for a per-file choice

The owner can opt into a **Deep verify** on the Start screen. It catches damage on the Replica that sizes and dates do not show. The Report flags two kinds of **Anomaly**, and only content mismatches get per-file choices (ADR 0009). Building #31 left several questions open. These are the answers, made while building it. The owner reviews them in the PR.

## The decision

- **Deep verify is a Quick compare plus a checksum of every file the Quick compare calls equal.** Files whose size or date differ are already changed, and the copies Approval replaces them, so reading them would add nothing. Each file is read in full on both drives through the `Hasher` interface with SHA-256 (ADR 0010), one file at a time, with the Primary's and the Replica's copies read together. One at a time is safe on any drive but leaves an SSD partly idle. How many files to read at once, chosen per drive by whether it is solid state, is left to performance work (#12). Shortcuts are still compared by their targets and never followed (ADR 0015).
- **The same Exclusions and Folder limit apply.** Deep verify is `compare()` with `deep: true`, so it reads exactly the files a Quick compare with the same `exclusions` and `only` options compares (ADR 0016, ADR 0017). The app passes the same options to `update()`.
- **A content mismatch is in no other section of the Report.** It is not `changed`. The copies Approval never touches it. It waits for the owner's per-file choice on the Anomalies step: keep the Replica's copy, or overwrite it with the Primary's. With no choice, it is left alone. A choice is not an Approval: overwriting needs no copies Approval, and the choices are remembered across Back and Next, shown on the Summary, and discarded with the comparison, like Approvals.
- **Overwriting is a copy like any other.** `update()` takes the chosen paths as `approvals.overwrite` and copies each from the Primary like a changed file. The copy goes into the Incoming folder, is checked by checksum against the Primary, then is renamed over the Replica's copy. Just before that rename, the Primary file and the Replica copy must still match each other by size and date, as they did when compared. If either has changed, the choice was made about other contents, so the file is listed as not copied and the Replica copy is left as it is. Unlike a changed file, where the Primary wins whatever the Replica holds, the owner chose this overwrite after seeing one particular pair of files. A path that is not a content mismatch in the Report refuses the whole Update before anything is written. The free-space check counts the overwrites. It runs again at Apply, as before, because the comparison's free-space check is made before any choice.
- **A Primary file that cannot be read in full during Deep verify is unreadable** (ADR 0015). It is listed and skipped, and neither its Replica copy nor a Replica file that looks like it is ever treated as deleted. So Deep verify runs before deletions and moves are worked out.
- **A Replica copy the drive cannot read in full (EIO) is a content mismatch**, with the reason shown. It does not stop the comparison. **This changes ADR 0015** for that one error. ADR 0015 says anything on the Replica that can't be read stops the comparison. That still holds for listing folders, for looking at entries, and for every other failure to read a file's contents: a missing file, no permission, or a lost drive says nothing about the copy, and calling it a mismatch would make the Report wrong. A damaged Replica copy is exactly what Deep verify is for, and overwriting it from the Primary is how the owner repairs it.
- **A file whose checksums differ is looked at again.** If its size or date has changed since the scan on either drive, it is changed, not a content mismatch. An edit made while it was being read is not taken for damage.
- **Replica newer is flagged by every comparison, Quick or Deep.** It needs no reading: it is a changed file whose Replica date is later than the Primary's by more than the date tolerance (ADR 0002). It stays in `changed`, so the copies Approval replaces it and the Primary wins. Copies flags it.
- **The review steps are Copies, Anomalies, Moves, Deletions, Summary.** ADR 0009 put Anomalies between Copies and Deletions, and ADR 0011 then put Moves between them too. Anomalies come right after Copies because an overwrite is a copy: the owner decides everything that copies from the Primary before any rename or deletion. Anomalies is shown only when there is a content mismatch.
- **Progress:** the Comparing bar has three labelled stages with Deep verify: reading both drives, verifying contents by checksum (bytes read out of each file's size on both drives), then confirming moves.

## Considered Options

- **Checksumming every file, including those already changed:** reads more for no gain. Their copies are replaced anyway.
- **Putting content mismatches in `changed`:** the copies Approval would overwrite them silently, though one may be the only good copy if the Primary is the damaged one.
- **Stopping the comparison at an unreadable Replica copy:** one bad sector would block every Deep verify, and the app would offer no way to repair it.
- **Treating every failure to read a Replica copy as a content mismatch:** a Replica disconnected during a Deep verify would turn every remaining file into a mismatch.
- **Overwriting without looking at the two files again:** an edit made on either drive after comparing would be overwritten by a choice made about other contents.
- **Flagging Replica newer only in a Deep verify:** it costs nothing to find, so a Quick compare would hide it for no reason.
- **Anomalies after Moves:** this would put a decision about copying between the rename and deletion decisions.

## Consequences

- A Deep verify reads both drives in full, so it takes as long as reading the larger drive's data. Until #12, it reads one file at a time on any drive.
- Until #33, Deep verify is also what catches bytes damaged on their way to the Replica during an Update (ADR 0010).
- `checkFreeSpace` takes the files to copy, not a Report.
