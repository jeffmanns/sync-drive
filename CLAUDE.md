## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for jeffmanns/sync-drive (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default five triage labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.

## Way of working

- One ticket at a time. Each ticket gets its own branch (`<issue-number>-<short-slug>`), created from an up-to-date main.
- Open a pull request that links its ticket (`Closes #N`). Never commit ticket work straight to main.
- CI (GitHub Actions, macOS runner) must be green before merging.
- The owner reviews and approves every PR before it is merged. Never merge without the owner's go-ahead.
- PRs that write, rename, or delete on the Replica need the closest review. Call out those code paths in the PR body.
- When the owner settles a decision during a ticket that later tickets must respect, record it in that ticket's PR: a new term in `GLOSSARY.md`, a rule or trade-off in an ADR (`docs/adr/`).
- Priorities, in order: data accuracy, then performance. The Primary is never written to.
