#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./cli/run.ts";
import { MacVolumes } from "./macos/volume-identity.ts";

process.exitCode = await run(process.argv.slice(2), {
  volumes: new MacVolumes(),
  pairingFile: join(homedir(), "Library", "Application Support", "sync-drive", "pairing.json"),
  out: (text) => console.log(text),
  err: (text) => console.error(text),
});
