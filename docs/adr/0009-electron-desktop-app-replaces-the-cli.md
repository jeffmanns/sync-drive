# An Electron desktop app replaces the CLI in v1

v1 was specced as a CLI, with a React UI planned for v2 (ADR 0001, spec #1). Halfway through the tickets, the owner moved the UI into v1 and dropped the CLI. The deciding problem is the Report's file lists. In compare, the copies, the deletions and the Holding area there can be hundreds of files, and in a terminal they scroll past. Finding a file again, or going back to an earlier decision, means scrolling back through cluttered output. Data accuracy comes first, and the riskiest moment is an Approval that writes to the Replica. A list you can expand and go back to makes a wrong Approval less likely than scrolled terminal output does.

The remaining tickets with real interaction (per-file Anomaly choices, now #31; progress, now #29; guided Pairing, #20) would otherwise be built twice, once as terminal prompts and again as screens. The engine already has no terminal I/O: `compare()` returns a Report and `update()` takes Approvals. So the change is limited to the front end. The owner settled this in a grilling session on 2026-11-21, recorded in #26.

## The decision

- **The app is an Electron app with React screens.** The engine runs in Electron's main process, unchanged apart from gaining progress reporting. There is no server and no open port.
- **The app runs on Electron's bundled Node (24.22.1 or later), not the system's Node 26.** The project's Node pin follows it, and the test suite runs on Electron's runtime, so what is tested is what runs. The owner accepted that Electron's Node may trail the latest Node security release. Most of those fixes are in network code that an offline app never calls.
- **The CLI is deleted** once the app does everything it does: #26 is the tracer bullet (a copies-only Update), #27 adds Deletions, #28 the refusal screen, and #30 removes the CLI. So `main` always has a full working front end. One front end means each ticket builds its UI once.
- **The flow is a sequence of steps with Back and Next:** Pairing (only when none is saved), Start, Comparing, a refusal screen (only when a Safety stop or the free-space check refuses), Copies, Anomalies (#31), Deletions, Summary, Apply, Updating, Result.
  - Back and Next work on the review steps, and decisions are remembered when moving between them.
  - Nothing is written until Apply, which follows a summary of exactly what will happen.
  - Once Apply starts, there is no going back.
- **Decisions live in memory only and belong to the current comparison.** Quitting, a drive disconnecting or a new compare discards them. Decisions kept for a Primary that may have changed since would put accuracy at risk.
- **Approvals stay all-or-nothing per section.** One Approval covers the copies and another covers the deletions. Unticking single files would make the Replica no longer an exact copy. Leaving something out for good is what an Exclusion is for. Only content-mismatch Anomalies get per-file choices (#31).
- **No control approves copies and deletions together.** There is no "sync all". The deletions keep their own Approval, with the Holding area warning right before it (ADR 0006).
- **The Safety stop override is a count the owner types**, offered only on the refusal screen and valid for that one run. This replaces ADR 0008's `--allow-mass-deletion` flag. Everything else in ADR 0008 stands: no questions before the refusal, never remembered, and the engine re-checks before writing.
- **Progress bars:**
  - **Compare:** items scanned out of the volumes' item counts, which macOS reports instantly. The bar stays below 100% until the compare finishes, and becomes a moving bar when a volume reports no usable count.
  - **Deep verify:** its checksum phase gets a bar by bytes.
  - **Update:** a bar by bytes, out of the approved total.

## Considered Options

- **Finish the CLI, and build the app in v2:** builds the interaction-heavy tickets twice, and leaves the list problem in place for all of v1.
- **A local web UI served by the Node process:** a browser tab rather than an app. A local server that can write to the Replica can also be reached by other programs on the Mac and by web pages through the browser, and hardening that is work in exactly the code that most needs to be safe.
- **Tauri:** puts a Rust layer between the screens and a Node engine.
- **A non-interactive CLI that writes a plan to review, then applies it:** the owner wants an interactive tool.
- **A terminal UI with scrollable lists:** only slightly better than the CLI for long lists and revisiting decisions.
- **Running the engine as a separate system-Node 26 process:** one Node version everywhere, but more code between the screens and the engine, including during an Update.

## Consequences

- The step logic is a plain TypeScript module with no React, tested with `node:test`. The CLI's flow tests move there, and the React screens only display it. One end-to-end smoke test launches the app on the macOS CI runner.
- Earlier ADRs refer to CLI commands:
  - ADR 0003 and ADR 0004 mention `pair` and `pair --replace`. These now mean the app's Pairing step and its Re-pair action, which needs an extra confirmation.
  - ADR 0008 mentions `--allow-mass-deletion` and `--only`. These now mean the typed-count override and the Start screen's folder choice (#15).
- The guided Pairing (#20) lists external drives and mounted disk images, so the rehearsal kit's disk images (#16) can be paired without the path-based `pair` command.
- Distribution polish (signing, notarisation, auto-update) is out of scope. sync-drive is a personal tool.
