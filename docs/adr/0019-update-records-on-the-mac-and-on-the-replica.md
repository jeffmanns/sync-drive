# What an Update records: a log on the Mac, and a last-updated marker on the Replica

#11 asks for a log of each Update on the Mac and a marker on the Replica saying when it was last updated, which Start shows before comparing. ADR 0017 left one question for this ticket: an Update limited to one folder does not bring the whole Replica up to date, so the marker must not suggest it does. These are the answers, made while building #11. The owner reviews them in the PR.

## The decision

- **The last-updated marker is a hidden file, `.sync-drive-last-updated`, at the top level of the Replica.** It is plain JSON. Like the Holding area and the Incoming folder, comparisons skip it on the Replica, and a Primary holding an item with its name, in any letter case, stops the comparison (ADR 0007). Otherwise an Update would copy the Primary's item over the marker.
- **An Update limited to one folder is recorded apart from the whole drive.** The marker holds the date of the last Update of the whole drive, and, for each folder updated on its own since, the date of the last Update of that folder. An Update of the whole drive clears that list. Start says "Replica last updated 3 months ago, on 20 August 2026", then lists each folder updated since, as "only the folder" updated. When the whole drive has never been updated, Start says so. A folder-limited Update never moves the whole drive's date.
- **Only an Update that finishes is recorded.** The marker is the last thing `update()` writes. An Update that stops partway, or is refused before writing, leaves the marker as it was. An Update that finished with some files not copied, moved or renamed is still recorded: the Result and the log list each of those with its reason. A comparison that finds nothing to update is not an Update, and records nothing.
- **The marker is written under a temporary name in the Incoming folder and renamed into place,** so a half-written marker is never left behind. If it cannot be written, the Update ends with that error, having done everything else.
- **A damaged marker does not stop anything.** Start says it is damaged, comparing works as usual, and the next Update replaces it. A folder-limited Update that replaces it records only its folder, so the whole drive's date is then unknown rather than wrong.
- **Each Update is logged on the Mac in a new plain-text file** in an `Update logs` folder beside the Pairing (`~/Library/Application Support/sync-drive/Update logs/`), named by when it ended: `2026-11-24 10.30.05 Update.txt`. A log never replaces an earlier one. It records the drives, the Folder limit, Quick compare or Deep verify, and then what the Result shows: the files copied, the content mismatches overwritten, and those left as they are with the reason (kept as chosen, or no choice made), the Moves renamed (old path → new path), the files moved into the Holding area, what was deleted for good from the Holding area, every file not copied, renamed or moved with its reason, and what was unreadable on the Primary. An Update that stopped partway is logged too, with why it stopped. If the log cannot be written, the Result says so; the Update itself is not affected.
- **The Result reads the Holding area again after the Update** and shows what it holds, which may include files from an earlier Update (ADR 0006), and the day it was last added to, as its `READ ME.txt` gives it. Then it reminds the owner how to restore a file. `update()` reports whether it emptied the Holding area, so the log says what was deleted for good only when it was.

## Considered Options

- **A folder-limited Update leaves the marker alone:** simpler, but Start would then say nothing about Updates the owner did make. An owner working through the drive folder by folder would see only an old date.
- **A folder-limited Update moves the marker's date:** Start would then call a Replica up to date when most of it was not.
- **Recording every Update, even one that stopped:** the marker would then say "updated today" after an Update that was cut short.
- **The marker in the Holding area's `READ ME.txt`:** the Holding area is emptied and rewritten only by Updates with deletions, so it would often be out of date.
- **Logs in `~/Library/Logs`:** Console would show them, but keeping them beside the Pairing puts everything sync-drive keeps on the Mac in one folder, and the tests can point it elsewhere with the Pairing.

## Consequences

- `UpdateResult` has `emptiedHoldingArea`.
- `readHoldingArea()` also gives the day in the `READ ME.txt`, from the wording before and after ADR 0018.
- A Replica updated before #11 shows as never updated as a whole until its next Update of the whole drive.
