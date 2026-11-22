/**
 * Exclusions: path patterns the owner chose to leave out of every comparison, on top of the macOS
 * system files that are always skipped (`always-skipped.ts`).
 *
 * How a pattern reads:
 * - A pattern with no `/` matches a file or folder of that name in any folder: `*.tmp`, `node_modules`.
 * - A pattern with a `/` is a path from the top level of the drive: `Movies/Cache`, `/Scratch`.
 *   A leading `/` only says so; a trailing `/` is ignored.
 * - `*` stands for any characters within a name, `?` for one character, and `**` as a whole name
 *   for any number of folders, including none: `Projects/**\/build`.
 * - Excluding a folder excludes everything in it.
 * - Letter case is ignored, as when pairing files (ADR 0002). So are Unicode forms, so a pattern
 *   typed as `é` matches a name stored as `e` plus a combining accent (ADR 0016).
 */

/** Whether `path` (relative to the drive root, using `/`) is left out by the Exclusions it was made from. */
export type ExclusionMatcher = (path: string) => boolean;

/**
 * `typed` as it is saved, once checked: trimmed, and with any trailing `/` taken off. Rejects,
 * saying why, a pattern that is empty, has an empty, `.` or `..` name in it, or would leave out
 * everything on the drive (only `*`s).
 */
export function checkExclusion(typed: string): string {
  const pattern = typed.trim().replace(/\/+$/, "");
  if (pattern === "") throw new Error("Type a name or a path to exclude.");
  const names = namesOf(pattern);
  if (names.some((name) => name === "" || name === "." || name === "..")) {
    throw new Error(`"${typed.trim()}" is not a name or path on the drive: it has an empty name, "." or ".." in it.`);
  }
  if (names.every((name) => /^\*+$/.test(name))) {
    throw new Error(`"${typed.trim()}" would leave out everything on the drive, so nothing would be backed up.`);
  }
  return pattern;
}

/**
 * Makes the matcher for `exclusions`. Each must pass `checkExclusion`; the matcher rejects one that
 * does not, rather than guess what it was meant to leave out. A path is excluded when it, or a
 * folder above it, matches a pattern.
 */
export function exclusionMatcher(exclusions: readonly string[]): ExclusionMatcher {
  const patterns = exclusions.map((typed) => {
    const pattern = checkExclusion(typed);
    if (pattern !== typed) throw new Error(`The Exclusion "${typed}" is not as saved: "${pattern}".`);
    return patternRegExp(pattern);
  });
  if (patterns.length === 0) return () => false;
  const matches = (path: string) => patterns.some((pattern) => pattern.test(path));
  return (path) => {
    const key = comparable(path);
    for (let end = key.length; end > 0; end = key.lastIndexOf("/", end - 1)) {
      if (matches(key.slice(0, end))) return true;
    }
    return false;
  };
}

/** The names in `pattern`, after the leading `/` that anchors it, if any. */
function namesOf(pattern: string): string[] {
  return pattern.replace(/^\//, "").split("/");
}

/** The regular expression matching exactly the paths `pattern` names (not those below them). */
function patternRegExp(pattern: string): RegExp {
  const anchored = pattern.includes("/");
  const names = namesOf(comparable(pattern));
  // A pattern with no `/` matches the name in any folder: the same as `**/name`.
  if (!anchored) names.unshift("**");
  const source = names
    .map((name, i) => {
      const last = i === names.length - 1;
      // `**` is any number of folders: at the end, at least one name, so it matches what is inside.
      if (name === "**") return last ? "[^/]+(?:/[^/]+)*" : "(?:[^/]+/)*";
      return nameRegExp(name) + (last ? "" : "/");
    })
    .join("");
  return new RegExp(`^${source}$`, "u");
}

/** The regular expression source for one name: `*` is any characters but `/`, `?` is one. */
function nameRegExp(name: string): string {
  return [...name]
    .map((char) => (char === "*" ? "[^/]*" : char === "?" ? "[^/]" : char.replace(/[\\^$.|+()[\]{}]/g, "\\$&")))
    .join("");
}

/** `text` with letter case and Unicode forms set aside, for matching only. */
function comparable(text: string): string {
  return text.normalize("NFC").toLowerCase();
}
