#!/usr/bin/env node
import { parseArgs } from "node:util";
import { renderReport } from "./cli/render-report.ts";
import { compare } from "./engine/index.ts";

const USAGE = `Usage: sync-drive compare <primary> <replica> [--list]

  Compares the Primary with the Replica by Quick compare (size and modification date)
  and reports new, changed and deleted files. Writes nothing to either drive.

  --list   Show every file, not just the totals for each folder.`;

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { list: { type: "boolean", default: false } },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const [command, primary, replica, ...extra] = parsed.positionals;
  if (command !== "compare" || primary === undefined || replica === undefined || extra.length > 0) {
    console.error(USAGE);
    return 2;
  }

  try {
    const report = await compare(primary, replica);
    console.log(`Primary: ${primary}\nReplica: ${replica}\n`);
    console.log(renderReport(report, { list: parsed.values.list }));
    return 0;
  } catch (error) {
    console.error(`sync-drive: ${(error as Error).message}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
