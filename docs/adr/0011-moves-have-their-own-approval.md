# Moves have their own Approval, and are confirmed by checksum at compare time

When a file has been moved or renamed on the Primary since the last Update (for example `Photos/Iceland/` dragged into `Photos/2026/`), the Report shows it as a Move, and an Update renames it on the Replica instead of copying it again and sending the old copy to the Holding area. The ticket (#8) left open which Approval covers Moves. The owner settled this, and the two questions that came with it, while building #8.

## The decision

- **Moves are a third all-or-nothing section, with their own step and Approval.** The review steps are Copies, Moves, Deletions, Summary. Moves is shown only when something was moved, like Deletions. ADR 0009's "one Approval per section" holds: Moves are simply a third section.
  - **Not the deletions Approval:** approving deletions permanently empties the previous Holding area (ADR 0006). A harmless rename must not require agreeing to destroy files.
  - **Not the copies Approval:** a Move copies nothing from the Primary. It renames paths already on the Replica, and that is the kind of change that needs the closest review. Folding it into "copy N files" would hide it.
- **Declining the Moves leaves both paths as they are.** The file stays at its old path on the Replica, nothing is copied to its new path, and the next comparison shows the Move again. It does not fall back to a copy plus a deletion: saying no to Moves must not quietly copy and delete those files under the other Approvals.
- **Moves are confirmed by SHA-256 during the comparison.** Candidates are a file only on the Primary and a file only on the Replica with the same name (exactly), size, and modification date (to within a hundredth of a second, ADR 0002). Both are read in full and their checksums compared (ADR 0010). The owner accepted that a large Move makes the comparison read both copies in full: data accuracy comes before performance.
- **Ambiguous candidates fall back to new plus deleted.** If another file on either side shares the same name, size and date, nothing can tell which one moved. A candidate whose checksums differ (for example, a damaged Replica copy) is not a Move either.
- **Moves are grouped by the folder that moved.** `Photos/Iceland/Day 2/b.jpg` → `Photos/2026/Iceland/Day 2/b.jpg` belongs to `Photos/Iceland/ → Photos/2026/Iceland/`. A file moved on its own belongs to the folders it sits directly in.

## How an approved Move is applied

- **After the deletions, before the copies.** A deleted file is then out of the way of a moved folder with the same name.
- **Each Move is checked again just before its rename.** Its Primary file and its Replica file must still match by size and date. If either has changed since the comparison, the file is left at its old path and listed as not renamed.
- **A rename never replaces anything.** If a file has appeared at the new path since the comparison, the Move is not made.
- **Old folders left empty are removed**, as for deletions, unless the Primary still has a folder there.
- **Moves are not counted by the Safety stop or the free-space check.** Nothing goes into the Holding area and no space is needed. This resolves ADR 0008's note that reorganising folders could trip the Safety stop.

## Considered Options

- **Moves under the copies Approval:** one fewer step, but renames on the Replica would be hidden behind the copy question.
- **Moves under the deletions Approval:** renaming would require permanently emptying the previous Holding area.
- **Falling back to copy plus deletion when Moves are declined:** saying no would still change those files on the Replica.
- **Confirming Moves only at Apply:** a faster comparison, but the Report would show Moves that might turn out not to be Moves.
- **Matching names regardless of letter case, or matching renamed files by contents alone:** more Moves found, but more chances of pairing the wrong files, and every unmatched file would need hashing.

## Consequences

- The comparison is slower when much has been moved. Hashing candidates at the same time as other reads is left to performance work (#12).
- A file moved and also edited on the Primary is not a Move: it shows as new plus deleted.
- Until #30 removes the CLI, `sync-drive update` asks a separate rename question between the copy question and the deletions question.
