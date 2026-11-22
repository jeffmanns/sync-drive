import { sameDate } from "./same-date.ts";
import type { ScannedFile } from "./scan.ts";

/**
 * Pairs files only on the Primary with files only on the Replica that are the same file moved:
 * the same name, size and modification date, with no other file sharing all three on either side.
 * Returns the candidates, still to be confirmed by checksum: these are only files that look the same.
 */
export function findMoveCandidates(
  primaryOnly: ScannedFile[],
  replicaOnly: ScannedFile[],
): Array<{ primary: ScannedFile; replica: ScannedFile }> {
  const byName = (files: ScannedFile[]) => {
    const map = new Map<string, ScannedFile[]>();
    for (const file of files) {
      if (file.kind !== "file") continue;
      const key = `${nameOf(file.path)}\0${file.size}`;
      map.set(key, [...(map.get(key) ?? []), file]);
    }
    return map;
  };
  const replicaByName = byName(replicaOnly);
  const candidates: Array<{ primary: ScannedFile; replica: ScannedFile }> = [];
  for (const [key, primaries] of byName(primaryOnly)) {
    const replicas = replicaByName.get(key) ?? [];
    for (const primary of primaries) {
      const matches = replicas.filter((replica) => sameDate(primary.mtimeNs, replica.mtimeNs));
      // Ambiguous unless exactly one file on each side matches: then it falls back to new plus deleted.
      if (matches.length !== 1) continue;
      const replica = matches[0]!;
      const primaryMatches = primaries.filter((other) => sameDate(other.mtimeNs, replica.mtimeNs));
      if (primaryMatches.length !== 1) continue;
      candidates.push({ primary, replica });
    }
  }
  return candidates;
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
