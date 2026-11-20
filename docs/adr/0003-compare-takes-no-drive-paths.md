# compare takes no drive paths

`compare` finds the Primary and the Replica among the connected drives by the volume IDs in the Pairing, and accepts no drive paths. The owner settled this while building Pairing (#3). Accepting paths and checking them against the Pairing would only add a way to name the drives wrongly. Without paths, the roles come from the volume IDs alone, so they can never be swapped. Later commands that act on the drives (Update, Deep verify, the benchmark) must find them the same way rather than take paths.

## Considered Options

- **Optional paths, checked against the Pairing**: refuses a swapped or unpaired drive with a clear message, but gains the user nothing over the Pairing and is one more input to get wrong.

## Consequences

- The issue's "refuse when the roles are swapped" criterion holds by construction rather than by a check.
- `pair` still takes the paths of the two drives. A guided flow that lists connected drives to choose from is tracked in #20.
