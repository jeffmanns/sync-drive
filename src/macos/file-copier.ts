import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { FileCopier } from "../engine/index.ts";

const run = promisify(execFile);

/**
 * The native helper built from `native/copy-with-metadata.c` by `npm run build`. Both `src/macos/`
 * and `dist/macos/` sit two levels below the project, so the same relative path works from either.
 */
const HELPER = fileURLToPath(new URL("../../dist/libexec/copy-with-metadata", import.meta.url));

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
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      if (failure.code === "ENOENT" && !(await exists(HELPER))) {
        throw new Error(`The copy helper ${HELPER} is missing. Build it with \`npm run build\`.`, { cause: error });
      }
      throw new Error(failure.stderr?.trim() || failure.message, { cause: error });
    }
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
