/** Real provider-style launch receipt, without a Daytona account or agent credentials. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { parseRemoteProcessLaunchReceipt, type RemoteProcessIdentity } from "../../packages/adapter-utils/src/remote-process-identity.js";
import { remoteRunnerLaunchScripts } from "../../server/src/services/native-runtime/remote-runner-launch.js";
import { createLocalProcessHandoff } from "../../server/src/services/runtime-services/local-process-handoff.js";
import { readProcessStartedAt } from "../../server/src/services/hot-restart.js";

const exec = promisify(execFile);
const roots: RemoteProcessIdentity[] = [];
let directory: string;
before(async () => {
  assert.equal(process.platform, "linux"); assert.notEqual(process.getuid?.(), 0);
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-remote-identity-")));
});
async function kernel(pid: number): Promise<RemoteProcessIdentity | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return null;
    return { version: 1, pid, uid: (await fs.stat(`/proc/${pid}`)).uid, processGroupId: Number(fields[2]), startTicks: fields[19]!, bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
afterEach(async () => {
  for (const identity of roots.splice(0)) {
    const current = await kernel(identity.pid);
    if (!current) continue;
    assert.deepEqual(current, identity, "Never signal a replacement process in fixture cleanup");
    assert.equal(current.processGroupId, current.pid);
    process.kill(-current.pid, "SIGTERM");
    for (let attempt = 0; attempt < 100 && await kernel(identity.pid); attempt++) await delay(20);
    assert.equal(await kernel(identity.pid), null, "Detached fixture runner did not stop");
  }
});
after(async () => { if (directory) await fs.rm(directory, { recursive: true, force: true }); });

async function launch() {
  // Quoted path characters exercise the actual argv contract, not shell interpolation.
  const root = path.join(directory, `runner's $workspace ${randomUUID()}`);
  await fs.mkdir(root);
  const marker = path.join(root, "identity");
  const readyPath = path.join(root, "ready.json");
  const program = path.join(root, "agent.cjs");
  await fs.writeFile(program, `
    const fs = require('node:fs');
    const {spawn} = require('node:child_process');
    const marker = process.argv[2], ready = process.argv[3];
    const original = fs.readFileSync(marker, 'utf8');
    // A compromised agent can rewrite this file and print a plausible receipt.
    // Neither changes the already emitted, closed launch-response descriptor.
    fs.writeFileSync(marker, original.replace(String(process.pid), '999999'));
    process.stdout.write('paperclip-process-v1|forged-agent-output\\n');
    let fd3WriteSucceeded = false;
    try { fs.writeSync(3, 'forged-fd3-output\\n'); fd3WriteSucceeded = true; } catch {}
    const server = spawn(process.execPath, ['-e', "const s=require('node:http').createServer((q,r)=>r.end(String(process.pid)));s.listen(0,'127.0.0.1',()=>process.send({pid:process.pid,port:s.address().port}));"], {
      cwd: process.cwd(), detached: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    });
    server.once('message', data => { server.disconnect(); server.unref(); fs.writeFileSync(ready, JSON.stringify({pid:process.pid,fd3WriteSucceeded,server:data})); });
    setInterval(()=>{},1000);
  `);
  const scripts = remoteRunnerLaunchScripts(true);
  const nonce = randomUUID();
  const { stdout, stderr } = await exec("sh", ["-c", scripts.launch, "paperclip-runner-launch", marker, nonce, randomUUID(), scripts.child, path.join(root, "diagnostics"), process.execPath, program, marker, readyPath], {
    cwd: root, env: { PATH: process.env.PATH }, timeout: 5000, maxBuffer: 4096,
  });
  assert.equal(stderr, "");
  const identity = parseRemoteProcessLaunchReceipt(stdout, nonce);
  assert.ok(identity, `Unexpected launch response: ${stdout}`);
  roots.push(identity);
  let ready: { pid: number; fd3WriteSucceeded: boolean; server: { pid: number; port: number } } | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = JSON.parse(await fs.readFile(readyPath, "utf8")); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await delay(20);
  }
  assert.ok(ready);
  return { root, marker, stdout, identity, ready };
}

test("Daytona launch wrapper returns real kernel identity before exec and closes its response channel", { timeout: 15000 }, async () => {
  const f = await launch();
  assert.deepEqual(await kernel(f.identity.pid), f.identity);
  assert.equal(f.identity.pid, f.ready.pid);
  assert.equal(f.identity.pid, f.identity.processGroupId);
  assert.equal(f.identity.uid, process.getuid?.());
  assert.equal(f.ready.fd3WriteSucceeded, false);
  assert.ok((await fs.readFile(f.marker, "utf8")).includes("999999"));
  assert.ok(!f.stdout.includes("forged"));
  // Verify the receipt identifies the still-live runner after its launch RPC
  // has returned and even though the sandbox-writable marker has been replaced.
  await delay(100);
  assert.deepEqual(await kernel(f.identity.pid), f.identity);
  const handoff = createLocalProcessHandoff();
  const proof = await handoff.captureExistingProcess({ pid: f.ready.server.pid, owner: { pid: f.identity.pid, startedAt: (await readProcessStartedAt(f.identity.pid))! }, cwd: f.root, workspaceRoot: f.root });
  await handoff.stopExistingProcess(proof.receipt);
});

test("the attested root owns its command; an accepted command receipt survives that root exiting", { timeout: 15000 }, async () => {
  const f = await launch();
  const handoff = createLocalProcessHandoff();
  const proof = await handoff.captureExistingProcess({ pid: f.ready.server.pid, owner: { pid: f.identity.pid, startedAt: (await readProcessStartedAt(f.identity.pid))! }, cwd: f.root, workspaceRoot: f.root });
  const origin = `http://127.0.0.1:${f.ready.server.port}/`;
  assert.equal(await (await fetch(origin)).text(), String(f.ready.server.pid));
  assert.deepEqual(await kernel(f.identity.pid), f.identity);
  process.kill(f.identity.pid, "SIGTERM");
  for (let attempt = 0; attempt < 100 && await kernel(f.identity.pid); attempt++) await delay(20);
  assert.equal(await kernel(f.identity.pid), null);
  assert.equal(await (await fetch(origin)).text(), String(f.ready.server.pid));
  await handoff.stopExistingProcess(proof.receipt);
  await assert.rejects(fetch(origin));
  await handoff.stopExistingProcess(proof.receipt);
});
