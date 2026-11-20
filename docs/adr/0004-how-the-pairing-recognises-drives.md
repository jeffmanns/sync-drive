# How the Pairing recognises drives

These rules decide how sync-drive knows which connected drive is the Primary and which is the Replica. They were settled with the owner while building Pairing (#3, alongside ADR 0003). Later work that acts on the drives must keep them.

- **Drives are recognised by Volume ID alone, never by name.** Renaming a drive does not break recognition, and a different drive with the same name is not mistaken for a paired one. Names are stored only to make messages readable.
- **Two connected drives with the same paired Volume ID stop the run.** A block-level clone of a drive (as some backup tools make) carries the same Volume ID. Picking either one could compare or update the wrong drive, so sync-drive names both and asks for only the paired one to be connected.
- **The Pairing is stored on the Mac, not on either drive**, in `~/Library/Application Support/sync-drive/pairing.json`. The Primary is never written to, and a marker on the Replica could be copied or cloned along with it. The file is replaced only by a deliberate `pair --replace`. A damaged file is treated like an existing Pairing, so it is never silently overwritten.

## Consequences

- If a paired drive is replaced, or reformatted (which gives it a new Volume ID), the owner pairs again with `pair --replace`.
