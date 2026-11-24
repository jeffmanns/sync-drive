import type { Volume, VolumeIdentity } from "./volumes.ts";

/** One side of a Pairing. */
export interface PairedVolume {
  /** The volume ID that recognises the drive. */
  id: string;
  /** The drive's name when it was paired, for messages only. */
  name: string;
}

/** The remembered designation of one volume as the Primary and another as the Replica. */
export interface Pairing {
  primary: PairedVolume;
  replica: PairedVolume;
}

/** Pairs the drives whose top levels are `primary` and `replica`. Rejects if they are the same drive. */
export async function pair(primary: string, replica: string, volumes: VolumeIdentity): Promise<Pairing> {
  const [p, r] = await Promise.all([volumes.volumeAt(primary), volumes.volumeAt(replica)]);
  if (p.id === r.id) {
    throw new Error(`${primary} and ${replica} are the same drive (volume ID ${p.id}); the Primary and the Replica must be two different drives`);
  }
  return { primary: { id: p.id, name: p.name }, replica: { id: r.id, name: r.name } };
}

/** The connected drives that a Pairing designates. */
export interface PairedDrives {
  primary: Volume;
  replica: Volume;
}

/**
 * Finds the paired Primary and Replica among the connected drives, by volume ID alone, so
 * renaming a drive does not matter and the roles can never be swapped. Rejects if either drive
 * is not connected.
 */
export async function findPairedDrives(pairing: Pairing, volumes: VolumeIdentity): Promise<PairedDrives> {
  const connected = await volumes.connected();
  const primary = onlyMatch("Primary", pairing.primary, connected);
  const replica = onlyMatch("Replica", pairing.replica, connected);
  const missing = [
    ...(primary === undefined ? [describe("Primary", pairing.primary)] : []),
    ...(replica === undefined ? [describe("Replica", pairing.replica)] : []),
  ];
  if (primary === undefined || replica === undefined) {
    throw new Error(`${capitalise(missing.join(" and "))} ${missing.length === 1 ? "is" : "are"} not connected. ${REPAIR_HINT}`);
  }
  return { primary, replica };
}

/**
 * The paired Replica among the connected drives, by volume ID alone, or `undefined` if it is not
 * connected. Rejects, as `findPairedDrives` does, if more than one drive has its volume ID.
 */
export async function findPairedReplica(pairing: Pairing, volumes: VolumeIdentity): Promise<Volume | undefined> {
  return onlyMatch("Replica", pairing.replica, await volumes.connected());
}

/**
 * The connected drive with the paired volume's ID, if any. Rejects if there is more than one
 * (e.g. a block-level clone), since either could be the wrong drive.
 */
function onlyMatch(role: "Primary" | "Replica", paired: PairedVolume, connected: Volume[]): Volume | undefined {
  const matches = connected.filter((volume) => volume.id === paired.id);
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} connected drives have the volume ID of ${describe(role, paired)}: ` +
        `${matches.map((volume) => volume.mountPoint).join(", ")}. Connect only the paired one.`,
    );
  }
  return matches[0];
}

const REPAIR_HINT = "If a drive has been replaced, use Re-pair on Start.";

/** How a paired drive is named in messages: its role, its name when paired, and its volume ID. */
function describe(role: "Primary" | "Replica", volume: PairedVolume): string {
  return `the ${role} "${volume.name}" (volume ID ${volume.id})`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
