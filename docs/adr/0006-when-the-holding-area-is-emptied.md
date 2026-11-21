# The Holding area is emptied only when new deletions are confirmed

An Update moves files no longer on the Primary into the Holding area, after a confirmation separate from the main approval. Those files are deleted for good the next time the Holding area is emptied. The ticket (#5) said it is emptied "after the next Update is confirmed". Read literally, approving the copies alone would destroy the previous Holding area, even when the user declines the deletions question. The owner settled this while building #5: the previous Holding area is emptied only by an Update whose deletions are confirmed. Data accuracy comes first, so saying no to deletions must mean nothing on the Replica is destroyed.

## The rule

- **The main approval alone never touches the Holding area.** It copies new and changed files, and that is all.
- **Confirming deletions first empties the previous Holding area, then moves the new deletions in.** Its `READ ME.txt` is rewritten with the date of that Update.
- **The warning comes right before the deletions question.** It says how many files the Holding area holds and that confirming deletes them permanently. It is not shown when there are no deletions to confirm, since nothing will be emptied.
- **Comparing, declining, or an Update with nothing deleted never empties it.**

## Considered Options

- **Empty it on any approved Update** (the ticket's literal wording): keeps the Holding area to one Update's worth, but a file is destroyed after the user said no to deletions, and the only safeguard is a warning about a different question.

## Consequences

- A Holding area can last for several Updates. The `READ ME.txt` keeps the date of the Update that filled it, and says the files are deleted "at the next Update whose deletions you confirm".
- With nothing to copy, the deletions question is the only one asked, and it is also the only thing that can empty the Holding area. The two decisions no longer pull against each other.
