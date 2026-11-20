# sync-drive

A personal Mac tool that compares an everyday external drive (the **Primary**) against its backup drive (the **Replica**), and brings the Replica up to date on approval. See `GLOSSARY.md` for the vocabulary.

## Setup

Requires Node 26 (see `.nvmrc`).

```sh
npm install
npm test      # typecheck, build, and run all tests
```

## Usage

```sh
npm run build
node dist/cli.js pair <primary> <replica> [--replace]
node dist/cli.js compare [--list]
```

`pair` is run once. Give the top level of each drive (e.g. `/Volumes/Photos`). It stores the **Pairing** in `~/Library/Application Support/sync-drive/pairing.json`, recognising each drive by its **volume ID** rather than its name, so renaming a drive does not matter. To pair again (e.g. after replacing a drive), add `--replace`.

`compare` finds the paired drives among those connected and runs a Quick compare (size and modification date). It reports new, changed and deleted files, grouped by folder with file counts and total sizes. `--list` shows every file. It takes no drive paths, so the roles can never be swapped. It refuses to run if a paired drive is not connected, or if two connected drives share a paired volume ID. It writes nothing to either drive.
