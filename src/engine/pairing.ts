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

/** Where the user says the drives are, as the paths of their top levels. */
export interface GivenDrives {
  primary: string;
  replica: string;
}

/**
 * Finds the paired Primary and Replica by volume ID alone, so renaming a drive does not matter.
 * Without `given`, looks among the connected drives and rejects if either is not connected.
 * With `given`, checks that the drives at those paths are the paired ones, in the right roles.
 */
export async function findPairedDrives(
  pairing: Pairing,
  volumes: VolumeIdentity,
  given?: GivenDrives,
): Promise<PairedDrives> {
  return given === undefined ? findConnected(pairing, volumes) : checkGiven(pairing, volumes, given);
}

async function findConnected(pairing: Pairing, volumes: VolumeIdentity): Promise<PairedDrives> {
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

async function checkGiven(pairing: Pairing, volumes: VolumeIdentity, given: GivenDrives): Promise<PairedDrives> {
  const [primary, replica] = await Promise.all([volumes.volumeAt(given.primary), volumes.volumeAt(given.replica)]);
  if (primary.id === pairing.replica.id && replica.id === pairing.primary.id) {
    throw new Error(
      `The Primary and the Replica are swapped: ${given.primary} is ${describe("Replica", pairing.replica)} ` +
        `and ${given.replica} is ${describe("Primary", pairing.primary)}. Give the Primary first.`,
    );
  }
  for (const [role, path, found, expected] of [
    ["Primary", given.primary, primary, pairing.primary],
    ["Replica", given.replica, replica, pairing.replica],
  ] as const) {
    if (found.id !== expected.id) {
      throw new Error(
        `${path} is not the paired ${role}: it is "${found.name}" (volume ID ${found.id}). ` +
          `${capitalise(describe(role, expected))} is the paired one. ${REPAIR_HINT}`,
      );
    }
  }
  return { primary, replica };
}

const REPAIR_HINT =
  "If a drive has been replaced, pair the drives again with `sync-drive pair <primary> <replica> --replace`.";

/** How a paired drive is named in messages: its role, its name when paired, and its volume ID. */
function describe(role: "Primary" | "Replica", volume: PairedVolume): string {
  return `the ${role} "${volume.name}" (volume ID ${volume.id})`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
