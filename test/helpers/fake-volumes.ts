import { basename } from "node:path";
import type { Volume, VolumeIdentity } from "../../src/engine/index.ts";

/**
 * Stands in for macOS in tests: each connected "drive" is a temporary directory mapped to a
 * chosen volume ID. Its name is the directory's last component.
 */
export class FakeVolumes implements VolumeIdentity {
  readonly #idByPath = new Map<string, string>();

  constructor(idByPath: Record<string, string> = {}) {
    for (const [path, id] of Object.entries(idByPath)) this.connect(path, id);
  }

  /** Connects a drive at `path` with volume ID `id`. */
  connect(path: string, id: string): void {
    this.#idByPath.set(path, id);
  }

  /** Disconnects the drive at `path`. */
  disconnect(path: string): void {
    this.#idByPath.delete(path);
  }

  async volumeAt(path: string): Promise<Volume> {
    const id = this.#idByPath.get(path);
    if (id === undefined) throw new Error(`${path} is not the top level of a connected drive`);
    return { id, name: basename(path), mountPoint: path };
  }

  async connected(): Promise<Volume[]> {
    return [...this.#idByPath].map(([path, id]) => ({ id, name: basename(path), mountPoint: path }));
  }
}
