# sync-drive

A personal Mac tool that compares an everyday external drive against its backup drive, and brings the backup up to date on approval.

## Language

### Drives

**Primary**:
The everyday-use external drive; the source of truth. sync-drive only ever reads it, never writes to it.
_Avoid_: source, main drive, everyday drive

**Replica**:
The backup drive meant to be an exact copy of the Primary as of its last update; updated rarely (monthly to every six months).
_Avoid_: backup, target, destination, mirror

**Holding area**:
The visible `sync-drive Holding Area` folder at the top level of the Replica, where an Update moves files no longer on the Primary (after their own Approval), and the Replica's copies of content mismatches it overwrites, rather than destroying them. They keep their folder paths and stay until the next Update whose deletions are approved, which deletes them for good (ADR 0006). Its `READ ME.txt` says when it was last added to and how to restore a file (copy it back to the Primary). It is not part of the Replica's contents for comparison. Not the Incoming folder.
_Avoid_: trash, recycle bin, archive

**Incoming folder**:
The hidden `.sync-drive-incoming` folder at the top level of the Replica, where an Update writes each copy under a temporary name before renaming it into place. Anything left in it is an interrupted copy, never a file the user wants; the next Update empties it. It is not part of the Replica's contents for comparison. Not the Holding area: it never holds files deleted from the Primary.
_Avoid_: temp folder, staging area

**Last-updated marker**:
The hidden `.sync-drive-last-updated` file at the top level of the Replica that records when the last Update of the whole drive finished, and each folder updated on its own since (ADR 0019). Start shows it before comparing. It is not part of the Replica's contents for comparison.
_Avoid_: timestamp, sync marker

**Update log**:
The plain-text record of one Update, kept on the Mac in the `Update logs` folder beside the Pairing: what it copied, overwrote, renamed and moved into the Holding area, and what it did not, with the reasons (ADR 0019).
_Avoid_: history, report (a Report is a comparison's result)

**Pairing**:
The remembered designation of one specific volume as the Primary and another as the Replica, identified by each volume's **Volume ID** rather than its name.
_Avoid_: setup, profile, link

**Volume ID**:
The unique ID macOS gives each drive (shown as "Volume UUID" in Disk Utility and `diskutil info`). It never changes when a drive is renamed. Not the disk identifier (e.g. `disk4s1`), which can change each time a drive is connected.
_Avoid_: UUID, disk ID, serial

**Update**:
The approved act of making the Replica match the Primary: copying new and changed files, renaming Moves, and moving files no longer on the Primary into the Holding area.
_Avoid_: sync, backup, mirror run

**Safety stop**:
The check that refuses a whole Update, before anything is written, when the deleted files are more than 10% of the Replica (by file count or by size) and more than 100 files (ADR 0008). Only the owner's override for that run, given by typing the number of deletions, overrides it (ADR 0009). Every Report says whether it applies. Not the free-space check, which refuses an Update when the Replica lacks room for the copies.
_Avoid_: mass-deletion guard, threshold, limit

**Approval**:
The owner's all-or-nothing yes to one section of a Report: one for the new and changed files, one for the Moves, and one for the deletions (ADR 0011). It can be changed freely until the Update is applied, and it belongs to that Report only. The per-file choices on content-mismatch Anomalies are not Approvals.
_Avoid_: confirmation, consent, selection

### Comparing

**Report**:
The result of a comparison: every difference between the Primary and the Replica, grouped by kind and by folder, which the owner reviews before any Update. Making it never writes to either drive.
_Avoid_: diff, results, plan

**Move**:
A file moved or renamed into another folder on the Primary since the last Update, keeping its name: one file only on the Primary and one only on the Replica with the same name, size and modification date, and confirmed identical by checksum. An Update renames it on the Replica, with nothing copied and nothing sent to the Holding area (ADR 0011). Not the moving of deleted files into the Holding area.
_Avoid_: relocation, rename (for the Report section)

**Quick compare**:
A comparison that judges files equal by size and modification date alone (dates less than a hundredth of a second apart count as the same), without reading their contents. Two Shortcuts must also point to the same path (ADR 0015).
_Avoid_: fast scan, shallow compare

**Deep verify**:
An opt-in comparison that judges files equal by a checksum of their full contents, catching silent corruption on the Replica. It reads in full only the files a Quick compare would judge equal. The others differ already. Chosen on the Start screen.
_Avoid_: full scan, integrity check, hash compare

**Exclusion**:
A path pattern the user has chosen to leave out of every comparison, in addition to the macOS system files that are always skipped. What it matches is left out on both drives, so it is never copied, moved or deleted. Exclusions are edited in a list on the Start screen and saved beside the Pairing (ADR 0016).
_Avoid_: ignore rule, filter

**Folder limit**:
The one folder on the Primary that a comparison and its Update can be limited to, chosen on the Start screen. Nothing outside it is compared, copied, moved or deleted, and the Safety stop is measured against its contents. Files moved across its edge show as new or deleted rather than as Moves. It is kept in memory only, until changed or the app quits (ADR 0017). Not an Exclusion, which leaves a path out of every comparison.
_Avoid_: scope, partial sync, subset

**Shortcut**:
A symbolic link. sync-drive never follows one: it compares a shortcut by its target, size and date, and an Update copies it as a shortcut with the same target (ADR 0015). Not a Finder alias, which is an ordinary file to sync-drive and is copied byte for byte, never resolved.
_Avoid_: symlink, link (in what the owner reads)

**Unreadable**:
Something on the Primary that a comparison could not read: a folder it could not list, or a file it could not look at or open to copy. It is skipped and listed in the Report as unreadable, and what the Replica holds at or under its path is never treated as deleted (ADR 0015).
_Avoid_: corrupt, missing, failed

**Anomaly**:
A difference that should not occur if the Replica is only ever changed by updates. There are two kinds (ADR 0018). A Replica copy newer than its Primary counterpart is flagged in the Copies step, by every comparison, and the copies Approval still replaces it. A **Content mismatch** is found only by a Deep verify.
_Avoid_: conflict, error, warning

**Content mismatch**:
A file with the same size and modification date on both drives whose contents, read in full by a Deep verify, differ. It is also one whose Replica copy the drive could not read in full (EIO). It is left out of the Update until the owner chooses, for that file, to keep the Replica's copy or overwrite it with the Primary's. That choice is not an Approval (ADR 0018).
_Avoid_: corrupt file, hash mismatch, conflict
