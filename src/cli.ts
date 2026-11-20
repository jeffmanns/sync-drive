#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { run } from "./cli/run.ts";
import { MacFileCopier } from "./macos/file-copier.ts";
import { MacVolumes } from "./macos/volume-identity.ts";

process.exitCode = await run(process.argv.slice(2), {
  volumes: new MacVolumes(),
  pairingFile: join(homedir(), "Library", "Application Support", "sync-drive", "pairing.json"),
  copier: new MacFileCopier(),
  confirm,
  out: (text) => console.log(text),
  err: (text) => console.error(text),
});

/** Asks on the terminal. Only "y" or "yes" approves; anything else, or closed input, declines. */
async function confirm(question: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise<string>((resolve) => terminal.once("close", () => resolve("")));
  try {
    const answer = await Promise.race([terminal.question(`${question} [y/N] `), closed]);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    terminal.close();
  }
}
