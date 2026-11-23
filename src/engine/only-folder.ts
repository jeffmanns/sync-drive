import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isAlwaysSkipped } from "./always-skipped.ts";
import type { ExclusionMatcher } from "./exclusions.ts";
import { matchKey, readFailure } from "./scan.ts";
import { isSyncDriveFolder } from "./sync-drive-folders.ts";

/**
 * Rejects, saying why, a folder to limit a run to that is not plainly a folder inside the drive
 * (relative, using `/`, with no empty, `.` or `..` name), is inside sync-drive's own folders or the
 * macOS system files, or is left out by the Exclusions, as nothing in it would ever be compared.
 */
export function checkOnlyFolder(only: string, isExcluded: ExclusionMatcher): void {
  const names = only.split("/");
  if (isAbsolute(only) || names.some((name) => name === "" || name === "." || name === "..")) {
    throw new Error(`"${only}" is not a folder inside the drive, so the comparison cannot be limited to it.`);
  }
  if (isSyncDriveFolder(names[0]!)) {
    throw new Error(`"${only}" is inside sync-drive's own ${names[0]} folder, which is never compared.`);
  }
  if (names.some((_, i) => isAlwaysSkipped(names.slice(0, i + 1).join("/")))) {
    throw new Error(`"${only}" is one of macOS's own system folders, which are never compared.`);
  }
  if (isExcluded(only)) {
    throw new Error(`"${only}" is left out by the Exclusions, so nothing in it would be compared.`);
  }
}

/**
 * Finds the folder `only` on the `role` drive at `root`, one name at a time, ignoring letter case as
 * files are paired (`matchKey`). Resolves with its path as stored on that drive, or, on the Replica
 * only, `undefined` when it is not there yet. Rejects when it is missing on the Primary, when it or a
 * folder above it is a file or a shortcut (which a comparison of the whole drive would never follow),
 * when two names along the way differ only by case, or when it or a folder above it cannot be read.
 * Reads only.
 */
export async function findOnlyFolder(role: "Primary" | "Replica", root: string, only: string): Promise<string | undefined> {
  let found = "";
  for (const name of only.split("/")) {
    const listed = await readdir(join(root, found), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      throw cannotRead(role, found, only, error);
    });
    const matches = listed.filter((entry) => matchKey(entry.name) === matchKey(name));
    if (matches.length > 1) {
      throw new Error(
        `The ${role} holds ${matches.map((entry) => `"${found === "" ? entry.name : `${found}/${entry.name}`}"`).join(" and ")}, ` +
          `which differ only by letter case, so the comparison cannot be limited to "${only}" safely.`,
      );
    }
    const entry = matches[0];
    if (entry === undefined) {
      if (role === "Replica") return undefined;
      throw new Error(`The Primary has no folder "${only}". Choose a folder on the Primary.`);
    }
    found = found === "" ? entry.name : `${found}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(`"${found}" on the ${role} is a shortcut, which sync-drive never follows, so the comparison cannot be limited to "${only}".`);
    }
    if (!entry.isDirectory()) throw new Error(`"${found}" on the ${role} is not a folder, so the comparison cannot be limited to "${only}".`);
  }
  // Listed above it, but it must also be opened and listed itself to be compared.
  await access(join(root, found), constants.R_OK | constants.X_OK).catch((error: NodeJS.ErrnoException) => {
    throw cannotRead(role, found, only, error);
  });
  return found;
}

/** Why the comparison limited to `only` cannot go ahead: `folder` on the `role` drive cannot be read. */
function cannotRead(role: "Primary" | "Replica", folder: string, only: string, error: NodeJS.ErrnoException): Error {
  const where = folder === "" ? `The top level of the ${role}` : `The folder "${folder}" on the ${role}`;
  return new Error(`${where} cannot be read (${readFailure(error)}), so the comparison cannot be limited to "${only}".`, { cause: error });
}
