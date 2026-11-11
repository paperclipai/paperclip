import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { MAX_ATTACHMENT_BYTES } from "../../attachment-types.js";
import type { NativeRunnerAttachmentStager } from "./native-runner-file-handoff.js";

const STAGE = String.raw`
const fs = require('node:fs/promises');
const { constants: C } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const fail = () => { throw new Error('attachment_staging_failed'); };
(async () => {
  const i = JSON.parse(process.argv[1]);
  if (process.platform !== 'linux') fail();
  const dirs = [];
  let file, owned = false;
  try {
    let dir = await fs.open('/', C.O_RDONLY | C.O_DIRECTORY); dirs.push(dir);
    for (const part of i.root.split('/').filter(Boolean)) {
      dir = await fs.open('/proc/self/fd/' + dir.fd + '/' + part, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      dirs.push(dir);
    }
    for (const part of ['.paperclip-inbound', i.slot]) {
      const name = '/proc/self/fd/' + dir.fd + '/' + part;
      if (i.phase === 'stage') await fs.mkdir(name, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
      try { dir = await fs.open(name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); }
      catch (e) { if (i.phase === 'cleanup' && e.code === 'ENOENT') { process.stdout.write('{}'); return; } throw e; }
      dirs.push(dir);
    }
    const parent = '/proc/self/fd/' + dir.fd;
    const expected = path.join(i.root, '.paperclip-inbound', i.slot);
    const checkParent = async () => { if (await fs.realpath(parent) !== expected) fail(); };
    await checkParent();
    const target = parent + '/' + i.filename;
    if (i.phase === 'stage') {
      const chunks = []; let size = 0;
      for await (const chunk of process.stdin) { size += chunk.length; if (size > 4 * Math.ceil(i.size / 3)) fail(); chunks.push(chunk); }
      const encoded = Buffer.concat(chunks).toString();
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length !== i.size || bytes.toString('base64') !== encoded || createHash('sha256').update(bytes).digest('hex') !== i.sha256) fail();
      file = await fs.open(target, C.O_RDWR | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
      owned = true;
      await file.writeFile(bytes); await file.sync();
      const verified = Buffer.alloc(bytes.length);
      let offset = 0;
      while (offset < verified.length) {
        const { bytesRead } = await file.read(verified, offset, verified.length - offset, offset);
        if (!bytesRead) fail(); offset += bytesRead;
      }
      if (createHash('sha256').update(verified).digest('hex') !== i.sha256) fail();
      const stat = await file.stat({ bigint: true });
      const at = await fs.lstat(target, { bigint: true });
      await checkParent();
      if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(i.size) || stat.dev !== at.dev || stat.ino !== at.ino) fail();
      process.stdout.write(JSON.stringify({ dev: String(stat.dev), ino: String(stat.ino) }));
      owned = false;
    } else if (i.phase === 'cleanup') {
      try { file = await fs.open(target, C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK); }
      catch (e) { if (e.code === 'ENOENT') { process.stdout.write('{}'); return; } throw e; }
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n) fail();
      if (i.identity) {
        if (String(stat.dev) !== i.identity.dev || String(stat.ino) !== i.identity.ino) fail();
      } else if (stat.size !== 0n) {
        if (stat.size !== BigInt(i.size) || createHash('sha256').update(await file.readFile()).digest('hex') !== i.sha256) fail();
      }
      await checkParent();
      await file.truncate(0); await file.sync();
      process.stdout.write('{}');
    } else fail();
  } finally {
    try { if (owned && file) { await file.truncate(0); await file.sync(); } }
    finally { if (file) await file.close(); for (const d of dirs.reverse()) await d.close(); }
  }
})().catch(() => { process.stderr.write('attachment_staging_failed'); process.exitCode = 1; });
`;

export function createRemoteAttachmentStager(
  workspaceRoot: string,
  runner: Pick<CommandManagedRuntimeRunner, "execute">,
): NativeRunnerAttachmentStager & { close(): Promise<void> } {
  const cleanups = new Set<() => Promise<void>>();
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  const write: NativeRunnerAttachmentStager = async ({ body, contentType }) => {
    if (closed) throw new Error("paperclip_runner_attachment_staging_scope_closed");
    if (!posix.isAbsolute(workspaceRoot) || posix.normalize(workspaceRoot) !== workspaceRoot
      || /[\u0000-\u001f\u007f\\]/u.test(workspaceRoot) || workspaceRoot === "/"
      || body.length > MAX_ATTACHMENT_BYTES) throw new Error("paperclip_runner_attachment_staging_path_denied");
    const slot = `remote-${randomUUID()}`;
    const extensions: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "application/pdf": ".pdf" };
    const filename = `content${extensions[contentType ?? ""] ?? ""}`;
    const sha256 = createHash("sha256").update(body).digest("hex");
    let identity: { dev: string; ino: string } | undefined;
    const run = async (phase: "stage" | "cleanup") => {
      const result = await runner.execute({
        command: "node", args: ["--input-type=commonjs", "-e", STAGE,
          JSON.stringify({ root: workspaceRoot, slot, filename, size: body.length, sha256, phase, identity })],
        cwd: workspaceRoot, env: { NODE_OPTIONS: "", NODE_PATH: "" },
        stdin: phase === "stage" ? body.toString("base64") : undefined,
        timeoutMs: 30_000, bypassSession: true,
      }).catch(() => { throw new Error("paperclip_runner_attachment_staging_failed"); });
      if (result.timedOut || result.exitCode !== 0) throw new Error("paperclip_runner_attachment_staging_failed");
      try { return JSON.parse(result.stdout) as { dev?: string; ino?: string }; }
      catch { throw new Error("paperclip_runner_attachment_staging_failed"); }
    };
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      await run("cleanup");
      cleaned = true;
      cleanups.delete(cleanup);
    };
    cleanups.add(cleanup);
    try {
      const result = await run("stage");
      if (typeof result.dev !== "string" || typeof result.ino !== "string"
        || !/^\d+$/.test(result.dev) || !/^\d+$/.test(result.ino)) throw new Error("paperclip_runner_attachment_staging_failed");
      identity = { dev: result.dev, ino: result.ino };
      if (closed) throw new Error("paperclip_runner_attachment_staging_scope_closed");
      return { workspaceRelativePath: `.paperclip-inbound/${slot}/${filename}`, cleanup };
    } catch {
      await cleanup();
      throw new Error("paperclip_runner_attachment_staging_failed");
    }
  };
  const stage: NativeRunnerAttachmentStager = input => {
    const result = write(input);
    pending.add(result);
    void result.finally(() => pending.delete(result)).catch(() => undefined);
    return result;
  };
  return Object.assign(stage, { close: async () => {
    closed = true;
    await Promise.allSettled([...pending]);
    const results = await Promise.allSettled([...cleanups].map(cleanup => cleanup()));
    if (results.some(result => result.status === "rejected")) throw new Error("paperclip_runner_attachment_staging_cleanup_failed");
  } });
}
