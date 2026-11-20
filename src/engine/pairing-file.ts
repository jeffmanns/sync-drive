import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Pairing, PairedVolume } from "./pairing.ts";

/** Reads the Pairing stored in `file`, or `undefined` if the drives have not been paired. */
export async function readPairing(file: string): Promise<Pairing | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (!isRecord(data) || !isPairedVolume(data.primary) || !isPairedVolume(data.replica)) {
    throw new Error(`The Pairing in ${file} is damaged. Pair the drives again with \`sync-drive pair <primary> <replica> --replace\`.`);
  }
  return { primary: pick(data.primary), replica: pick(data.replica) };
}

/** Stores `pairing` in `file`, replacing any earlier Pairing. A half-written file is never left behind. */
export async function writePairing(file: string, pairing: Pairing): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const partial = `${file}.partial`;
  await writeFile(partial, JSON.stringify(pairing, null, 2) + "\n");
  await rename(partial, file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPairedVolume(value: unknown): value is PairedVolume {
  return isRecord(value) && typeof value.id === "string" && value.id !== "" && typeof value.name === "string";
}

function pick(volume: PairedVolume): PairedVolume {
  return { id: volume.id, name: volume.name };
}
