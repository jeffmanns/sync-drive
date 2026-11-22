/** The Safety stop's limits (ADR 0008). Imports nothing from Node, so the app's screens can use them too. */

/** The Safety stop applies above this share of the Replica, by file count or by size. */
export const SAFETY_STOP_PERCENT = 10;

/** The Safety stop never applies to this many deleted files or fewer. */
export const SAFETY_STOP_MIN_FILES = 100;
