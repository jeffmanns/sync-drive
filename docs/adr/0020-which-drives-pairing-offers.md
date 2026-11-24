# Which drives the guided Pairing offers, and when it saves

#20 replaces choosing each drive's top level with a guided Pairing step. It lists the connected drives, the owner picks the Primary, and the other drive becomes the Replica. ADR 0009 says this list holds "external drives and mounted disk images". The owner settled what that means while building #20 (2026-11-24). Later work that lists drives, or pairs them, must keep these rules. ADR 0004 still stands: drives are recognised by Volume ID alone, and Re-pair needs an extra confirmation.

## The decision

- **A drive is offered only if it is mounted in `/Volumes`,** where macOS mounts the drives and disk images connected to it. Volumes that macOS mounts out of sight are never offered, such as Xcode's simulator volumes under `/Library/Developer/CoreSimulator/Volumes`. Neither is anything at `/` or under `/System/Volumes`.
- **A drive is offered if diskutil reports it as not internal, or as both ejectable and on removable media.** Disk images and drives connected by USB or Thunderbolt are not internal. An SD card in the Mac's own reader is internal, but ejectable and removable, so it is offered. Fixed internal volumes never are: the Mac's own disk, its Data volume, a Boot Camp partition, or an extra APFS volume on the startup disk.
- **Pairing goes ahead only with exactly two drives offered, with different Volume IDs.** With none, one, or more than two, the step says what to do and offers no choice. With more than two, it names every drive so the owner knows which to eject, for example an installer's disk image. Two drives sharing a Volume ID (a block-level clone) cannot be told apart, so neither is paired. The list is read again whenever `/Volumes` changes, and when the owner clicks **Look again**.
- **Read-only drives are offered, but never saved as the Replica.** sync-drive only reads the Primary, so a read-only Primary is fine. A Replica that cannot be written to could never be updated. If the owner picks the other drive as the Primary, the summary says why, and **Save Pairing** stays off.
- **Nothing is saved until the owner confirms the summary,** which names the Primary and the Replica with their Volume IDs. Save reads the list again first. If the two drives are no longer the only ones offered, or no longer the same two, it saves nothing and asks the owner to pick again. If the drives change while the summary is shown, it is kept only while it still pairs the same two drives in the same roles. A different drive is never quietly put in as the Replica.

## Considered Options

- **Only drives diskutil reports as not internal:** would leave out an SD card in the Mac's own reader, and drives in some hot-plug bays.
- **Any mounted volume other than `/` and `/System/Volumes/…`:** would offer Xcode's simulator volumes and other hidden mounts. On a developer's Mac, Pairing would then often say "more than two drives are connected".
- **Hiding read-only drives:** would hide a legitimate read-only Primary, and the owner would not see why a connected drive is missing.
- **Letting the owner pick both the Primary and the Replica from a longer list:** more clicks, and with more than two drives connected, more chances to pick the wrong one. Asking for exactly two makes the choice a single, clear one.

## Consequences

- `VolumeIdentity.candidates()` lists the drives that could be paired, each with its size and whether it can be written to. The macOS rules live in `couldBePaired()` in `src/macos/volume-identity.ts`, and the test fake offers every drive it has connected.
- The path-based `pair()` is gone. `pairDrives()` pairs two drives as listed.
- The rehearsal kit (#16) must mount its disk images in `/Volumes`, as `hdiutil attach` does by default, or Pairing will not offer them.
