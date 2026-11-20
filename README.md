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
node dist/cli.js compare <primary> <replica> [--list]
```

`compare` runs a Quick compare (size and modification date) and reports new, changed and deleted files, grouped by folder with file counts and total sizes. `--list` shows every file. It writes nothing to either drive.
