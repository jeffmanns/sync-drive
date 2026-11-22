/**
 * Prints this Claude Code session's context usage, as the two lines posted on a ticket and its PR
 * before merging (see CLAUDE.md). Run with `node scripts/context-usage.ts` from inside the session.
 *
 * Reads the session's transcript, the newest one Claude Code keeps for this project:
 * - Line 1 is what `/context` shows: the context window at the latest call (its input and cache).
 * - Line 2 is a ballpark for the subagents, which `/context` leaves out: each one's context window
 *   when it ended, added up, and how much that is on top of the main window.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface Usage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

const project = join(homedir(), ".claude", "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
const session = await newestTranscript(project);
const main = await finalContext(join(project, `${session}.jsonl`));
const subagentsDir = join(project, session, "subagents");
const subagentFiles = (await readdir(subagentsDir).catch(() => [])).filter((name) => name.endsWith(".jsonl"));
let subagents = 0;
for (const name of subagentFiles) subagents += await finalContext(join(subagentsDir, name));

console.log(`Context used: ${thousands(main)} tokens (this session's context window at merge).`);
console.log(
  subagentFiles.length === 0
    ? "Subagents: none."
    : `Subagents: ~${thousands(subagents)} more across ${subagentFiles.length} (each one's window when it ended), ` +
        `~${Math.round((subagents / main) * 100)}% on top of the main window.`,
);

/** The id of the most recently written transcript: the session running this script. */
async function newestTranscript(dir: string): Promise<string> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  const times = await Promise.all(names.map(async (name) => ({ name, mtime: (await stat(join(dir, name))).mtimeMs })));
  const newest = times.sort((a, b) => b.mtime - a.mtime)[0];
  if (newest === undefined) throw new Error(`No Claude Code transcript in ${dir}`);
  return newest.name.slice(0, -".jsonl".length);
}

/** The context window at the last model call in a transcript: its input, cache writes and cache reads. */
async function finalContext(transcript: string): Promise<number> {
  let last: Usage | undefined;
  for (const line of (await readFile(transcript, "utf8")).split("\n")) {
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { usage?: Usage } };
      if (entry.type === "assistant" && entry.message?.usage !== undefined) last = entry.message.usage;
    } catch {
      // A line still being written, or not JSON: skip it.
    }
  }
  if (last === undefined) return 0;
  return (last.input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0);
}

function thousands(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}
