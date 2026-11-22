import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkExclusion } from "./exclusions.ts";

/** Where the Exclusions are stored: beside the Pairing stored in `pairingFile`. */
export function exclusionsFileBeside(pairingFile: string): string {
  return join(dirname(pairingFile), "exclusions.json");
}

/**
 * Reads the Exclusions stored in `file`, in the order they were added. None when the file does not
 * exist. Rejects if it is damaged, or holds a pattern `checkExclusion` would not save, rather than
 * compare with Exclusions other than the owner's.
 */
export async function readExclusions(file: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  const exclusions = typeof data === "object" && data !== null ? (data as { exclusions?: unknown }).exclusions : undefined;
  if (!Array.isArray(exclusions) || !exclusions.every((pattern) => typeof pattern === "string" && isAsSaved(pattern))) {
    throw new Error(`The Exclusions saved in ${file} are damaged. Fix or delete that file, then open sync-drive again.`);
  }
  return exclusions as string[];
}

/** Stores `exclusions` in `file`, replacing the earlier ones. A half-written file is never left behind. */
export async function writeExclusions(file: string, exclusions: readonly string[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const partial = `${file}.partial`;
  await writeFile(partial, JSON.stringify({ exclusions }, null, 2) + "\n");
  await rename(partial, file);
}

function isAsSaved(pattern: string): boolean {
  try {
    return checkExclusion(pattern) === pattern;
  } catch {
    return false;
  }
}
