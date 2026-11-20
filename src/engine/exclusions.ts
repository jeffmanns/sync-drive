/** macOS system folders and files that live at the top level of a drive. Always skipped there. */
const DRIVE_LEVEL_SYSTEM_ENTRIES = new Set([
  ".Spotlight-V100",
  ".fseventsd",
  ".Trashes",
  ".TemporaryItems",
  ".DocumentRevisions-V100",
]);

/** macOS system files that Finder can create in any folder. Always skipped, at any depth. */
const ANY_LEVEL_SYSTEM_ENTRIES = new Set([".DS_Store"]);

/** Whether `path` (relative to the drive root, using `/`) is a built-in exclusion. */
export function isBuiltInExclusion(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (ANY_LEVEL_SYSTEM_ENTRIES.has(name)) return true;
  const atDriveLevel = !path.includes("/");
  return atDriveLevel && DRIVE_LEVEL_SYSTEM_ENTRIES.has(name);
}
