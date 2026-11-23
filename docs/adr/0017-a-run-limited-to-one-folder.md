# A run limited to one folder

The owner can limit a comparison and its Update to one folder, chosen on the Start screen (ADR 0009 replaced ADR 0008's `--only` flag with this choice). Then the first real Updates touch only a small part of the drive. The owner approved these rules while building #15.

## The decision

- **Nothing outside the folder is compared, copied, moved, renamed or sent to the Holding area.** Paths in the Report stay relative to the top of the drive. A file moved across the folder's edge can't be recognised as a Move, so it shows as new or as deleted. The review steps, the Summary and the Result say so.
- **The Safety stop is measured against the folder's contents** on the Replica, by count and by size. The 100-file minimum still applies (ADR 0008).
- **The folder must be a real folder on the Primary.** It is chosen in a folder dialog that opens at the top of the Primary. The comparison is refused, before anything is scanned, when:
  - the folder is missing on the Primary, or isn't a folder there;
  - it or a folder above it is a shortcut, which a comparison of the whole drive would never follow (ADR 0015);
  - it or a folder above it can't be listed. A comparison of the whole drive would list that as unreadable and keep back what the Replica holds there, so a folder-limited comparison must not look inside it either. This also keeps the Update's check before each deletion (ADR 0014) in agreement with the comparison;
  - it is inside sync-drive's own folders or the macOS system folders, or the Exclusions leave it out (ADR 0016).
- **On the Replica, a missing folder means everything in it is new.** A shortcut, a file or a folder that can't be read at or above it on the Replica refuses the comparison.
- **The folder is found on each drive regardless of letter case**, the same way files are paired (ADR 0002). Each file is reported as it is stored on its own drive.
- **The choice is kept in memory only**, on Start, until the owner changes it, goes back to the whole drive, or quits. It is never saved, and Start shows it.
- **The Comparing bar is a moving bar.** macOS's item counts are for whole drives, so a percentage would be wrong.
- **The Update is held to the folder its Report was made for.** `update()` writes nothing if the Report holds a path outside it, mirroring how it is held to the Exclusions (ADR 0016).
- **At Apply, the deletions go ahead only if the Primary still has the folder as a real folder.** If it, or a folder above it, is now missing, a file or a shortcut, or can't be looked at, a folder-limited comparison would refuse rather than call anything deleted. So every deletion is left in place, with the reason, and the Holding area is left as it was. This keeps the Update's check before each deletion (ADR 0014) in agreement with the folder-limited comparison. Since the Primary then has the folder, removing emptied Replica folders after the deletions never goes above it.
- **A file moved out of the folder to where it can't be read on the Primary is not protected.** A whole-drive comparison keeps back every Replica file that looks like an unreadable Primary file (ADR 0015), since it may be that file's only backup. A folder-limited comparison never looks outside the folder, so it can't see that file, and lists the Replica's copy as deleted. The owner accepted this rather than scanning the whole Primary for every folder-limited run. Instead, the Deletions step warns that files moved out of the folder show as deleted, and that if any can't be read on the Primary, the deletions should wait for an Update of the whole drive.
- **Approving deletions still empties the whole Holding area (ADR 0006)**, including files held from other folders. The Deletions step and the Summary already say how many files that deletes for good.

## Considered Options

- **Emptying only the folder's part of the Holding area:** the Holding area would then hold files from Updates made at different times, and its `READ ME.txt` could no longer say when it was filled.
- **Saving the choice beside the Pairing:** a forgotten saved folder would quietly leave the rest of the drive without backups.
- **Scanning the whole Primary for every folder-limited run**, to find unreadable files that look like the folder's deleted files: this keeps ADR 0015's rule for files moved out of the folder, but reads the whole Primary every time, which is most of the cost a folder-limited run avoids.
- **Following a shortcut to reach the folder:** a comparison of the whole drive never does, so the two would disagree about what is on the drive.

## Consequences

- Choosing a folder costs one listing of each folder above it on both drives, and an Update with deletions one `lstat` per folder along its path on the Primary.
- ADR 0015's rule about lookalikes of unreadable files holds only inside the folder. Across its edge, the Deletions warning is the only safeguard.
- Deep verify will need the same `only` option, so that a folder-limited Deep verify agrees with a folder-limited Quick compare.
