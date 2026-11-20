/**
 * The hidden folder at the top level of the Replica where an Update writes each copy under a
 * temporary name before renaming it into place. It is on the same drive, so the rename is atomic.
 * Anything left in it was interrupted. It never appears in a comparison.
 */
export const INCOMING_FOLDER = ".sync-drive-incoming";
