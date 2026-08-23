// The session-home inspection helper. The provider runs it in the sandbox as
// `node -e <this file> <path>`. The sandbox already runs node for the Paperclip
// bridge, so the helper needs no extra runtime.
//
// The helper opens the filesystem root, then walks each ancestor of the final
// path component with a no-follow, directory-only open. Node has no `openat`, so
// the helper opens each next component through `/proc/self/fd/<dfd>/<component>`:
// the kernel resolves the magic descriptor link, then applies `O_NOFOLLOW` to the
// final component. This binds each open to the descriptor inode, so a symlink at
// any ancestor fails closed. The helper reads the final component with `lstat`, so
// a symlink at the target reports the link, not the target.
//
// The helper prints one line and sets one exit code:
// - a missing ancestor or a missing final component prints `ABSENT` and exits 0;
// - an existing final component prints `<type>|<octal-mode>|<uid>` and exits 0,
//   where `<type>` is `symlink`, `directory`, or `other`;
// - a symlink or a non-directory at any ancestor prints nothing and exits 3, so
//   the caller fails closed on an ancestor symlink.

"use strict";

const fs = require("node:fs");

const path = process.argv[1];
if (typeof path !== "string" || !path.startsWith("/")) process.exit(3);
const parts = path.split("/").filter((component) => component.length > 0);
if (parts.length === 0) process.exit(3);

function absent() {
  process.stdout.write("ABSENT");
  process.exit(0);
}

let dfd;
try {
  dfd = fs.openSync("/", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
} catch {
  process.exit(3);
}
for (const part of parts.slice(0, -1)) {
  try {
    dfd = fs.openSync(
      `/proc/self/fd/${dfd}/${part}`,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error && error.code === "ENOENT") absent();
    process.exit(3);
  }
}

const last = parts[parts.length - 1];
let st;
try {
  st = fs.lstatSync(`/proc/self/fd/${dfd}/${last}`);
} catch (error) {
  if (error && error.code === "ENOENT") absent();
  process.exit(3);
}

let fileType;
if (st.isSymbolicLink()) fileType = "symlink";
else if (st.isDirectory()) fileType = "directory";
else fileType = "other";
process.stdout.write(`${fileType}|${(st.mode & 0o7777).toString(8)}|${st.uid}`);
process.exit(0);
