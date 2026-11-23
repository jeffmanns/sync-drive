# sync-drive

A personal Mac app that compares an everyday external drive (the **Primary**) against its backup drive (the **Replica**), and brings the Replica up to date on approval. It never writes to the Primary. See `GLOSSARY.md` for the vocabulary and `docs/adr/` for the decisions behind it.

## Setup

Requires Node 24.22.1 or later (see `.nvmrc`; the app and the tests run on the Node bundled with Electron, ADR 0009) and `clang` (from the Xcode Command Line Tools: `xcode-select --install`), which builds the small native helper Update copies files with (see ADR 0005).

```sh
npm install
npm test      # typecheck, build, and run all tests on Electron's runtime (opens the app briefly)
```

## Launching it

```sh
npm start     # build and open the app
```

## The steps

**Pairing** (the first time only). Choose the top level of each drive (e.g. `/Volumes/Photos`). The app stores the **Pairing** in `~/Library/Application Support/sync-drive/pairing.json`. It recognises each drive by its **Volume ID** rather than its name, so renaming a drive does not matter. To pair other drives later, for example after replacing one, use **Re-pair…** on Start. Replacing a saved Pairing needs an extra confirmation.

**Start.** Shows the paired drives and the **Exclusions**: path patterns left out of every comparison on both drives, so what they match is never copied, moved or deleted (ADR 0016). They are saved beside the Pairing in `exclusions.json`. **Compare** finds the paired drives among those connected. It never asks for drive paths, so the roles can never be swapped. It refuses if a paired drive is not connected, or if two connected drives share a paired Volume ID.

**Comparing.** A **Quick compare** judges files equal by size and modification date. A file moved into another folder on the Primary is reported as a **Move** once a checksum confirms it is the same file. Comparing never writes to either drive. If the Replica already matches the Primary, the app says so on Start. Anything on the Primary it cannot read is listed and skipped, and its Replica copy is never treated as deleted (ADR 0015). A progress bar shows the items read out of the drives' item counts, which macOS gives at once. Those counts are only an estimate, so the bar stops short of 100% until the comparison is done. On a drive that keeps no count, such as FAT or exFAT, it is a moving bar. Confirming Moves by checksum has its own bar, by bytes read.

**Refusal screen** (only when needed). Comes before any Approval and says why:

- **The Safety stop applies:** the deleted files are more than 10% of the Replica, by count or by size, and more than 100 files (ADR 0008). The only way past it is to type the number of deletions, which holds for that one comparison.
- **The Replica lacks the free space for the copies.** This has no override.

**Copies, Moves, Deletions.** These are the review steps. Each one is grouped by folder, each folder expands to its files, and each step has its own all-or-nothing **Approval**. Nothing is approved until you approve it. Moves and Deletions are skipped when there is nothing in them. Deletions also warns when the **Holding area** still holds files from the previous Update, because approving the new deletions deletes those for good (ADR 0006). Back and Next keep the Approvals. **Start over**, a drive disconnecting or quitting discards them.

**Summary.** Says exactly what **Apply** will do: what it copies, renames and moves into the Holding area, what it permanently deletes from the previous Holding area, and what it leaves alone. Nothing is written before Apply.

**Updating.** Once Apply starts there is no going back. The app first remounts the Primary read-only and remounts it normally afterwards (ADR 0013). It then works in this order:

1. If the deletions are approved, it permanently deletes what the Holding area held from the previous Update, then moves the approved deletions into the visible `sync-drive Holding Area` folder on the Replica, keeping their folder paths. They stay there, not destroyed, until the next Update whose deletions are approved.
2. It renames the approved Moves on the Replica.
3. It copies the new and changed files, with a progress bar by bytes out of the approved total. Copies keep their modification and creation dates, Finder tags, other extended attributes, permissions and flags (ADR 0005), and each copy's checksum is checked against the Primary (ADR 0010). Each file is written under a temporary name in a hidden `.sync-drive-incoming` folder on the Replica and renamed into place when complete, so an interrupted Update never leaves a truncated file under a real name. The next Update clears anything left there.

Before moving a deleted file, the app checks again that a comparison would still call it deleted. A file that is back on the Primary stays on the Replica (ADR 0014).

**Result.** Lists what was copied, renamed and moved, and every file that was not, with the reason. **Done** goes back to Start.
