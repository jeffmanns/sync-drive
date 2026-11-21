# A Primary holding sync-drive's folder names stops the comparison

sync-drive keeps two folders of its own at the top level of the Replica: the Holding area (`sync-drive Holding Area`) and the Incoming folder (`.sync-drive-incoming`). Comparisons skip both on the Replica. If the Primary has a top-level item with either name, in any letter case (ADR 0002), the comparison stops with a message saying to rename it on the Primary. The owner settled this while building #5.

The likely way it happens is a restore done by dragging the whole Holding area onto the Primary, since its `READ ME.txt` says to restore by copying back to the Primary. So for that name the message suggests renaming the folder, e.g. to `Restored files`.

## Why not carry on

The Replica's side of these folders is always skipped, so a Primary folder with the same name would be compared against nothing:

- **Holding area:** its files show as new every time, never settle, and are copied into the Replica's real Holding area. There a copy can replace a file just moved in, or the Holding area's own `READ ME.txt`. The next Update with confirmed deletions (ADR 0006) then deletes those copies, and the files are no longer backed up, without any message.
- **Incoming folder:** a copied file is renamed into `.sync-drive-incoming` on the Replica, which the same Update then deletes, while the report says it was copied.

## Considered Options

- **Skip it on the Primary too:** those files would never be backed up, and nothing would say so.
- **Treat it as a normal folder:** the losses above.
- **Skip it but list it in the report as not backed up:** runs continue, but the files stay unprotected until the owner notices, and the report gains a section for a rare case.

## Consequences

- No comparison or Update runs until the item is renamed. The rename takes seconds and nothing is lost meanwhile.
- Any future folder sync-drive keeps on the Replica must be added to `src/engine/sync-drive-folders.ts`, so that it is both skipped on the Replica and refused on the Primary.
