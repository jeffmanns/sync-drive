# How Exclusions match, and how they are kept

Exclusions are path patterns the owner chooses to leave out of every comparison, on top of the macOS system files that are always skipped (ADR 0002). Since ADR 0009 they are edited in a list on the Start screen. These rules were chosen while building #9. The owner reviews them in that PR.

## The decision

- **A pattern with no `/` matches a name in any folder; a pattern with a `/` is a path from the top level of the drive.** `*.tmp` and `node_modules` match anywhere. `Movies/Cache` and `/Scratch` match only at the top. A leading `/` just marks the pattern as anchored, and a trailing `/` is dropped when it is saved. The rule is gitignore's, without the parts a backup doesn't need: no `!` negation, no `[...]` character classes, and no folder-only patterns.
- **`*` stands for any characters within a name, `?` for one character, and `**` used as a whole name for any number of folders, including none.** Everything else is matched literally.
- **Excluding a folder excludes everything in it, and the comparison never reads inside it.** So nothing in it is listed as unreadable.
- **Letter case is ignored, and so are Unicode forms.** Pairing files ignores case but keeps Unicode forms apart (ADR 0002). That rule is about not merging two real files. An Exclusion is typed by the owner, who can't see which form a name is stored in. Matching only the typed form could quietly back up a folder the owner excluded.
- **What an Exclusion matches is left out on both drives.** It is never reported, so it is never copied, moved, renamed or deleted. Replica files under it stay as they are, and they don't count towards the Replica's totals for the Safety stop.
- **A pattern that would leave out everything is refused**, as are empty names, `.` and `..`. That means any pattern whose every name is only wildcards with a `*` in it: `*`, `**`, `*/*`, `?*` and the like. Otherwise one typo would make every comparison say the drives match.
- **The Primary still can't hide an item named like sync-drive's own folders behind an Exclusion** (ADR 0007). That check runs before the Exclusions.
- **The Update is held to the Exclusions its Report was made with.** `update()` writes nothing if the Report holds any path those Exclusions leave out. The app passes the Exclusions it compared with. This mirrors how the Safety stop is counted again rather than trusted (ADR 0008).
- **They are saved on the Mac beside the Pairing, in `exclusions.json`.** Re-pairing keeps them. If the file is damaged, the app says so on Start and refuses to compare, and it never saves over the file. Comparing without the owner's Exclusions would offer to delete their Replica copies. The CLI reads the same file until it is removed (#30).

## Considered Options

- **Full gitignore syntax:** negation and character classes add ways to get a pattern subtly wrong, and nothing on the owner's drives needs them.
- **Every pattern anchored at the top level:** `node_modules` or `*.tmp` would then need `**/` in front, which is easy to forget.
- **Treating a damaged file as no Exclusions:** the next comparison would show the excluded Replica files as deleted.

## Consequences

- Limiting a run to one folder (#15) and Deep verify must take the same `exclusions` option, so that every comparison leaves out the same paths.
- The Update's check before each deletion (ADR 0014) needs no change. A Report made with these Exclusions never holds an excluded path, and `update()` refuses one that does.
