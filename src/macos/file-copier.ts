import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FileCopier } from "../engine/index.ts";
import { HELPER, helperFailure } from "./helper.ts";

const run = promisify(execFile);

/**
 * Copies files with all their macOS metadata (dates including the creation date, Finder tags,
 * extended attributes, permissions and flags) using the native helper. Node's own `copyFile`
 * keeps none of these reliably: see ADR 0005.
 */
export class MacFileCopier implements FileCopier {
  async copy(source: string, destination: string): Promise<void> {
    try {
      await run(HELPER, [source, destination]);
    } catch (error) {
      throw await helperFailure(error, (error as { stderr?: string }).stderr);
    }
  }
}
