/** Exercise the exact remote capture/stop program in an unprivileged Linux PID namespace. */
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
import { runtimeServiceProcessHandoffSource } from "../../packages/plugins/sdk/src/runtime-service-process-handoff.js";

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
  } catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null; throw error; }
}
afterEach(async () => {
  const errors: unknown[] = [];
  for (const identity of roots.splice(0)) {
    try {
      const current = await kernel(identity.pid);
      if (!current) continue;
      assert.deepEqual(current, identity, "Never signal a replacement process in fixture cleanup");
      assert.equal(current.processGroupId, current.pid);
      try { process.kill(-current.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      for (let attempt = 0; attempt < 100 && await kernel(identity.pid); attempt++) await delay(20);
      assert.equal(await kernel(identity.pid), null, "Detached fixture runner did not stop");
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Detached fixture cleanup failed");
});
after(async () => { if (directory) await fs.rm(directory, { recursive: true, force: true }); });

async function launch(ignoreTerm = false) {
  // Quoted path characters exercise the actual argv contract, not shell interpolation.
  const root = path.join(directory, `runner's $workspace ${randomUUID()}`);
  await fs.mkdir(root);
  const marker = path.join(root, "identity");
  const readyPath = path.join(root, "ready.json");
  const program = path.join(root, "agent.cjs");
  const serverSource = `
    const {spawn}=require('node:child_process');
    if (${ignoreTerm}) process.on('SIGTERM',()=>{});
    const s=require('node:http').createServer((q,r)=>{
      if(q.url==='/spawn') {
        const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send(process.pid);setInterval(()=>{},1000);"],{stdio:['ignore','ignore','inherit','ipc']});
        child.once('message',pid=>{r.end(String(pid));child.disconnect();child.unref();});
      } else r.end(String(process.pid));
    });s.listen(0,'127.0.0.1',()=>process.send({pid:process.pid,port:s.address().port}));
  `;
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
    const server = spawn(process.execPath, ['-e', ${JSON.stringify(serverSource)}], {
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
  const serverIdentity = await kernel(ready.server.pid);
  assert.ok(serverIdentity); roots.push(serverIdentity);
  return { root, marker, stdout, identity, ready };
}


const scope = { companyId: randomUUID(), environmentId: randomUUID(), providerLeaseId: randomUUID() };
type Receipt = { version: number; scope: typeof scope; boot: { bootId: string; initStartTicks: string; uid: number }; groupId: number; leaderIdentity: string; members: Array<{ pid: number; identity: string }> };
type Result = { state: "captured" | "stopped" | "failed"; key?: string; receipt?: Receipt; errorCode?: string };
async function operate(operation: Record<string, unknown>): Promise<Result> {
  let output: { stdout: string; stderr: string };
  try { output = await exec(process.execPath, ["-e", runtimeServiceProcessHandoffSource], {
    env: { PATH: process.env.PATH, PAPERCLIP_PROCESS_HANDOFF: JSON.stringify({ scope, ...operation }) }, timeout: 12000, maxBuffer: 256 * 1024,
  }); } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    assert.equal(failure.code, 1); output = { stdout: failure.stdout!, stderr: failure.stderr! };
  }
  assert.equal(output.stderr, ""); return JSON.parse(output.stdout);
}
function captureInput(f: Awaited<ReturnType<typeof launch>>) {
  return { action: "capture", sourcePid: f.ready.server.pid, owner: f.identity, cwd: f.root, workspaceRoot: f.root };
}
async function capture(f: Awaited<ReturnType<typeof launch>>) {
  const result = await operate(captureInput(f)); assert.equal(result.state, "captured"); assert.match(result.key!, /^[a-f0-9]{64}$/); assert.ok(result.receipt);
  return result as Result & { key: string; receipt: Receipt };
}
async function assertServing(f: Awaited<ReturnType<typeof launch>>) {
  assert.equal(await (await fetch(`http://127.0.0.1:${f.ready.server.port}/`)).text(), String(f.ready.server.pid));
}

test("capture leaves HTTP serving; duplicate capture converges; persisted stop survives runner exit and response loss", { timeout: 15000 }, async () => {
  const f = await launch(), proof = await capture(f);
  await assertServing(f);
  assert.deepEqual(await capture(f), proof);
  assert.deepEqual(proof.receipt.scope, scope);
  assert.equal(proof.receipt.groupId, f.ready.server.pid);
  assert.equal(proof.receipt.boot.uid, process.getuid?.());
  process.kill(f.identity.pid, "SIGTERM");
  for (let attempt = 0; attempt < 100 && await kernel(f.identity.pid); attempt++) await delay(20);
  assert.equal(await kernel(f.identity.pid), null); await assertServing(f);
  // Serialize through a host-style persistence round trip before signalling.
  const saved = JSON.parse(JSON.stringify(proof.receipt));
  assert.deepEqual(await operate({ action: "stop", receipt: saved }), { state: "stopped" });
  assert.equal(await kernel(f.ready.server.pid), null);
  assert.deepEqual(await operate({ action: "stop", receipt: saved }), { state: "stopped" });
});

test("a new server can bind the original port; retrying the old receipt never kills the replacement", { timeout: 15000 }, async () => {
  const f = await launch(), proof = await capture(f);
  assert.deepEqual(await operate({ action: "stop", receipt: proof.receipt }), { state: "stopped" });
  const { spawn } = await import("node:child_process");
  const replacement = spawn(process.execPath, ["-e", "const s=require('node:http').createServer((q,r)=>r.end('replacement'));s.listen(Number(process.argv[1]),'127.0.0.1',()=>process.send('ready'));", String(f.ready.server.port)], { cwd: f.root, detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  await new Promise<void>((resolve, reject) => { replacement.once("message", () => resolve()); replacement.once("error", reject); replacement.once("exit", code => reject(new Error(`Replacement exited: ${code}`))); });
  const identity = await kernel(replacement.pid!); assert.ok(identity); roots.push(identity); replacement.disconnect(); replacement.unref();
  assert.deepEqual(await operate({ action: "stop", receipt: proof.receipt }), { state: "stopped" });
  assert.equal(await (await fetch(`http://127.0.0.1:${f.ready.server.port}/`)).text(), "replacement");
});

test("capture refuses foreign roots, changed births, UIDs, shared groups and workspace mismatch without interrupting either server", { timeout: 15000 }, async () => {
  const f = await launch(), foreign = await launch(), input = captureInput(f);
  for (const changed of [
    { owner: foreign.identity }, { sourcePid: foreign.ready.server.pid }, { sourcePid: f.identity.pid },
    { owner: { ...f.identity, startTicks: String(BigInt(f.identity.startTicks) + 1n) } },
    { owner: { ...f.identity, uid: f.identity.uid + 1 } }, { owner: { ...f.identity, processGroupId: foreign.identity.pid } },
    { owner: { ...f.identity, bootId: randomUUID() } }, { cwd: directory }, { workspaceRoot: foreign.root },
    { workspaceRoot: "/" }, { sourcePid: 1 },
  ]) {
    assert.deepEqual(await operate({ ...input, ...changed }), { state: "failed", errorCode: "PROCESS_OWNERSHIP_UNVERIFIED" });
    await assertServing(f); await assertServing(foreign);
  }
});

test("stop refuses altered namespace, scope, leader birth and duplicate membership; JSON field order does not affect a valid receipt", { timeout: 15000 }, async () => {
  const f = await launch(), proof = await capture(f), receipt = proof.receipt;
  for (const altered of [
    { ...receipt, scope: { ...scope, companyId: randomUUID() } },
    { ...receipt, scope: { ...scope, providerLeaseId: randomUUID() } },
    { ...receipt, boot: { ...receipt.boot, bootId: randomUUID() } },
    { ...receipt, boot: { ...receipt.boot, initStartTicks: String(BigInt(receipt.boot.initStartTicks) + 1n) } },
    { ...receipt, boot: { ...receipt.boot, uid: receipt.boot.uid + 1 } },
    { ...receipt, leaderIdentity: "999999999", members: [{ pid: receipt.groupId, identity: "999999999" }] },
    { ...receipt, members: [...receipt.members, ...receipt.members] },
    { ...receipt, command: "not-an-ownership-field" },
  ]) {
    assert.deepEqual(await operate({ action: "stop", receipt: altered }), { state: "failed", errorCode: "PROCESS_HANDOFF_UNVERIFIED" }); await assertServing(f);
  }
  assert.deepEqual(await operate({ action: "stop", receipt: { ...receipt, boot: { uid: receipt.boot.uid, initStartTicks: receipt.boot.initStartTicks, bootId: receipt.boot.bootId } } }), { state: "stopped" });
});


test("stop includes children born after capture and escalates only the verified group when SIGTERM is ignored", { timeout: 15000 }, async () => {
  const f = await launch(true), proof = await capture(f);
  const childPid = Number(await (await fetch(`http://127.0.0.1:${f.ready.server.port}/spawn`)).text());
  assert.ok(Number.isSafeInteger(childPid)); assert.equal((await kernel(childPid))?.processGroupId, f.ready.server.pid);
  assert.ok(!proof.receipt.members.some(member => member.pid === childPid));
  const started = performance.now();
  assert.deepEqual(await operate({ action: "stop", receipt: proof.receipt }), { state: "stopped" });
  assert.ok(performance.now() - started >= 2500, "Allow the graceful-stop interval before escalation");
  assert.equal(await kernel(childPid), null); assert.equal(await kernel(f.ready.server.pid), null);
  assert.deepEqual(await kernel(f.identity.pid), f.identity, "The original runner is outside the terminated command group");
});
