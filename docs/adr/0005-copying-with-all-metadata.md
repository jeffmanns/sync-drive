# Copying with all metadata: a native helper, not Node's copyFile

An Update must copy files so that every piece of macOS metadata is kept: modification and creation dates, Finder tags, other extended attributes, permissions and file flags. Otherwise the next Quick compare would report the copies as changed, and the Replica would not be an exact copy. ADR 0001 left open whether Node's built-in copy does this. It does not, and no macOS copy tool keeps the creation date either. So Update copies through a small native helper, `native/copy-with-metadata.c`, that `npm run build` compiles with `clang`. This was settled while building Update (#4).

## Findings, from primary sources

- **Node's `fs.copyFile` (and `fs.cp`) hands the work to libuv's `uv_fs_copyfile`.** Node v26.13.1, [`src/node_file.cc`](https://github.com/nodejs/node/blob/v26.13.1/src/node_file.cc) (`CopyFile`, and `CopyFileFresh` for `cp`). It bundles libuv 1.52.1 ([`deps/uv/include/uv/version.h`](https://github.com/nodejs/node/blob/v26.13.1/deps/uv/include/uv/version.h)).
- **libuv 1.52.1 does not use macOS's `copyfile(3)`.** [`src/unix/fs.c`, `uv__fs_copyfile`](https://github.com/libuv/libuv/blob/v1.52.1/src/unix/fs.c) opens both files, sets the access and modification dates with `futimens`, sets the owner and permissions with `fchown`/`fchmod`, *then* copies the data with `sendfile`. So it copies no extended attributes (Finder tags included), no file flags and no creation date. Because the data is written after the dates are set, the copy's modification date also ends up as the time of copying.
- **macOS's `copyfile(3)` with `COPYFILE_ALL` copies the data, extended attributes, ACLs, permissions, flags, and the access and modification dates, but not the creation date.** Apple's [`copyfile.c`](https://github.com/apple-oss-distributions/copyfile/blob/main/copyfile.c) (`copyfile_stat`) sets only `ATTR_CMN_MODTIME | ATTR_CMN_ACCTIME` with `fsetattrlist`. The [man page](https://github.com/apple-oss-distributions/copyfile/blob/main/copyfile.3) describes `COPYFILE_STAT` as "POSIX information (mode, modification time, etc.)". `cp -p` and `ditto` are built on it and behave the same way.
- **The creation date can only be set exactly with `setattrlist(2)` and `ATTR_CMN_CRTIME`.** `utimes` moves the creation date back when it sets an earlier modification date, but it can never set a creation date later than the modification date.

Checked on this Mac (macOS 15, Node v26.13.1) by copying one file between two APFS disk images:

| Copy made with | Modification date | Creation date | Finder tags and other extended attributes | Flags |
| --- | --- | --- | --- | --- |
| Node `fs.copyFile` | time of copying | lost | lost | lost |
| `cp -p`, `ditto` | kept to the nanosecond | set to the modification date | kept | kept |
| `copy-with-metadata` | kept to the nanosecond | kept to the nanosecond | kept | kept |

## The decision

`copy-with-metadata <source> <destination>` calls `copyfile(3)` with `COPYFILE_ALL | COPYFILE_EXCL | COPYFILE_NOFOLLOW`. It then sets the creation date with `setattrlist(ATTR_CMN_CRTIME)` and flushes the copy to the drive with `F_FULLFSYNC` before it exits. It never overwrites an existing file and never follows a shortcut. The engine reaches it only through its `FileCopier` interface (the macOS side is `src/macos/file-copier.ts`), so tests can substitute a copier that fails part-way.

Update also writes each copy under a temporary name in a hidden `.sync-drive-incoming` folder at the top level of the Replica, then renames it into place. The folder is on the same drive, so the rename is atomic, and an interrupted run never leaves a truncated file under a real name. The next Update empties the folder, and comparisons never show it.

## Considered Options

- **Node's `fs.copyFile` or `fs.cp`**: loses metadata, as above.
- **`cp -p` or `ditto`, then fix the creation date with `utimes`**: cannot set a creation date later than the modification date, so some files would come out wrong.
- **Node's `node:ffi` to call `copyfile(3)` and `setattrlist(2)` directly**: needs no compiler and no process per file, but it is experimental in Node 26 ("might change at any time"). Data accuracy comes first, so the write path does not depend on it. It can be reconsidered once it is stable, together with the per-file process cost.
- **A Node native addon**: needs node-gyp and Node's headers, which is more build machinery than one small C file.

## Consequences

- Building needs `clang`: the Command Line Tools locally, and Xcode on the CI runner. `npm run build` (and so `npm test`) compiles the helper into `dist/libexec/`.
- Each copied file starts one process, and `F_FULLFSYNC` waits for the drive. Both cost time on many small files. Performance work (#12) can batch the helper or move to FFI, as long as the tests in `test/update.test.ts` still pass.
- When a Primary file's name differs from its Replica counterpart only by letter case, the copy replaces the Replica file but keeps the Replica's spelling (ADR 0002 ignores case).
