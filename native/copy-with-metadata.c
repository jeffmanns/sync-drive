/*
 * copy-with-metadata <source> <destination>
 *
 * Copies one regular file or shortcut (symbolic link) with all of its macOS metadata, for
 * sync-drive's Update. See docs/adr/0005-copying-with-all-metadata.md for why this exists.
 * A shortcut is copied as a shortcut with the same target, never followed (#10).
 *
 *   1. copyfile(3) with COPYFILE_ALL copies the data, extended attributes (including Finder
 *      tags and the resource fork), ACLs, permissions, file flags, and the modification and
 *      access dates to the nanosecond. COPYFILE_EXCL refuses to overwrite anything, and
 *      COPYFILE_NOFOLLOW never follows a shortcut: it copies the shortcut itself.
 *   2. copyfile(3) does not copy the creation date, so it is set with setattrlist(2).
 *   3. F_FULLFSYNC makes sure the data is on the drive itself before this exits, so the file
 *      can safely be renamed into place afterwards.
 *
 * Reads the source only. On any failure the destination is removed and the exit status is 1,
 * with the reason on stderr.
 *
 * copy-with-metadata --read-from-drive <file>
 *
 * Writes the regular file's contents to stdout, read from the drive itself rather than from the
 * copies of its pages macOS keeps in memory (#33, docs/adr/0021-copies-are-read-back-from-the-drive.md).
 * Update hashes this to check a copy it has just written. F_NOCACHE alone is not enough: XNU still
 * serves pages that are already in memory. So each part, in turn, has its pages dropped from memory
 * with msync(MS_INVALIDATE), is confirmed absent with mincore(2), is read with F_NOCACHE (which puts
 * nothing in memory), and is confirmed absent again. A page found in memory before or after the read
 * means another app read the file meanwhile, and this read may have come from memory: the part is
 * read again, and after a few tries the file fails. Never follows a shortcut. Never writes to the
 * file: dropping a page that has not reached the drive yet writes it there first.
 *
 * copy-with-metadata --pages-in-memory <file>
 *
 * Prints how many of the regular file's pages are in memory, and how many it has, as
 * "<in memory> <total>". For tests and checks; it reads and changes nothing.
 */
#include <copyfile.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/attr.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

/** Size of each part read back: a multiple of the page size, and large enough to keep a drive streaming. */
#define PART_BYTES (1024 * 1024)
/** How many times a part is read again when another app keeps bringing its pages into memory. */
#define TRIES 5

static int fail(const char *step, const char *destination, int created) {
  int error = errno;
  if (created) unlink(destination);
  fprintf(stderr, "%s: %s\n", step, strerror(error));
  return 1;
}

static int failed(const char *step) {
  fprintf(stderr, "%s: %s\n", step, strerror(errno));
  return 1;
}

/**
 * Opens the regular file at `path` for reading, never following a shortcut, and maps it (unless it
 * is empty) so its pages can be looked up. The mapping is never touched, so it brings nothing into memory.
 */
static int open_mapped(const char *path, int *fd, char **map, off_t *size) {
  *fd = open(path, O_RDONLY | O_NOFOLLOW);
  if (*fd < 0) {
    if (errno == ELOOP) {
      fprintf(stderr, "reading the copy: not a regular file\n");
      return 1;
    }
    return failed("reading the copy");
  }
  struct stat file_stat;
  if (fstat(*fd, &file_stat) != 0) return failed("reading the copy");
  if (!S_ISREG(file_stat.st_mode)) {
    fprintf(stderr, "reading the copy: not a regular file\n");
    return 1;
  }
  *size = file_stat.st_size;
  *map = NULL;
  if (*size == 0) return 0;
  *map = mmap(NULL, (size_t)*size, PROT_READ, MAP_SHARED, *fd, 0);
  if (*map == MAP_FAILED) return failed("reading the copy");
  return 0;
}

/** How many pages of `length` bytes at `at`, a page-aligned address in a mapping, are in memory, or -1. */
static long in_memory(char *at, size_t length) {
  size_t page = (size_t)getpagesize();
  size_t pages = (length + page - 1) / page;
  char *vector = malloc(pages);
  if (vector == NULL || mincore(at, length, vector) != 0) {
    free(vector);
    return -1;
  }
  long count = 0;
  for (size_t i = 0; i < pages; i++) count += (vector[i] & MINCORE_INCORE) ? 1 : 0;
  free(vector);
  return count;
}

static int pages_in_memory(const char *path) {
  int fd;
  char *map;
  off_t size;
  if (open_mapped(path, &fd, &map, &size) != 0) return 1;
  size_t page = (size_t)getpagesize();
  long count = size == 0 ? 0 : in_memory(map, (size_t)size);
  if (count < 0) return failed("looking up the copy's pages");
  printf("%ld %lld\n", count, (long long)(((size_t)size + page - 1) / page));
  return 0;
}

/** Reads `length` bytes at `offset` into `buffer`. Returns 0, or 1 if the file ended first or could not be read. */
static int read_part(int fd, char *buffer, size_t length, off_t offset) {
  size_t done = 0;
  while (done < length) {
    ssize_t got = pread(fd, buffer + done, length - done, offset + (off_t)done);
    if (got < 0 && errno == EINTR) continue;
    if (got < 0) return failed("reading the copy back from the drive");
    if (got == 0) {
      fprintf(stderr, "reading the copy back from the drive: it got shorter while it was read\n");
      return 1;
    }
    done += (size_t)got;
  }
  return 0;
}

static int write_out(const char *buffer, size_t length) {
  size_t done = 0;
  while (done < length) {
    ssize_t put = write(STDOUT_FILENO, buffer + done, length - done);
    if (put < 0 && errno == EINTR) continue;
    if (put < 0) return failed("passing on the copy's contents");
    done += (size_t)put;
  }
  return 0;
}

static int read_from_drive(const char *path) {
  int fd;
  char *map;
  off_t size;
  if (open_mapped(path, &fd, &map, &size) != 0) return 1;
  // Every read on this file goes to the drive when the pages it wants are not in memory, and leaves none there.
  if (fcntl(fd, F_NOCACHE, 1) != 0) return failed("reading the copy back from the drive");
  char *buffer;
  // Page-aligned, so XNU reads straight from the drive into it (cluster_read_direct).
  if (posix_memalign((void **)&buffer, (size_t)getpagesize(), PART_BYTES) != 0) return failed("reading the copy back from the drive");
  for (off_t offset = 0; offset < size; offset += PART_BYTES) {
    size_t length = (size_t)(size - offset < PART_BYTES ? size - offset : PART_BYTES);
    int from_drive = 0;
    for (int try = 0; try < TRIES && !from_drive; try++) {
      // Drops this part's pages from memory, first writing any not yet on the drive.
      if (msync(map + offset, length, MS_SYNC | MS_INVALIDATE) != 0) return failed("dropping the copy's pages from memory");
      long before = in_memory(map + offset, length);
      if (before < 0) return failed("looking up the copy's pages");
      if (before > 0) continue;
      if (read_part(fd, buffer, length, offset) != 0) return 1;
      long after = in_memory(map + offset, length);
      if (after < 0) return failed("looking up the copy's pages");
      from_drive = after == 0;
    }
    if (!from_drive) {
      fprintf(stderr, "reading the copy back from the drive: another app kept reading it, so it could only be read from memory\n");
      return 1;
    }
    if (write_out(buffer, length) != 0) return 1;
  }
  return 0;
}

int main(int argc, char *argv[]) {
  if (argc == 3 && strcmp(argv[1], "--read-from-drive") == 0) return read_from_drive(argv[2]);
  if (argc == 3 && strcmp(argv[1], "--pages-in-memory") == 0) return pages_in_memory(argv[2]);
  if (argc != 3 || argv[1][0] == '-') {
    fprintf(stderr, "usage: copy-with-metadata <source> <destination>\n"
                    "       copy-with-metadata --read-from-drive <file>\n"
                    "       copy-with-metadata --pages-in-memory <file>\n");
    return 2;
  }
  const char *source = argv[1];
  const char *destination = argv[2];

  struct stat source_stat;
  if (lstat(source, &source_stat) != 0) return fail("reading the file on the Primary", destination, 0);
  int is_shortcut = S_ISLNK(source_stat.st_mode);
  if (!S_ISREG(source_stat.st_mode) && !is_shortcut) {
    fprintf(stderr, "reading the file on the Primary: not a regular file or shortcut\n");
    return 1;
  }

  if (copyfile(source, destination, NULL, COPYFILE_ALL | COPYFILE_EXCL | COPYFILE_NOFOLLOW) != 0) {
    // With COPYFILE_EXCL, EEXIST means the destination was someone else's: leave it alone.
    return fail("copying", destination, errno != EEXIST);
  }

  // Changing the creation date does not change the modification date that copyfile set.
  struct attrlist attributes = {.bitmapcount = ATTR_BIT_MAP_COUNT, .commonattr = ATTR_CMN_CRTIME};
  struct timespec created = source_stat.st_birthtimespec;
  if (setattrlist(destination, &attributes, &created, sizeof(created), FSOPT_NOFOLLOW) != 0) {
    return fail("setting the creation date", destination, 1);
  }

  // O_SYMLINK opens a shortcut itself, so it is flushed without being followed.
  int fd = open(destination, O_RDONLY | (is_shortcut ? O_SYMLINK : O_NOFOLLOW));
  if (fd < 0) return fail("opening the copy", destination, 1);
  if (fcntl(fd, F_FULLFSYNC) != 0 && fsync(fd) != 0) {
    close(fd);
    return fail("flushing the copy to the drive", destination, 1);
  }
  if (close(fd) != 0) return fail("closing the copy", destination, 1);
  return 0;
}
