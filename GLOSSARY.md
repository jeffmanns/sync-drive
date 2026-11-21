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
The visible `sync-drive Holding Area` folder at the top level of the Replica, where an Update moves files no longer on the Primary (after their own confirmation) rather than destroying them. They keep their folder paths and stay until the next Update whose deletions are confirmed, which deletes them for good (ADR 0006). Its `READ ME.txt` says when it was filled and how to restore a file (copy it back to the Primary). It is not part of the Replica's contents for comparison. Not the Incoming folder.
_Avoid_: trash, recycle bin, archive

**Incoming folder**:
The hidden `.sync-drive-incoming` folder at the top level of the Replica, where an Update writes each copy under a temporary name before renaming it into place. Anything left in it is an interrupted copy, never a file the user wants; the next Update empties it. It is not part of the Replica's contents for comparison. Not the Holding area: it never holds files deleted from the Primary.
_Avoid_: temp folder, staging area

**Pairing**:
The remembered designation of one specific volume as the Primary and another as the Replica, identified by each volume's **Volume ID** rather than its name.
_Avoid_: setup, profile, link

**Volume ID**:
The unique ID macOS gives each drive (shown as "Volume UUID" in Disk Utility and `diskutil info`). It never changes when a drive is renamed. Not the disk identifier (e.g. `disk4s1`), which can change each time a drive is connected.
_Avoid_: UUID, disk ID, serial

**Update**:
The approved act of making the Replica match the Primary: copying new and changed files, and moving files no longer on the Primary into the Holding area.
_Avoid_: sync, backup, mirror run

**Safety stop**:
The check that refuses a whole Update, before anything is written, when the deleted files are more than 10% of the Replica (by file count or by size) and more than 100 files (ADR 0008). Only `--allow-mass-deletion`, given for that run, overrides it. Every Report says whether it applies. Not the free-space check, which refuses an Update when the Replica lacks room for the copies.
_Avoid_: mass-deletion guard, threshold, limit

### Comparing

**Quick compare**:
A comparison that judges files equal by size and modification date alone (dates less than a hundredth of a second apart count as the same), without reading their contents.
_Avoid_: fast scan, shallow compare

**Deep verify**:
An opt-in comparison that judges files equal by a checksum of their full contents, catching silent corruption on the Replica.
_Avoid_: full scan, integrity check, hash compare

**Exclusion**:
A path pattern the user has chosen to leave out of every comparison, in addition to the macOS system files that are always skipped.
_Avoid_: ignore rule, filter

**Anomaly**:
A difference that should not occur if the Replica is only ever changed by updates, such as a Replica copy newer than its Primary counterpart. Flagged in the report for the user's attention.
_Avoid_: conflict, error, warning
