/*
 * copy-with-metadata <source> <destination>
 *
 * Copies one regular file with all of its macOS metadata, for sync-drive's Update.
 * See docs/adr/0005-copying-with-all-metadata.md for why this exists.
 *
 *   1. copyfile(3) with COPYFILE_ALL copies the data, extended attributes (including Finder
 *      tags and the resource fork), ACLs, permissions, file flags, and the modification and
 *      access dates to the nanosecond. COPYFILE_EXCL refuses to overwrite anything, and
 *      COPYFILE_NOFOLLOW never follows a shortcut (symbolic link).
 *   2. copyfile(3) does not copy the creation date, so it is set with setattrlist(2).
 *   3. F_FULLFSYNC makes sure the data is on the drive itself before this exits, so the file
 *      can safely be renamed into place afterwards.
 *
 * Reads the source only. On any failure the destination is removed and the exit status is 1,
 * with the reason on stderr.
 */
#include <copyfile.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/attr.h>
#include <sys/stat.h>
#include <unistd.h>

static int fail(const char *step, const char *destination, int created) {
  int error = errno;
  if (created) unlink(destination);
  fprintf(stderr, "%s: %s\n", step, strerror(error));
  return 1;
}

int main(int argc, char *argv[]) {
  if (argc != 3) {
    fprintf(stderr, "usage: copy-with-metadata <source> <destination>\n");
    return 2;
  }
  const char *source = argv[1];
  const char *destination = argv[2];

  struct stat source_stat;
  if (lstat(source, &source_stat) != 0) return fail("reading the file on the Primary", destination, 0);
  if (!S_ISREG(source_stat.st_mode)) {
    fprintf(stderr, "reading the file on the Primary: not a regular file\n");
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

  int fd = open(destination, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return fail("opening the copy", destination, 1);
  if (fcntl(fd, F_FULLFSYNC) != 0 && fsync(fd) != 0) {
    close(fd);
    return fail("flushing the copy to the drive", destination, 1);
  }
  if (close(fd) != 0) return fail("closing the copy", destination, 1);
  return 0;
}
