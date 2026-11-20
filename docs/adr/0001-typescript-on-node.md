# TypeScript on Node, not Swift, for a Mac-only tool

sync-drive only ever runs on macOS, which would normally point to Swift. We chose TypeScript on Node because the owner knows TypeScript and React well and can review every line that agents write, and because a TypeScript engine with a React UI later is the most relevant portfolio piece for full-stack roles. The priorities are data accuracy first and performance second. Performance does not favour a different language here: the work is bound by disk and Thunderbolt throughput, copying is handed to macOS, and Node's hashing runs in native code. Speed comes from design instead: reading both drives at once, keeping several files in flight, and skipping unchanged files.

## Considered Options

- **Swift**: native and the obvious choice for a Mac app, but the owner can't review it, and only Command Line Tools are installed (no Xcode).
- **Python**: a résumé line, but no better suited to the problem and harder for the owner to review.
- **Rust/Go for speed**: rejected because the bottleneck is the disks, not the language.

## Consequences

- Hashing sits behind its own small interface inside the engine. If the benchmark on the real drives shows hashing is the bottleneck, only that part is replaced with a native (e.g. Rust) module called from Node.
- Copying must preserve all macOS metadata (dates, Finder tags, extended attributes). Whether Node's built-in copy does this needs checking against primary sources before it is relied on.
