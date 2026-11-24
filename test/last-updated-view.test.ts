import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { holdingAreaReminder, lastUpdatedLines, notRecordedWarning } from "../src/app/view.ts";
import { howLongAgo } from "../src/format.ts";

/** A local date and time, as the owner's Mac sees it. */
const at = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour);

describe("How long ago", () => {
  it("says today and yesterday by the calendar, not by hours passed", () => {
    assert.equal(howLongAgo(at(2026, 11, 24, 1), at(2026, 11, 24, 23)), "today");
    assert.equal(howLongAgo(at(2026, 11, 23, 23), at(2026, 11, 24, 1)), "yesterday");
  });

  it("counts days under a month, then whole calendar months, then years from two years on", () => {
    assert.equal(howLongAgo(at(2026, 11, 1), at(2026, 11, 24)), "23 days ago");
    assert.equal(howLongAgo(at(2026, 10, 25), at(2026, 11, 24)), "30 days ago");
    assert.equal(howLongAgo(at(2026, 10, 24), at(2026, 11, 24)), "1 month ago");
    assert.equal(howLongAgo(at(2026, 8, 25), at(2026, 11, 24)), "2 months ago");
    assert.equal(howLongAgo(at(2024, 12, 1), at(2026, 11, 24)), "23 months ago");
    assert.equal(howLongAgo(at(2024, 11, 24), at(2026, 11, 24)), "2 years ago");
  });

  it("says today for a date after now, as when the Mac's clock was wrong", () => {
    assert.equal(howLongAgo(at(2026, 12, 1), at(2026, 11, 24)), "today");
  });
});

describe("When the Replica was last updated, on Start", () => {
  const NOW = at(2026, 11, 24);

  it("says how long ago the whole drive was last updated, and on which day", () => {
    assert.deepEqual(lastUpdatedLines({ known: true, wholeDrive: { updated: at(2026, 8, 20).toISOString() }, folders: [] }, NOW), [
      "Replica last updated 3 months ago, on 20 August 2026.",
    ]);
  });

  it("lists each folder updated on its own since, without calling the Replica up to date", () => {
    const record = {
      known: true as const,
      wholeDrive: { updated: at(2026, 8, 20).toISOString() },
      folders: [{ folder: "Photos/2026", updated: at(2026, 11, 22).toISOString() }],
    };

    assert.deepEqual(lastUpdatedLines(record, NOW), [
      "Replica last updated 3 months ago, on 20 August 2026.",
      'Since then, only the folder "Photos/2026" was updated: 2 days ago, on 22 November 2026.',
    ]);
  });

  it("says when an Update was partial, and how many items it left undone", () => {
    const record = {
      known: true as const,
      wholeDrive: { updated: at(2026, 11, 20).toISOString(), leftUndone: 3 },
      folders: [
        { folder: "Music", updated: at(2026, 11, 22).toISOString() },
        { folder: "Photos", updated: at(2026, 11, 24).toISOString(), leftUndone: 1 },
      ],
    };

    assert.deepEqual(lastUpdatedLines(record, NOW), [
      "Replica last partly updated 4 days ago, on 20 November 2026. 3 items were left undone.",
      'Since then, only the folder "Music" was updated: 2 days ago, on 22 November 2026.',
      'Since then, only the folder "Photos" was partly updated: today, on 24 November 2026. 1 item was left undone.',
      "Each Update's log on this Mac lists what it left undone, and why.",
    ]);
  });

  it("says when sync-drive has never updated the whole Replica", () => {
    assert.deepEqual(lastUpdatedLines({ known: true, folders: [] }, NOW), ["sync-drive has not updated the whole Replica yet."]);
    assert.deepEqual(lastUpdatedLines({ known: true, folders: [{ folder: "Photos", updated: at(2026, 11, 24).toISOString() }] }, NOW), [
      "sync-drive has not updated the whole Replica yet.",
      'Only the folder "Photos" was updated: today, on 24 November 2026.',
    ]);
  });

  it("says why it is not known", () => {
    assert.deepEqual(lastUpdatedLines({ known: false, reason: "Connect the Replica to see when it was last updated." }, NOW), [
      "Connect the Replica to see when it was last updated.",
    ]);
  });
});

describe("The Holding area reminder, on the Result", () => {
  it("says what the Holding area holds, when it was last added to, and how to restore from it", () => {
    assert.deepEqual(holdingAreaReminder({ count: 3, totalSize: 1_200_000, lastAddedOn: "20 August 2026" }), [
      "The Holding area on the Replica holds 3 files (1.2 MB), last added to by the Update on 20 August 2026.",
      "They stay there until an Update whose deletions you approve, which deletes them for good.",
      "To restore a file, copy it from the Holding area back to the Primary, into its original folder. " +
        "Do not move it back on the Replica: the next Update would treat it as deleted again.",
    ]);
  });

  it("leaves out the date when the Holding area's READ ME gives none", () => {
    assert.equal(holdingAreaReminder({ count: 1, totalSize: 5 })[0], "The Holding area on the Replica holds 1 file (5 B).");
  });

  it("says when it is empty", () => {
    assert.deepEqual(holdingAreaReminder({ count: 0, totalSize: 0 }), ["The Holding area on the Replica is empty."]);
  });
});

describe("An Update not recorded on the Replica, on the Result and in the log", () => {
  it("says the Update finished, why its date was not saved, and what Start shows instead", () => {
    assert.equal(
      notRecordedWarning('the folder "Photos" is no longer on the Primary since the comparison'),
      'This Update finished, but its date was not saved on the Replica, because the folder "Photos" is no longer on the Primary ' +
        "since the comparison. Start will go on showing the date of the Update before it.",
    );
  });
});
