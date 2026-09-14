/** Real native launcher and kernel control; no provider account or model. */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { controlRemoteProcess } from "../../packages/adapter-utils/src/remote-process-control.js";
import { parseRemoteProcessLaunchReceipt, type RemoteProcessIdentity } from "../../packages/adapter-utils/src/remote-process-identity.js";
import type { CommandManagedRuntimeRunner } from "../../packages/adapter-utils/src/command-managed-runtime.js";
import { createRemoteRunnerProcessLauncher, type RemoteRunnerProcessControls } from "../../server/src/services/native-runtime/remote-runner-process.js";

const exec = promisify(execFile);
const owners = new Map<number, RemoteProcessIdentity>();
const children: ChildProcess[] = [];
const completions: Promise<unknown>[] = [];
let directory: string;
async function until<T>(read: () => Promise<T | null | false>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 250; attempt++) { const value = await read(); if (value) return value; await delay(20); }
  throw new Error(`Timed out waiting for ${label}`);
}
const runner: Pick<CommandManagedRuntimeRunner, "execute"> = {
  async execute(input) {
    try {
      const value = await exec(input.command, input.args ?? [], { cwd: input.cwd ?? directory,
        env: { PATH: process.env.PATH, ...input.env }, timeout: input.timeoutMs, maxBuffer: 256 * 1024 });
      return { pid: null, startedAt: new Date().toISOString(), exitCode: 0, signal: null, timedOut: false, stdout: value.stdout, stderr: value.stderr };
    } catch (error) {
      const value = error as Error & { code?: number; killed?: boolean; stdout?: string; stderr?: string; signal?: string };
      return { pid: null, startedAt: new Date().toISOString(), exitCode: typeof value.code === "number" ? value.code : 1, signal: value.signal ?? null,
        timedOut: value.killed === true, stdout: value.stdout ?? "", stderr: value.stderr ?? "" };
    }
  },
};
async function kernel(pid: number): Promise<RemoteProcessIdentity | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return null;
    return { version: 1, pid, uid: (await fs.stat(`/proc/${pid}`)).uid, processGroupId: Number(fields[2]),
      startTicks: fields[19]!, bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() };
  } catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null; throw error; }
}
before(async () => {
  assert.equal(process.platform, "linux"); assert.notEqual(process.getuid?.(), 0);
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runner-control-"));
});
afterEach(async () => {
  for (const owner of owners.values()) {
    const state = await controlRemoteProcess(runner, owner, { action: "stop_group" });
    if (state !== "stopped") {
      // Extra fixture children may lead no group of their own. Their recorded
      // identities still permit an individual signal, never a guessed PID.
      assert.ok(["signalled", "exited"].includes(await controlRemoteProcess(runner, owner, { action: "signal", signal: "SIGKILL" })));
    }
  }
  for (const owner of owners.values()) await until(async () => !(await kernel(owner.pid)), "owned fixture process exit");
  owners.clear();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await until(async () => child.exitCode !== null || child.signalCode !== null, "independent service exit");
  }
  await Promise.allSettled(completions.splice(0));
});
after(async () => { if (directory) await fs.rm(directory, { recursive: true, force: true }); });

async function independentService() {
  const child = spawn(process.execPath, ["-e", "const s=require('node:http').createServer((q,r)=>r.end('preview alive'));s.listen(0,'127.0.0.1',()=>process.send({port:s.address().port}));", "--", "--runner-id", "runner-control"],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  children.push(child);
  const address = await new Promise<{ port: number }>((resolve, reject) => { child.once("message", value => resolve(value as { port: number })); child.once("error", reject); });
  child.disconnect();
  return { child, url: `http://127.0.0.1:${address.port}/` };
}

type Ready = { pid: number; childPid: number | null };
async function native(input: { marker: "replace" | "remove"; victimPid: number; rejectPersistence?: boolean; failInspect?: boolean; launchTimeout?: boolean; stubborn?: boolean; rotateProcessCapability?: boolean; restrictedControls?: boolean }) {
  const root = path.join(directory, `runner's $workspace ${randomUUID()}`);
  await fs.mkdir(root);
  const marker = path.join(root, "identity"), readyFile = path.join(root, "ready.json"), program = path.join(root, "runner.cjs");
  await fs.writeFile(program, `
    const fs=require('node:fs'), {spawn}=require('node:child_process');
    const marker=process.env.FIXTURE_MARKER, ready=process.env.FIXTURE_READY;
    const original=fs.readFileSync(marker,'utf8').trim().split('\\n');
    if(process.env.FIXTURE_MODE==='remove') fs.unlinkSync(marker);
    else { original[1]=process.env.FIXTURE_VICTIM; fs.writeFileSync(marker,original.join('\\n')+'\\n'); }
    let childPid=null;
    const report=()=>fs.writeFileSync(ready,JSON.stringify({pid:process.pid,childPid}));
    if(process.env.FIXTURE_STUBBORN==='1') {
      process.on('SIGTERM',()=>{});
      const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
      childPid=child.pid; child.once('message',()=>{child.disconnect();child.unref();report();});
    } else report();
    setInterval(()=>{},1000);
  `);
  let captured: RemoteProcessIdentity | null = null;
  let inspectCount = 0;
  let spawned = false;
  let processEpoch = 1, processCapabilityAvailable = true, launchCount = 0, staleLaunchCommands = 0;
  let controlPhase: "ready" | "pending" = "ready";
  const processOperations: Array<{ epoch: number; action: string }> = [];
  const ready = () => until(async () => {
    try { return JSON.parse(await fs.readFile(readyFile, "utf8")) as Ready; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }, "fake runner readiness");
  const transport: Pick<CommandManagedRuntimeRunner, "execute"> = {
    async execute(command) {
      if ((input.rotateProcessCapability || input.restrictedControls) && spawned) {
        staleLaunchCommands++;
        throw new Error("The completed launch run cannot execute process commands");
      }
      if (command.env?.PAPERCLIP_REMOTE_PROCESS_CONTROL) {
        const control = JSON.parse(command.env.PAPERCLIP_REMOTE_PROCESS_CONTROL);
        if (control.operation.action === "inspect") {
          inspectCount++;
          if (input.failInspect) return { pid: null, startedAt: new Date().toISOString(), exitCode: 1, signal: null, timedOut: true, stdout: "", stderr: "unavailable" };
        }
      }
      const result = await runner.execute(command);
      if (command.args?.[2] === "paperclip-runner-launch") {
        launchCount++;
        captured = parseRemoteProcessLaunchReceipt(result.stdout, command.args[4]!);
        assert.ok(captured, "Real launch RPC must return the native wrapper receipt");
        owners.set(captured.pid, captured);
        if (input.launchTimeout) return { ...result, timedOut: true, exitCode: 1 };
      }
      return result;
    },
  };
  const restrictedControls: RemoteRunnerProcessControls = {
    async inspect(owner) {
      assert.deepEqual(owner, captured); inspectCount++;
      processOperations.push({ epoch: processEpoch, action: `inspect:${controlPhase}` });
      if (controlPhase === "pending") return "pending";
      const state = await controlRemoteProcess(runner, owner, { action: "inspect" });
      assert.ok(state !== "signalled" && state !== "stopped");
      return state;
    },
    async signal(owner, signal) {
      assert.deepEqual(owner, captured);
      processOperations.push({ epoch: processEpoch, action: `signal:${controlPhase}` });
      if (controlPhase !== "ready") return "unverified";
      const state = await controlRemoteProcess(runner, owner, { action: "signal", signal });
      assert.ok(state !== "running" && state !== "stopped");
      return state;
    },
    async readState(owner) {
      assert.deepEqual(owner, captured); assert.equal(controlPhase, "ready");
      processOperations.push({ epoch: processEpoch, action: "read_state" });
      return { lifecycle: "ready" };
    },
  };
  const launch = createRemoteRunnerProcessLauncher({ target: { kind: "remote", transport: "sandbox", providerKey: "daytona",
    environmentId: randomUUID(), leaseId: randomUUID(), remoteCwd: root }, runner: transport as CommandManagedRuntimeRunner,
    ...(input.restrictedControls ? { processControls: restrictedControls } : {}),
    ...(input.rotateProcessCapability ? { processRunner: {
      async execute(command: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) {
        const action = command.env?.PAPERCLIP_REMOTE_PROCESS_CONTROL
          ? JSON.parse(command.env.PAPERCLIP_REMOTE_PROCESS_CONTROL).operation.action as string : command.args?.[2] ?? "state";
        assert.notEqual(action, "paperclip-runner-launch", "A process capability cannot launch another runner");
        processOperations.push({ epoch: processEpoch, action });
        if (!processCapabilityAvailable) throw new Error("Current process capability unavailable");
        if (action === "inspect") inspectCount++;
        return runner.execute(command);
      },
    } } : {}),
    remoteBinary: process.execPath, processIdentityPath: marker, stateDirectory: root, diagnosticsDirectory: path.join(root, "diagnostics"), runnerInstanceId: "runner-control",
    onSpawn: async meta => {
      spawned = true; assert.deepEqual(meta.remoteProcessIdentity, captured); assert.equal(meta.processLocation, "remote");
      const result = await ready();
      if (result.childPid) { const identity = await kernel(result.childPid); assert.ok(identity); owners.set(identity.pid, identity); }
      if (input.rejectPersistence) throw new Error("simulated persistence rejection");
    },
  });
  const handle = launch({ command: process.execPath, args: [program, "--runner-id", "runner-control"], cwd: directory,
    environment: { PATH: process.env.PATH, FIXTURE_MARKER: marker, FIXTURE_READY: readyFile, FIXTURE_MODE: input.marker,
      FIXTURE_VICTIM: String(input.victimPid), FIXTURE_STUBBORN: input.stubborn ? "1" : "0" } });
  // Attach a rejection observer immediately; assertions below still await the
  // original completion and distinguish a verified exit from lost observation.
  completions.push(handle.completion.catch(() => undefined));
  return { handle, marker, ready, processOperations,
    setControlPhase(phase: "ready" | "pending") { controlPhase = phase; processEpoch++; },
    rotateProcessCapability(available = true) { processEpoch++; processCapabilityAvailable = available; },
    get launchCount() { return launchCount; }, get staleLaunchCommands() { return staleLaunchCommands; },
    get owner() { assert.ok(captured); return captured; }, get inspectCount() { return inspectCount; }, get spawned() { return spawned; } };
}

test("restricted monitoring waits through a handoff while the original runner and preview remain alive", { timeout: 15000 }, async () => {
  const service = await independentService();
  const f = await native({ marker: "replace", victimPid: service.child.pid!, restrictedControls: true });
  await f.ready();
  await until(async () => f.inspectCount > 0, "initial restricted observation");
  let completed = false;
  void f.handle.completion.then(() => { completed = true; });
  f.setControlPhase("pending");
  await until(async () => f.processOperations.filter(entry => entry.action === "inspect:pending").length >= 2, "two deferred handoff observations");
  assert.equal(completed, false); assert.deepEqual(await kernel(f.owner.pid), f.owner);
  assert.equal(await (await fetch(service.url)).text(), "preview alive");
  f.setControlPhase("ready");
  assert.equal(f.handle.child.kill("SIGTERM"), true);
  await f.handle.completion;
  assert.equal(await kernel(f.owner.pid), null);
  assert.equal(f.launchCount, 1); assert.equal(f.staleLaunchCommands, 0);
  assert.ok(f.processOperations.some(entry => entry.action === "read_state"));
  assert.equal(await (await fetch(service.url)).text(), "preview alive");
});

test("a rejected restricted signal during handoff preserves the real runner and preview", { timeout: 15000 }, async () => {
  const service = await independentService();
  const f = await native({ marker: "remove", victimPid: service.child.pid!, restrictedControls: true });
  await f.ready();
  await until(async () => f.inspectCount > 0, "initial restricted observation");
  f.setControlPhase("pending");
  assert.equal(f.handle.child.kill("SIGKILL"), true);
  await assert.rejects(f.handle.completion, /runner_remote_process_signal_unverified/);
  assert.deepEqual(await kernel(f.owner.pid), f.owner);
  assert.equal(f.processOperations.filter(entry => entry.action === "signal:pending").length, 1);
  assert.equal(f.launchCount, 1); assert.equal(f.staleLaunchCommands, 0);
  assert.equal(await (await fetch(service.url)).text(), "preview alive");
});

test("one live runner follows three process capabilities while the same HTTP preview stays reachable", { timeout: 15000 }, async () => {
  const service = await independentService();
  const f = await native({ marker: "replace", victimPid: service.child.pid!, rotateProcessCapability: true });
  await f.ready();
  for (const epoch of [1, 2]) {
    await until(async () => f.processOperations.some(entry => entry.epoch === epoch && entry.action === "inspect"), `epoch ${epoch} observation`);
    assert.deepEqual(await kernel(f.owner.pid), f.owner);
    assert.equal(await (await fetch(service.url)).text(), "preview alive");
    f.rotateProcessCapability();
  }
  assert.equal(f.handle.child.kill("SIGTERM"), true);
  await f.handle.completion;
  assert.equal(await kernel(f.owner.pid), null);
  assert.equal(f.launchCount, 1);
  assert.equal(f.staleLaunchCommands, 0);
  assert.ok(f.processOperations.some(entry => entry.epoch === 3 && entry.action === "signal"));
  assert.ok(f.processOperations.some(entry => entry.epoch === 3 && entry.action === "paperclip-runner-diagnostics"));
  assert.ok(f.processOperations.some(entry => entry.epoch === 3 && entry.action === "state"));
  assert.equal(await (await fetch(service.url)).text(), "preview alive");
});

test("loss of the current process capability neither falls back to the launch run nor claims process exit", { timeout: 15000 }, async () => {
  const service = await independentService();
  const f = await native({ marker: "remove", victimPid: service.child.pid!, rotateProcessCapability: true });
  await f.ready();
  await until(async () => f.inspectCount > 0, "first capability observation");
  f.rotateProcessCapability(false);
  await assert.rejects(f.handle.completion, /runner_remote_process_verification_unavailable/);
  assert.deepEqual(await kernel(f.owner.pid), f.owner);
  assert.equal(f.launchCount, 1);
  assert.equal(f.staleLaunchCommands, 0);
  assert.equal(await (await fetch(service.url)).text(), "preview alive");
});

for (const marker of ["replace", "remove"] as const) test(`native runner remains owned when its identity marker is ${marker}d`, { timeout: 15000 }, async () => {
  const service = await independentService();
  const f = await native({ marker, victimPid: service.child.pid! });
  await f.ready();
  await until(async () => f.inspectCount >= 2, "two kernel liveness observations");
  assert.deepEqual(await kernel(f.owner.pid), f.owner);
  assert.equal(await (await fetch(service.url)).text(), "preview alive");
  assert.equal(f.handle.child.kill("SIGTERM"), true);
  await f.handle.completion;
  assert.equal(await kernel(f.owner.pid), null);
  assert.equal(await (await fetch(service.url)).text(), "preview alive", "Cancellation must not signal the marker's victim PID");
});

test("persistence rejection stops the attested group, including stubborn children, and preserves the independent app", { timeout: 15000 }, async () => {
  const service = await independentService();
  const f = await native({ marker: "replace", victimPid: service.child.pid!, rejectPersistence: true, stubborn: true });
  const ready = await f.ready();
  await assert.rejects(f.handle.completion, /runner_remote_process_identity_unavailable$/);
  assert.equal(await kernel(f.owner.pid), null);
  assert.ok(ready.childPid); assert.equal(await kernel(ready.childPid), null);
  assert.equal(await (await fetch(service.url)).text(), "preview alive");
});

test("a failed launch response with a valid receipt still cleans up its exact runner", { timeout: 15000 }, async () => {
  const service = await independentService();
  const f = await native({ marker: "replace", victimPid: service.child.pid!, launchTimeout: true });
  await assert.rejects(f.handle.completion, /runner_remote_process_launch_timed_out$/);
  assert.equal(f.spawned, false); assert.equal(await kernel(f.owner.pid), null);
  assert.equal(await (await fetch(service.url)).text(), "preview alive");
});

test("a monitoring timeout does not claim the still-running process exited", { timeout: 15000 }, async () => {
  const service = await independentService();
  const f = await native({ marker: "remove", victimPid: service.child.pid!, failInspect: true });
  await assert.rejects(f.handle.completion, /runner_remote_process_verification_unavailable/);
  assert.deepEqual(await kernel(f.owner.pid), f.owner);
  assert.equal(await controlRemoteProcess(runner, f.owner, { action: "inspect" }), "running");
  assert.equal(await (await fetch(service.url)).text(), "preview alive");
});

test("wrong boot, birth, UID, PID or process group cannot authorize signalling", { timeout: 15000 }, async () => {
  const service = await independentService();
  const f = await native({ marker: "replace", victimPid: service.child.pid! });
  await f.ready();
  for (const patch of [{ bootId: randomUUID() }, { startTicks: String(BigInt(f.owner.startTicks) + 1n) },
    { uid: f.owner.uid + 1 }, { pid: service.child.pid! }, { processGroupId: f.owner.processGroupId + 1 }]) {
    const state = await controlRemoteProcess(runner, { ...f.owner, ...patch }, { action: "signal", signal: "SIGKILL" });
    assert.ok(["mismatch", "unverified"].includes(state), state);
    assert.equal(await controlRemoteProcess(runner, { ...f.owner, ...patch }, { action: "stop_group" }), "unverified");
    assert.deepEqual(await kernel(f.owner.pid), f.owner);
    assert.equal(await (await fetch(service.url)).text(), "preview alive");
  }
  assert.equal(f.handle.child.kill("SIGTERM"), true); await f.handle.completion;
});

test("a root exit alone cannot prove an uncaptured surviving group has stopped", { timeout: 15000 }, async () => {
  const service = await independentService();
  const f = await native({ marker: "remove", victimPid: service.child.pid!, stubborn: true });
  const ready = await f.ready();
  await until(async () => f.inspectCount > 0, "initial kernel observation");
  assert.equal(await controlRemoteProcess(runner, f.owner, { action: "signal", signal: "SIGKILL" }), "signalled");
  await f.handle.completion;
  assert.equal(await kernel(f.owner.pid), null);
  assert.ok(ready.childPid); assert.ok(await kernel(ready.childPid));
  assert.equal(await controlRemoteProcess(runner, f.owner, { action: "stop_group" }), "unverified");
  assert.ok(await kernel(ready.childPid));
  assert.equal(await (await fetch(service.url)).text(), "preview alive");
});
