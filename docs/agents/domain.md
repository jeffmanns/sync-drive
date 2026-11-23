# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, or
- **`GLOSSARY-MAP.md`** at the repo root if it exists: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (most repos):

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repo (presence of `GLOSSARY-MAP.md` at the root):

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── GLOSSARY.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_

## When a ticket and an ADR disagree, the ADR wins

Tickets are written up front; ADRs record decisions settled later, so an ADR overrides older ticket text. Build what the ADR says and name the conflict in the PR. If following the ADR changes what the ticket asks for, ask the owner before building.

## ADRs are a record: never rewrite them

An ADR records what was decided, when, and why, given what was known then. Once merged, leave its text as written, even when a later decision changes it or a term it uses (a command, a flag) no longer exists. Don't edit or delete its notes about what holds "until" a later ticket either: they are dated by their own wording and stay true as history.

A later decision goes in a new ADR, which says which earlier ADRs it changes and what their old terms now mean (as ADR 0009 does for ADR 0004 and ADR 0008).

When a ticket says nothing should refer to something any more, that means the living docs: `README.md`, `GLOSSARY.md`, code comments and messages. ADRs are out of scope; name the ADRs that still mention it in the PR.
