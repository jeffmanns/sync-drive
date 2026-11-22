# The Primary is remounted read-only for each Update

The Primary is never written to, and until now only sync-drive's own code kept that promise. A bug, or a shortcut followed by mistake, could still write to it (#36 made a folder on the Primary that way). #14 has macOS enforce the promise: each Update remounts the Primary read-only first, and normally again afterwards. These rules were chosen while building #14, and the owner reviews them in its PR.

## The decision

- **Remounted with `diskutil`: unmount, then `diskutil mount readOnly`.** No administrator rights are needed. macOS cannot switch an APFS drive to read-only in place (`mount -u -r` fails), so the drive is briefly unmounted. It stays at the same mount point. If the old folder is gone, as it is in /Volumes, macOS puts the drive back in the same place itself. The flow reads the Primary wherever it is now mounted.
- **Only macOS's own word confirms it.** `diskutil mount readOnly` exits successfully even when it leaves a drive writable (for example, when it is already mounted), so the Update starts only once `diskutil info` reports `WritableVolume` false for the drive with the paired Volume ID. Anything else counts as not confirmed.
- **The Update refuses to start if the remount fails or is not confirmed.** Nothing is written, the Primary is put back mounted normally where possible (the reason says if it could not be), and the app returns to Start with the reason. Like any other refusal at Apply, the comparison and its decisions are discarded.
- **A writable Primary is never forced off.** If an app has a file open on it, a forced unmount could lose that app's unsaved writes. The unmount is retried a few times, because Spotlight or fseventsd can hold a drive for a moment, and then the Update is refused with what macOS said, which often names the process using the drive.
- **A Primary confirmed read-only may be forced off** to remount it normally. Nothing written to a read-only drive can be lost, and sync-drive's own copies may still have files open on it.
- **It is remounted normally however the Update ends:** done, stopped partway, or the app quitting during it. On quitting, the Update is stopped first (no new copy starts; the one under way finishes, and the rest are listed as not copied), then the Primary is remounted, then the app quits. The Primary is never writable again while the Update still runs.
- **A Primary that was already read-only before the Update is left read-only** afterwards: that was the owner's choice, not sync-drive's. If that remount fails, the Result says the Primary may still be read-only, and that ejecting and reconnecting it fixes this.
- **The Updating screen says what is happening to the Primary**, including that it may briefly disappear from the Finder.

## Considered Options

- **`mount -u -r` (in place, no unmount):** refused by macOS for an APFS volume mounted by the user (tried on macOS 15 without administrator rights).
- **Running the remount as an administrator:** not needed, and it would mean asking for a password at every Update.
- **Remounting at the start of the app, not of each Update:** the owner uses the Primary every day, and comparing does not write to it.

## Consequences

- **If the app crashes or is force-quit during an Update, the Primary stays read-only** until it is ejected and connected again, or the Mac restarts. That is safe for the data: nothing can write to it meanwhile.
- **macOS itself writes its file-event log, `.fseventsd`, to the Primary** whenever the Primary is mounted normally, as it is again after each Update, and as it is whenever the drive is connected. sync-drive never writes it, and every comparison skips it (always-skipped system files).
- An app or Terminal window using the Primary blocks the Update until it is closed.
- The rehearsal kit (#16) checks the remount on disk images mounted in /Volumes, as real drives are.
