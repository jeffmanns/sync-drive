/**
 * Measures what reading each copy back from the drive (#33, ADR 0021) adds to an Update, per copy.
 * A developer script, not part of the app:
 *
 *   node scripts/read-back-timing.ts <folder on a drive> [files] [MB per file]
 *
 * Makes `files` files of random data (default 10 of 50 MB) on the Mac, copies each into a new folder
 * inside <folder> with the copy helper and reads it back, as an Update does: once with a plain read,
 * as before #33, and once from the drive itself. Prints the average read-back time per copy of each,
 * and the difference, which is what #33 costs. Removes everything it made, on the Mac and the drive.
 * Needs `npm run build` first, for the helper. Writes nothing else to the drive.
 */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sha256Hasher, type Hasher } from "../src/engine/index.ts";
import { MacFileCopier } from "../src/macos/file-copier.ts";
import { MacUncachedHasher } from "../src/macos/uncached-hasher.ts";

const [folder, filesArg = "10", megabytesArg = "50"] = process.argv.slice(2);
const files = Number(filesArg);
const megabytes = Number(megabytesArg);
if (folder === undefined || !(files > 0) || !(megabytes > 0)) {
  console.error("usage: node scripts/read-back-timing.ts <folder on a drive> [files] [MB per file]");
  process.exit(2);
}

const sources = await mkdtemp(join(tmpdir(), "sync-drive-read-back-timing-"));
const copies = join(folder, `sync-drive-read-back-timing-${process.pid}`);
try {
  await mkdir(copies);
  const copier = new MacFileCopier();
  for (let i = 0; i < files; i += 1) await writeFile(join(sources, `${i}.bin`), randomBytes(megabytes * 1_000_000));
  /**
   * Average seconds per copy to read freshly made copies back with `hasher`, as an Update does: each
   * file is copied, then read back, before the next.
   */
  const timeEach = async (hasher: Hasher, round: string) => {
    await mkdir(join(copies, round));
    let total = 0n;
    for (let i = 0; i < files; i += 1) {
      const copy = join(copies, round, `${i}.bin`);
      await copier.copy(join(sources, `${i}.bin`), copy);
      const started = process.hrtime.bigint();
      await hasher.checksum(copy);
      total += process.hrtime.bigint() - started;
    }
    await rm(join(copies, round), { recursive: true });
    return Number(total) / 1e9 / files;
  };
  const before = await timeEach(new Sha256Hasher(), "before");
  const fromDrive = await timeEach(new MacUncachedHasher(), "from-drive");
  const ms = (seconds: number) => `${(seconds * 1000).toFixed(1)} ms`;
  const rate = (seconds: number) => `${(megabytes / seconds).toFixed(0)} MB/s`;
  console.log(`${files} copies of ${megabytes} MB in ${folder}`);
  console.log(`Read back as before #33 (a plain read): ${ms(before)} per copy (${rate(before)})`);
  console.log(`Read back from the drive (#33):         ${ms(fromDrive)} per copy (${rate(fromDrive)})`);
  console.log(`Extra time per copy:                    ${ms(fromDrive - before)}`);
} finally {
  await rm(copies, { recursive: true, force: true });
  await rm(sources, { recursive: true, force: true });
}
