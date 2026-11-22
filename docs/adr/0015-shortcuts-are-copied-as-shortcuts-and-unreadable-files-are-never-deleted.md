# Shortcuts are copied as shortcuts, and what can't be read on the Primary is never deleted

The Primary can hold shortcuts (symbolic links), Finder aliases and special files, and some of it may not be readable (permissions, a failing drive). Before #10, a comparison stopped at the first folder it couldn't read, and an Update listed every shortcut as not copied (ADR 0005, ADR 0012). The owner approved these rules while building #10.

## The decision

- **A shortcut is copied as a shortcut, never followed.** `copy-with-metadata` copies the shortcut itself, with its target, dates, permissions and extended attributes (`COPYFILE_NOFOLLOW`, then `setattrlist` and `F_FULLFSYNC` on the link itself via `O_SYMLINK`). The Update checks the copy by reading both targets, not by checksum: a checksum would follow the shortcut. A broken shortcut is copied as it is.
- **A Quick compare also compares shortcuts' targets.** Two shortcuts are equal only if their kind, size and date match and they point to the same path. Then a retargeted shortcut is always caught, even when the new target has the same length and the date didn't change. Shortcuts are never move candidates.
- **A Finder alias is an ordinary file to sync-drive.** Its data and Finder info are copied byte for byte with the file, and it is never resolved.
- **Special files (named pipes, sockets, devices) are still not copied.** They hold no data to back up. Each is listed as not copied, with the reason.
- **What can't be read on the Primary is skipped and listed in the Report's `unreadable` list, and the comparison carries on.** It counts as unreadable when:
  - a folder can't be listed;
  - an entry can't be looked at (`lstat` or `readlink` fails);
  - a new or changed file can't be opened for reading (`access(R_OK)`);
  - a move candidate's Primary file fails to read while its checksum is taken.

  A file that matches its Replica copy is not checked, since nothing needs copying. Damage that only shows when a file's contents are read isn't seen by a Quick compare. It shows when the Update copies the file, and the Update lists the file as not copied. The top of the Primary, and anything on the Replica, still stops the comparison when it can't be read.
- **What the Replica holds at or under an unreadable path is never deleted.** It is kept out of the deletions and of the moves, and does not count towards the Safety stop. The same goes for every Replica file that looks like an unreadable Primary file moved (same name, size and date), even when more than one does: any of them may be that file's only backup.
- **The Update's check before each deletion (ADR 0014) matches this.** A deletion is also left in place when a folder along its path on the Primary can't be listed, even one that can be opened, where the path alone looks free. It is stricter than the comparison in one case only, and only on the safe side. A folder that can be listed but not opened (read permission without execute) shows the comparison its names but not their details. The comparison lists those entries as unreadable and calls the files missing from the listing deleted. The Update then leaves those deletions in place too, because it can't look inside that folder.
- **The app lists everything unreadable in full** on the Copies step, as a line on the Summary and on the Result. A comparison whose only finding is something unreadable still goes to the review, rather than saying the drives match.

## Considered Options

- **Checking every Primary file for read permission:** one more system call for every file on the drive, to report files the Replica already backs up unchanged.
- **Reading every file to find damage:** that is Deep verify's job, not Quick compare's.
- **Stopping the comparison at the first unreadable folder, as before:** one locked folder would block every other backup.
- **Comparing shortcuts by size and date only:** a shortcut retargeted to a path of the same length, with its date kept, would go unnoticed.

## Consequences

- Each new or changed regular file costs one `access` on the Primary at compare time, and each shortcut one `readlink`.
- Each approved deletion whose path on the Primary is gone costs one `lstat` and one `access` per folder along it at Apply.
- ADR 0012 still holds for the shortcuts this copies: an Update replaces or moves a Replica shortcut, but never writes through one.
