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

## Rehearsing on fake drives

Before the first run on real drives, rehearse the whole workflow on two disk images that macOS mounts like external drives. The rehearsal keeps its own Pairing, Exclusions and Update logs, apart from the real ones. See `docs/rehearsal.md` for the walkthrough.

```sh
npm run rehearsal:create <folder>   # make the fake drives, and copy <folder> onto the fake Primary (it is only read)
npm run rehearsal:app               # open the app for the rehearsal
npm run rehearsal:remove            # eject the fake drives and delete everything the rehearsal made
```

## The steps

**Pairing** (the first time only). Connect the Primary and the Replica, and no other drive. The app lists the external and removable drives and disk images mounted in `/Volumes`, with each one's name, Volume ID and size, but never the Mac's own disk or its system volumes (ADR 0020). It waits, saying what to do, until exactly two are connected. Pick which one is the Primary: the other becomes the Replica, which must be a drive that can be written to. The app shows the Pairing to save, and saves it only when you click **Save Pairing**. The app stores the **Pairing** in `~/Library/Application Support/sync-drive/pairing.json`. It recognises each drive by its **Volume ID** rather than its name, so renaming a drive does not matter. To pair other drives later, for example after replacing one, use **Re-pair…** on Start. Replacing a saved Pairing needs an extra confirmation.

**Start.** Shows the paired drives, how long ago the Replica was last updated (and any folder updated on its own since), and the **Exclusions**: path patterns left out of every comparison on both drives, so what they match is never copied, moved or deleted (ADR 0016). They are saved beside the Pairing in `exclusions.json`. **Limit to one folder…** picks a folder on the Primary, such as `Photos/2019`, so that the comparison and the Update touch nothing outside it. The Safety stop is then measured against that folder, and files moved across its edge show as new or deleted rather than as Moves (ADR 0017). The choice lasts until you change it or quit. **Deep verify** makes the next comparison also read every file in full on both drives and compare their checksums, which catches damage on the Replica that sizes and dates do not show (ADR 0018). It takes much longer, and the choice also lasts until you change it or quit. **Compare** finds the paired drives among those connected. It never asks for drive paths, so the roles can never be swapped. It refuses if a paired drive is not connected, or if two connected drives share a paired Volume ID.

**Comparing.** A **Quick compare** judges files equal by size and modification date. A file moved into another folder on the Primary is reported as a **Move** once a checksum confirms it is the same file. Comparing never writes to either drive. If the Replica already matches the Primary, the app says so on Start. Anything on the Primary it cannot read is listed and skipped, and its Replica copy is never treated as deleted (ADR 0015). A progress bar shows the items read out of the drives' item counts, which macOS gives at once. Those counts are only an estimate, so the bar stops short of 100% until the comparison is done. On a drive that keeps no count, such as FAT or exFAT, it is a moving bar. Confirming Moves by checksum comes second, by bytes read, and the label names which of the two stages is under way. A Deep verify adds a stage between them: verifying contents by checksum, also by bytes read.

**Refusal screen** (only when needed). Comes before any Approval and says why:

- **The Safety stop applies:** the deleted files are more than 10% of the Replica, by count or by size, and more than 100 files (ADR 0008). The only way past it is to type the number of deletions, which holds for that one comparison.
- **The Replica lacks the free space for the copies.** This has no override.

**Copies, Anomalies, Moves, Deletions.** These are the review steps. Each one is grouped by folder, each folder expands to its files, and Copies, Moves and Deletions each have their own all-or-nothing **Approval**. Nothing is approved until you approve it. Anomalies, Moves and Deletions are skipped when there is nothing in them.

**Anomalies** are differences that an Update never makes. Copies flags changed files whose Replica copy is newer than the Primary's: the copies Approval still replaces them, as the Primary always wins. A Deep verify also finds **content mismatches**, files with the same size and date on both drives but different contents. They are never copied under the copies Approval. Instead, the Anomalies step lets you choose for each file whether to keep the Replica's copy or overwrite it with the Primary's. An overwritten Replica copy is moved into the Holding area, not destroyed. A file with no choice is left as it is (ADR 0018). Deletions also warns when the **Holding area** still holds files from the previous Update, because approving the new deletions deletes those for good (ADR 0006). Back and Next keep the Approvals and the choices. **Start over**, a drive disconnecting or quitting discards them.

**Summary.** Says exactly what **Apply** will do: what it copies, which content mismatches it overwrites or keeps (each file's choice is listed), what it renames and moves into the Holding area, what it permanently deletes from the previous Holding area, and what it leaves alone. Nothing is written before Apply.

**Updating.** Once Apply starts there is no going back. The app first remounts the Primary read-only and remounts it normally afterwards (ADR 0013). It then works in this order:

1. If the deletions are approved, it permanently deletes what the Holding area held from the previous Update, then moves the approved deletions into the visible `sync-drive Holding Area` folder on the Replica, keeping their folder paths. They stay there, not destroyed, until the next Update whose deletions are approved.
2. It renames the approved Moves on the Replica.
3. It copies the new and changed files, and the content mismatches you chose to overwrite (moving the Replica's copy of each into the Holding area first), with a progress bar by bytes out of the approved total. Copies keep their modification and creation dates, Finder tags, other extended attributes, permissions and flags (ADR 0005), and each copy's checksum is checked against the Primary (ADR 0010). Each file is written under a temporary name in a hidden `.sync-drive-incoming` folder on the Replica and renamed into place when complete, so an interrupted Update never leaves a truncated file under a real name. The next Update clears anything left there.

Before moving a deleted file, the app checks again that a comparison would still call it deleted. A file that is back on the Primary stays on the Replica (ADR 0014).

A finished Update then records its date in a hidden `.sync-drive-last-updated` file on the Replica. An Update limited to one folder is recorded apart, so it never makes the whole Replica look up to date. One that left undone something you wanted done, such as a file it could not copy, is recorded as partly updated, with how many items it left. If the date cannot be saved, or the folder was gone from the Primary, the Result says so and Start keeps the earlier date (ADR 0019).

**Result.** Lists what was copied, renamed and moved, and every file that was not, with the reason. It says what the Holding area now holds, from this Update or an earlier one, when it was last added to, and how to restore a file from it. Each Update is also logged on the Mac, in `~/Library/Application Support/sync-drive/Update logs/`. **Done** goes back to Start.
