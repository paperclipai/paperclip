/**
 * Real Linux process/HTTP acceptance. Bundle with esbuild and run using node
 * --test in an isolated, unprivileged container with --init. No provider, model,
 * credentials, network access, host process namespace or repository mount needed.
 * The bundle includes the production handoff implementation without mocks.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readProcessStartedAt } from "../../server/src/services/hot-restart.js";
import { createLocalProcessHandoff } from "../../server/src/services/runtime-services/local-process-handoff.js";

const handoff = createLocalProcessHandoff();
const children: ChildProcess[] = [];
const receipts: Record<string, unknown>[] = [];
let root: string;
let serverFile: string;

before(async () => {
  assert.equal(process.platform, "linux", "This acceptance exercises Linux /proc identities");
  assert.notEqual(process.getuid?.(), 0, "Run the fixture as an unprivileged user");
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-linux-handoff-")));
  serverFile = path.join(root, "server.cjs");
  await fs.writeFile(serverFile, `
    const http = require('node:http');
    const {spawn} = require('node:child_process');
    if (process.env.IGNORE_TERM === '1') process.on('SIGTERM', () => {});
    const server = http.createServer((req, res) => res.end(String(process.pid)));
    server.listen(Number(process.env.TEST_PORT || 0), '127.0.0.1', () => {
      process.send({pid: process.pid, port: server.address().port});
    });
    process.on('message', message => {
      if (message === 'spawn-child') {
        const leaf = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio: 'ignore'});
        process.send({leaf: leaf.pid});
      }
    });
  `);
});

function exited(child: ChildProcess) { return child.exitCode !== null || child.signalCode !== null; }
async function stopChild(child: ChildProcess) {
  if (exited(child)) return;
  const done = once(child, "exit", { signal: AbortSignal.timeout(5000) });
  // ChildProcess.kill operates only on the directly spawned fixture. Never
  // signal an unverified numeric group when cleaning up the test harness.
  child.kill("SIGTERM");
  await done;
}
afterEach(async () => {
  const failures: unknown[] = [];
  for (const receipt of receipts.splice(0)) {
    try { await handoff.stopExistingProcess(receipt); } catch (error) { failures.push(error); }
  }
  for (const child of children.splice(0)) {
    try { await stopChild(child); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Fixture process cleanup failed");
});
after(async () => { if (root) await fs.rm(root, { force: true, recursive: true }); });

async function message<T>(child: ChildProcess): Promise<T> {
  const [result] = await once(child, "message", { signal: AbortSignal.timeout(5000) });
  return result as T;
}
async function owner(pid: number) {
  const startedAt = await readProcessStartedAt(pid);
  assert.ok(startedAt);
  return { pid, startedAt };
}
async function server(options: { detached?: boolean; port?: number; ignoreTerm?: boolean } = {}) {
  const child = spawn(process.execPath, [serverFile], {
    cwd: root, detached: options.detached !== false,
    env: { PATH: process.env.PATH, TEST_PORT: String(options.port ?? 0), IGNORE_TERM: options.ignoreTerm ? "1" : "0" },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  children.push(child);
  const ready = await message<{ pid: number; port: number }>(child);
  assert.equal(ready.pid, child.pid);
  return { child, ...ready, input: { pid: ready.pid, owner: await owner(process.pid), cwd: root, workspaceRoot: root } };
}
async function capture(input: Parameters<typeof handoff.captureExistingProcess>[0]) {
  const proof = await handoff.captureExistingProcess(input);
  receipts.push(proof.receipt);
  assert.match(proof.key, /^[a-f0-9]{64}$/);
  assert.match(String(proof.receipt.leaderIdentity), /^\d+$/);
  return proof;
}
async function serving(port: number, pid: number) {
  const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
  assert.equal(await response.text(), String(pid));
}
async function portClosed(port: number) {
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }));
}

test("capture does not interrupt HTTP; old receipts cannot stop a replacement on the same port", { timeout: 15000 }, async () => {
  const original = await server();
  const foreign = await server();
  const proof = await capture(original.input);
  const duplicate = await capture(original.input);
  assert.equal(duplicate.key, proof.key);
  await serving(original.port, original.pid);
  await handoff.stopExistingProcess(proof.receipt);
  await portClosed(original.port);
  const replacement = await server({ port: original.port });
  await capture(replacement.input);
  await handoff.stopExistingProcess(proof.receipt);
  await serving(replacement.port, replacement.pid);
  await serving(foreign.port, foreign.pid);
});

test("accepted ownership survives the originating agent process exiting", { timeout: 15000 }, async () => {
  const launcher = spawn(process.execPath, ["-e", `
    const {spawn} = require('node:child_process');
    const server = spawn(process.execPath, [${JSON.stringify(serverFile)}], {
      cwd: ${JSON.stringify(root)}, detached: true,
      env: {PATH: process.env.PATH}, stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    });
    server.once('message', ready => { server.disconnect(); server.unref(); process.send(ready); });
    setInterval(()=>{},1000);
  `], { cwd: root, detached: true, env: { PATH: process.env.PATH }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  children.push(launcher);
  const ready = await message<{ pid: number; port: number }>(launcher);
  const proof = await capture({ pid: ready.pid, owner: await owner(launcher.pid!), cwd: root, workspaceRoot: root });
  await stopChild(launcher);
  await serving(ready.port, ready.pid);
  await handoff.stopExistingProcess(proof.receipt);
  await portClosed(ready.port);
  await handoff.stopExistingProcess(proof.receipt);
});

test("foreign owners, child listeners, shared groups and changed directories stay untouched", { timeout: 15000 }, async () => {
  const original = await server();
  const foreign = await server();
  const shared = await server({ detached: false });
  const nested = path.join(root, "nested"); await fs.mkdir(nested);
  const reply = message<{ leaf: number }>(original.child);
  original.child.send("spawn-child");
  const { leaf } = await reply;
  const invalid = [
    { ...original.input, owner: await owner(foreign.pid) },
    { ...original.input, owner: { ...original.input.owner, startedAt: "2000-01-01T00:00:00.000Z" } },
    { ...original.input, pid: leaf },
    { ...original.input, pid: process.pid },
    { ...original.input, cwd: nested, workspaceRoot: nested },
    shared.input,
  ];
  for (const input of invalid) await assert.rejects(handoff.captureExistingProcess(input), { code: "process_ownership_unverified" });
  await capture(original.input);
  for (const target of [original, foreign, shared]) await serving(target.port, target.pid);
});

test("children created after capture are stopped with the verified original command", { timeout: 15000 }, async () => {
  const original = await server();
  const proof = await capture(original.input);
  const reply = message<{ leaf: number }>(original.child);
  original.child.send("spawn-child");
  const { leaf } = await reply;
  await fs.access(`/proc/${leaf}/stat`);
  await handoff.stopExistingProcess(proof.receipt);
  await portClosed(original.port);
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const stat = await fs.readFile(`/proc/${leaf}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    await delay(25);
  }
  assert.fail("A late child survived the verified group stop");
});

test("changed boot/birth identities reject termination and preserve the live listener", { timeout: 15000 }, async () => {
  const original = await server();
  const proof = await capture(original.input);
  const invalid = [
    { ...proof.receipt, host: "0".repeat(64) },
    { ...proof.receipt, leaderIdentity: "0", members: [{ pid: original.pid, identity: "0" }] },
    { ...proof.receipt, members: [...proof.receipt.members as unknown[], ...proof.receipt.members as unknown[]] },
  ];
  for (const receipt of invalid) {
    await assert.rejects(handoff.stopExistingProcess(receipt), { code: "process_handoff_unverified" });
    await serving(original.port, original.pid);
  }
});

test("a command ignoring SIGTERM is killed only after the graceful interval", { timeout: 15000 }, async () => {
  const original = await server({ ignoreTerm: true });
  const proof = await capture(original.input);
  const start = performance.now();
  const done = once(original.child, "exit", { signal: AbortSignal.timeout(10000) });
  await handoff.stopExistingProcess(proof.receipt);
  await done;
  assert.equal(original.child.signalCode, "SIGKILL");
  assert.ok(performance.now() - start >= 3000);
  await portClosed(original.port);
});
