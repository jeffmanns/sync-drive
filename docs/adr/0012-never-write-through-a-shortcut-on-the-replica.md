# An Update never writes through a shortcut folder on the Replica

An Update writes at Replica paths taken from the Report, and those paths were only checked as text. If a folder along one is a shortcut (symbolic link) on the Replica, `mkdir` and `rename` follow it, and the write lands wherever it points. sync-drive never made shortcuts, but a Replica first filled by Finder, rsync or another tool, or edited by hand, can have one where the Primary has a real folder. Two cases were reproduced in #36. In one, a copy silently overwrote the backup of a different file elsewhere on the Replica. In the other, a folder was made **on the Primary**. The owner settled the rule while building #36.

## The decision

- **No write at a Replica path goes through a shortcut.** Before creating folders, renaming a copy into place, moving a deleted file into the Holding area, or renaming a Move (at both its old and its new path), every folder along the path below the top of the Replica must be a real folder.
- **A file whose path goes through a shortcut fails on its own.** It is listed as not copied, not moved or not renamed, with a reason naming the shortcut, and nothing is written for it. The other files carry on. It is not a reason to refuse the whole Update.
- **Folders are made one level at a time**, never with `mkdir -p`, and a level that turns out to be a shortcut stops it. No folder is ever made through a shortcut, so none is made on the Primary or elsewhere on the Replica.
- **The last name in a path is not followed.** A rename moves or replaces a shortcut itself, not what it points to, so a shortcut there is treated like any other file. The rule applies to the folders above it.
- **A copy is checked before copying as well as before its rename**, so no time goes on a copy that could not be put in place.

## Considered Options

- **Following shortcuts that stay on the Replica.** Some would be safe, but the first case above shows that even such a write can overwrite a different file's backup unnoticed.
- **Refusing the whole Update.** One stray shortcut would block every other copy. The Report already shows the shortcut as deleted. Deletions run before copies, so approving them moves the shortcut into the Holding area and the copies go through in the same Update.
- **Relying on a read-only Primary (#14).** That would block the write to the Primary, but not the overwrite on the Replica.

## Consequences

- The checks and the write are separate steps, so a shortcut made on the Replica in the instant between them would not be caught. Nothing else writes to the Replica during an Update.
- When #10 copies shortcuts from the Primary to the Replica, they will be shortcuts on the Replica that sync-drive made. This rule still holds: an Update writes nothing through them, only replaces or moves the shortcuts themselves.
- Until the shortcut's deletion is approved, the files under that folder on the Primary are listed as not copied at every Update. The app shows each one with its reason.
