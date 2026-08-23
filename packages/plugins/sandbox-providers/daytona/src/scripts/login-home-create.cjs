// The session-home creation helper. The provider runs it in the sandbox as
// `node -e <this file> <path> <octal-mode>`. The sandbox already runs node for the
// Paperclip bridge, so the helper needs no extra runtime.
//
// The helper opens the filesystem root, then walks each ancestor above the login
// root with a no-follow, directory-only open. Node has no `openat`, so the helper
// opens each next component through `/proc/self/fd/<dfd>/<component>`: the kernel
// resolves the magic descriptor link, then applies `O_NOFOLLOW` to the final
// component. It creates the login root (the second-to-last component) if the root
// is absent, then opens the root with a no-follow open, so a symlink at the root
// fails closed. It creates the final component as a NEW directory relative to the
// root descriptor, so a pre-existing target fails and the create never follows a
// symlink. It exits 0 on success and non-zero on every failure.
//
// The no-follow open of the root after the create closes the swap window: an
// attacker that replaces the root with a symlink between the create and the open
// fails the open.

"use strict";

const fs = require("node:fs");

const path = process.argv[1];
const mode = Number.parseInt(process.argv[2], 8);
if (typeof path !== "string" || !path.startsWith("/")) process.exit(1);
if (!Number.isInteger(mode)) process.exit(1);
const parts = path.split("/").filter((component) => component.length > 0);
if (parts.length < 2) process.exit(1);

let dfd;
try {
  dfd = fs.openSync("/", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
} catch {
  process.exit(1);
}
for (const part of parts.slice(0, -2)) {
  try {
    dfd = fs.openSync(
      `/proc/self/fd/${dfd}/${part}`,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    process.exit(1);
  }
}

const root = parts[parts.length - 2];
try {
  fs.mkdirSync(`/proc/self/fd/${dfd}/${root}`, { mode: 0o700 });
} catch (error) {
  if (!error || error.code !== "EEXIST") process.exit(1);
}

let rfd;
try {
  rfd = fs.openSync(
    `/proc/self/fd/${dfd}/${root}`,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
} catch {
  process.exit(1);
}

try {
  fs.mkdirSync(`/proc/self/fd/${rfd}/${parts[parts.length - 1]}`, { mode });
} catch {
  process.exit(1);
}
process.exit(0);
