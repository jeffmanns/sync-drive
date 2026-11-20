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
A folder on the Replica where files deleted from the Primary are kept until the following update, rather than being destroyed. It is not part of the Replica's contents for comparison.
_Avoid_: trash, recycle bin, archive

**Pairing**:
The remembered designation of one specific volume as the Primary and another as the Replica, identified by each volume's unique ID rather than its name.
_Avoid_: setup, profile, link

**Update**:
The approved act of making the Replica match the Primary: copying new and changed files, and moving files no longer on the Primary into the Holding area.
_Avoid_: sync, backup, mirror run

### Comparing

**Quick compare**:
A comparison that judges files equal by size and modification date alone, without reading their contents.
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
