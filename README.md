# sync-drive

A personal Mac tool that compares an everyday external drive (the **Primary**) against its backup drive (the **Replica**), and brings the Replica up to date on approval. See `GLOSSARY.md` for the vocabulary.

## Setup

Requires Node 24.22.1 or later (see `.nvmrc`; the app and the tests run on the Node bundled with Electron, ADR 0009) and `clang` (from the Xcode Command Line Tools: `xcode-select --install`), which builds the small native helper Update copies files with (see ADR 0005).

```sh
npm install
npm test      # typecheck, build, and run all tests on Electron's runtime (opens the app briefly)
```

## The desktop app

```sh
npm start     # build and open the app
```

The app is replacing the command line (ADR 0009). So far it runs a copies-only Update: Pairing (the first time), Start, Comparing, Copies (new and changed files by folder, each folder expanding to its files, with one Approval), Summary, Apply, Result. Back and Next keep the Approval; a new compare, a drive disconnecting or quitting discards it. It does not move deleted files yet, and when the Safety stop or the free-space check refuses, it says why and stops. It uses the same Pairing as the command line.

## Command line

```sh
npm run build
node dist/cli.js pair <primary> <replica> [--replace]
node dist/cli.js compare [--list]
node dist/cli.js update [--list]
```

`pair` is run once. Give the top level of each drive (e.g. `/Volumes/Photos`). It stores the **Pairing** in `~/Library/Application Support/sync-drive/pairing.json`, recognising each drive by its **volume ID** rather than its name, so renaming a drive does not matter. To pair again (e.g. after replacing a drive), add `--replace`.

`compare` finds the paired drives among those connected and runs a Quick compare (size and modification date). It reports new, changed and deleted files, grouped by folder with file counts and total sizes. `--list` shows every file. It takes no drive paths, so the roles can never be swapped. It refuses to run if a paired drive is not connected, or if two connected drives share a paired volume ID. It writes nothing to either drive.

`update` runs the same comparison, shows the report and asks for approval. Once approved, it copies new and changed files from the Primary to the Replica. Copies keep the modification and creation dates, Finder tags, other extended attributes, permissions and flags, so a following `compare` reports no differences. Each file is written under a temporary name in a hidden `.sync-drive-incoming` folder on the Replica and renamed into place when complete, so an interrupted run never leaves a truncated file under a real name. The next `update` clears anything left there. Files only on the Replica are left where they are for now. Like `compare`, it takes no drive paths, and it never writes to the Primary.
