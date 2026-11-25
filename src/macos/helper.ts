import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * The native helper built from `native/copy-with-metadata.c` by `npm run build`. Both `src/macos/`
 * and `dist/macos/` sit two levels below the project, so the same relative path works from either.
 */
export const HELPER = fileURLToPath(new URL("../../dist/libexec/copy-with-metadata", import.meta.url));

/**
 * What the helper failed with, as an Error: the reason it gave on stderr (`error.stderr`, as
 * `execFile` sets it), or that it has not been built.
 */
export async function helperFailure(error: unknown): Promise<Error> {
  const failure = error as NodeJS.ErrnoException & { stderr?: string };
  const stderr = failure.stderr;
  if (failure.code === "ENOENT" && !(await exists(HELPER))) {
    return new Error(`The copy helper ${HELPER} is missing. Build it with \`npm run build\`.`, { cause: error });
  }
  return new Error(stderr?.trim() || failure.message, { cause: error });
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
