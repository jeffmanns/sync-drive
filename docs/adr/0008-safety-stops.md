# Safety stops: when an Update is refused before anything is written

An Update can go badly wrong if something is wrong with the Primary, for example if it is failing, was only partly read, or was erased. Then many files look deleted, and confirming deletions would move them into the Holding area, where the next confirmed Update deletes them for good (ADR 0006). Two checks refuse an Update before anything is written. The owner settled the Safety stop's limits while building #6.

## The Safety stop

- **It applies when the deleted files are more than 10% of the Replica, by file count or by size, and are more than 100 files.** Both parts must hold. "The Replica" means its contents for comparison: the Holding area and the Incoming folder are not counted.
- **Counting both files and size** catches deleting a few very large files (size) as well as thousands of small ones (count).
- **The 100-file minimum** stops false alarms on a small Replica, where a few files can already be 10%. On an everyday drive with tens of thousands of files, the minimum never matters. A month of iPhone photos (about 250 files) moved to another folder trips the stop only on a Replica of under 2,500 files.
- **When it applies, the whole Update is refused**, copies included. Something is probably wrong with the Primary, so copying from it is not trusted either. No questions are asked.
- **The only override is `--allow-mass-deletion`, given for that one run.** It is never remembered. Even with it, the Update still asks for the main approval and the deletions confirmation as usual.
- **Every Report says whether the Safety stop applies**, with the deleted files' share of the Replica by count and by size.

## The free-space check

- **An Update is refused when the Replica lacks room for every new and changed file.** Each file is counted at its size rounded up to the Replica's block size.
- **It is cautious.** It does not count space the Update would free: neither the old versions replaced by changed files, nor a previous Holding area emptied by confirming deletions. Local snapshots can keep that space in use anyway. If the Replica is nearly full, the message names the Holding area's size, so the owner can free space and try again.
- **It is checked once, before any question**, and again by the engine just before it writes.

## Considered Options

- **A lower limit (2–5%).** Updates are monthly to every six months, so normal tidying between Updates can reach a few percent. A stop that trips on ordinary Updates gets overridden out of habit, and then protects nothing.
- **A higher minimum (for example 1,000 files).** It changes nothing on a large Replica. On a small one it lets real losses through: 900 of 5,000 files (18%) would pass.
- **Refusing only the deletions, and still copying.** Copies replace the Replica's versions of changed files, and those versions are not kept anywhere. If the Primary is suspect, those copies should not run either.
- **A remembered override setting.** It would be switched on once and forgotten.

## Consequences

- A Primary that was only partly read is not caught by the Safety stop when the missing part is small. The scan guards against that separately: a folder it cannot read stops the comparison rather than looking empty.
- Until move detection (#8), a moved folder counts as deleted at its old path. Reorganising many folders between Updates can trip the Safety stop; the override is the way through.
- With `--only` (#15), the Safety stop is measured against that folder's contents, and the 100-file minimum still applies.
