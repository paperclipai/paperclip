import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

export const MAX_REMOTE_DELIVERABLE_BYTES = 10 * 1024 * 1024;
const PREFIX = "paperclip_runner_file_handoff_";
const READ_TIMEOUT_MS = 10_000;

// Runs only in the server-bound remote workspace. No file is opened on the
// controller and no bytes are emitted until confinement and identity pass.
const READ_REMOTE_FILE = String.raw`
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fail = code => { throw new Error('paperclip_runner_file_handoff_' + code); };
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative);
};
async function noSymlinks(root, relative) {
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink()) fail('symlink_denied');
  }
}
(async () => {
  const input = JSON.parse(process.argv[1]);
  const root = await fs.realpath(input.workspaceRoot);
  if (!(await fs.stat(root)).isDirectory()) fail('path_denied');
  const relative = path.normalize(input.contentRef);
  const candidate = path.resolve(root, relative);
  if (!within(root, candidate)) fail('path_denied');
  await noSymlinks(root, relative);
  const canonical = await fs.realpath(candidate);
  if (!within(root, canonical)) fail('path_denied');
  const pathBefore = await fs.lstat(canonical, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.nlink !== 1n) fail('file_changed');
  const handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(input.byteSize) || !same(before, pathBefore)) fail('file_changed');
    const descriptor = await fs.realpath('/proc/self/fd/' + handle.fd);
    if (!within(root, descriptor) || descriptor !== canonical) fail('path_denied');
    const body = Buffer.allocUnsafe(input.byteSize);
    let offset = 0;
    while (offset < body.length) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const overflow = await handle.read(Buffer.allocUnsafe(1), 0, 1, body.length);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await fs.lstat(canonical, { bigint: true });
    const reopened = await fs.realpath(candidate);
    const rootAfter = await fs.realpath(input.workspaceRoot);
    await noSymlinks(root, relative);
    if (rootAfter !== root || descriptor !== reopened || after.nlink !== 1n || !same(before, after) ||
        pathAfter.isSymbolicLink() || !same(after, pathAfter) || offset !== input.byteSize || overflow.bytesRead) fail('file_changed');
    if (createHash('sha256').update(body).digest('hex') !== input.sha256) fail('hash_mismatch');
    await new Promise((resolve, reject) => process.stdout.write(body.toString('base64'), error => error ? reject(error) : resolve()));
  } finally { await handle.close(); }
})().catch(error => {
  const allowed = /^paperclip_runner_file_handoff_(path_denied|symlink_denied|file_changed|hash_mismatch)$/;
  process.stderr.write(allowed.test(error.message) ? error.message : 'paperclip_runner_file_handoff_remote_read_failed');
  process.exitCode = 1;
});
`;

/** The caller supplies the authorized lease runner and remote workspace root. */
export async function readVerifiedRemoteWorkspaceFile(input: {
  runner: Pick<CommandManagedRuntimeRunner, "execute">;
  workspaceRoot: string;
  contentRef: string;
  byteSize: number;
  sha256: string;
}): Promise<Buffer> {
  const { workspaceRoot, contentRef, byteSize } = input;
  if (typeof workspaceRoot !== "string" || !posix.isAbsolute(workspaceRoot) || workspaceRoot.length > 4096 ||
      typeof contentRef !== "string" || !contentRef.trim() || contentRef.length > 2000 ||
      /[\u0000-\u001f\u007f]/u.test(workspaceRoot + contentRef) || posix.isAbsolute(contentRef) ||
      /^[a-z][a-z0-9+.-]*:/iu.test(contentRef) || contentRef.includes("\\")) {
    throw new Error(`${PREFIX}path_denied`);
  }
  const relative = posix.normalize(contentRef);
  if (relative === "." || relative === ".." || relative.startsWith("../")) throw new Error(`${PREFIX}path_denied`);
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0 || byteSize > MAX_REMOTE_DELIVERABLE_BYTES) {
    throw new Error(`${PREFIX}size_denied`);
  }
  const sha256 = typeof input.sha256 === "string" ? input.sha256.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error(`${PREFIX}invalid_sha256`);
  const result = await input.runner.execute({
    command: "node",
    args: ["--input-type=commonjs", "-e", READ_REMOTE_FILE, JSON.stringify({ workspaceRoot, contentRef: relative, byteSize, sha256 })],
    cwd: workspaceRoot,
    env: { NODE_OPTIONS: "", NODE_PATH: "" },
    timeoutMs: READ_TIMEOUT_MS,
    bypassSession: true,
  }).catch(() => { throw new Error(`${PREFIX}remote_read_failed`); });
  if (result.timedOut) throw new Error(`${PREFIX}remote_read_timeout`);
  if (result.exitCode !== 0) {
    const code = result.stderr.trim();
    throw new Error(/^paperclip_runner_file_handoff_(path_denied|symlink_denied|file_changed|hash_mismatch)$/u.test(code)
      ? code : `${PREFIX}remote_read_failed`);
  }
  const encoded = result.stdout;
  if (encoded.length !== 4 * Math.ceil(byteSize / 3)) throw new Error(`${PREFIX}size_denied`);
  const body = Buffer.from(encoded, "base64");
  if (body.length !== byteSize || body.toString("base64") !== encoded) throw new Error(`${PREFIX}size_denied`);
  if (createHash("sha256").update(body).digest("hex") !== sha256) throw new Error(`${PREFIX}hash_mismatch`);
  return body;
}
