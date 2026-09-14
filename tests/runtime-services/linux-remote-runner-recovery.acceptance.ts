/** Production provider handler with real Linux process receipts; no Daytona API. */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { parseRemoteProcessLaunchReceipt, remoteProcessIdentityPrelude, type RemoteProcessIdentity } from "../../packages/shared/src/remote-process-identity.js";
import { handleDaytonaRunProcessControl } from "../../packages/plugins/sandbox-providers/daytona/src/run-process-control.js";
import { handleDaytonaRunnerRecovery, MAX_RECOVERY_STATE_BYTES } from "../../packages/plugins/sandbox-providers/daytona/src/runner-recovery.js";
import { handleDaytonaRunnerRecoveryExecute } from "../../packages/plugins/sandbox-providers/daytona/src/runner-recovery-execute.js";
type Sandbox = Parameters<typeof handleDaytonaRunProcessControl>[0];
type PluginEnvironmentRunProcessControlParams = Parameters<typeof handleDaytonaRunProcessControl>[1];

const exec = promisify(execFile);
const children: ChildProcess[] = [];
let root: string;
async function until<T>(read: () => Promise<T | null | false>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const value = await read(); if (value) return value; await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function alive(pid: number): Promise<boolean> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
  } catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
}
before(async () => {
  assert.equal(process.platform, "linux"); assert.notEqual(process.getuid?.(), 0);
  root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-provider-recovery-"));
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await until(async () => child.exitCode !== null || child.signalCode !== null, "fixture process cleanup");
  }
});
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

async function runningFixture(ignoreTerm = false) {
  const nonce = randomUUID(), readyPath = path.join(root, `${nonce}.ready`);
  const program = `const fs=require('node:fs'); ${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ""} fs.writeFileSync(process.env.FIXTURE_READY,'ready'); setInterval(()=>{},1000);`;
  const child = spawn("sh", ["-c", `set -eu; identity_nonce=$1; shift; ${remoteProcessIdentityPrelude}\nexec "$@"`,
    "paperclip-recovery-fixture", nonce, process.execPath, "-e", program], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"],
    env: { PATH: process.env.PATH, FIXTURE_READY: readyPath },
  });
  children.push(child);
  const receipt = child.stdio[3]; assert.ok(receipt);
  let output = "";
  receipt.on("data", chunk => { output += String(chunk); });
  await new Promise<void>((resolve, reject) => { receipt.once("end", resolve); receipt.once("error", reject); child.once("error", reject); });
  const owner = parseRemoteProcessLaunchReceipt(output, nonce); assert.ok(owner);
  assert.equal(owner.pid, child.pid); assert.equal(owner.processGroupId, child.pid);
  await until(async () => fs.readFile(readyPath, "utf8").catch(() => null), "runner ready after exec");

  const input: PluginEnvironmentRunProcessControlParams = { driverKey: "daytona", companyId: randomUUID(), environmentId: randomUUID(),
    providerLeaseId: randomUUID(), config: {}, workspaceConnection: { scopeId: randomUUID(), fingerprint: "a".repeat(64) }, owner,
    operation: { action: "inspect" } };
  const calls: string[] = [];
  const recoveryInput = { ...input, runId: nonce, workspaceRoot: root, sessionHash: nonce.replaceAll("-", "").repeat(2), operation: "read_state" as const };
  const stateDirectory = path.join(root, ".paperclip-runtime", "paperclip-runner", "sessions", recoveryInput.sessionHash, "runner");
  await fs.mkdir(stateDirectory, { recursive: true });
  const statePath = path.join(stateDirectory, "runner-state.json");
  const state = { schema: "paperclip.runner.durable.state.v1", runId: nonce, lifecycle: "ready" };
  await fs.writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  let dropResponse = false;
  const sandbox = { id: input.providerLeaseId, state: "started", labels: {
    "paperclip-company-id": input.companyId, "paperclip-environment-id": input.environmentId,
  } as Record<string, string>,
    refreshData: async () => { calls.push("refresh"); },
    start: () => { throw new Error("Recovery must not wake compute"); },
    stop: () => { throw new Error("Recovery must not stop the allocation"); },
    delete: () => { throw new Error("Recovery must not delete the allocation"); },
    getPreviewLink: async (port: number) => { calls.push("preview"); assert.equal(port, 43127); return { url: "https://43127-fixture.proxy.daytona.test", token: "fixture-private-token" }; },
    process: { executeCommand: async (command: string, cwd: string, env: Record<string, string>, timeout: number) => {
      calls.push("execute");
      const result = await exec("sh", ["-c", command], { cwd, env: { PATH: process.env.PATH, ...env }, timeout: timeout * 1000, maxBuffer: MAX_RECOVERY_STATE_BYTES + 1024 })
        .then(value => ({ exitCode: 0, result: value.stdout }), (error: { code?: unknown; stdout?: string }) => {
          if (typeof error.code !== "number") throw new Error("Fixture provider command failed");
          return { exitCode: error.code, result: error.stdout ?? "" };
        });
      if (dropResponse) { dropResponse = false; throw new Error("Simulated lost provider response"); }
      return result;
    } },
  };
  const operate = (operation: PluginEnvironmentRunProcessControlParams["operation"], expectedOwner: RemoteProcessIdentity = owner) =>
    handleDaytonaRunProcessControl(sandbox as unknown as Sandbox, { ...input, owner: expectedOwner, operation });
  const recover = (operation: "read_state" | "ingress" = "read_state") => handleDaytonaRunnerRecovery(sandbox as unknown as Sandbox, { ...recoveryInput, operation }, () => "fixture-generation");
  return { child, owner, input, sandbox, calls, operate, statePath, stateDirectory, state, recover, loseNextResponse: () => { dropResponse = true; } };
}
async function preview() {
  const child = spawn(process.execPath, ["-e", "const s=require('node:http').createServer((q,r)=>r.end('preview remains available'));s.listen(0,'127.0.0.1',()=>process.send(s.address().port));"],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  children.push(child);
  const port = await new Promise<number>((resolve, reject) => { child.once("message", value => resolve(Number(value))); child.once("error", reject); });
  child.disconnect();
  return async () => assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "preview remains available");
}

async function checkpointFixture() {
  const f = await runningFixture();
  let executed = 0;
  const params = { ...f.input, workspaceRoot: root,
    execution: { command: "sh", args: ["-c", "tar -czf - runner-state.json | base64"], cwd: f.stateDirectory, timeoutMs: 10_000 } };
  const execute = async (command: typeof params.execution) => {
    executed++;
    const output = await exec(command.command, command.args, { cwd: command.cwd, env: { PATH: process.env.PATH }, timeout: command.timeoutMs });
    return { exitCode: 0, timedOut: false, stdout: output.stdout, stderr: output.stderr };
  };
  const recover = () => handleDaytonaRunnerRecoveryExecute(f.sandbox as unknown as Sandbox, params, command => execute(command as typeof params.execution));
  return { ...f, params, execute, recover, executed: () => executed };
}

for (const state of ["running", "exited"]) test(`checkpoint archive from an original ${state} runner leaves the preview available`, { timeout: 15_000 }, async () => {
  const app = await preview(); const f = await checkpointFixture();
  if (state === "exited") { f.child.kill("SIGTERM"); await until(async () => !(await alive(f.owner.pid)), "original runner exit"); }
  const result = await f.recover(); assert.equal(result.state, "executed");
  if (result.state !== "executed") throw new Error("Expected complete checkpoint archive");
  assert.deepEqual(result.workspaceConnection, f.input.workspaceConnection);
  const archive = gunzipSync(Buffer.from(result.result.stdout, "base64"));
  assert.ok(archive.includes(Buffer.from(JSON.stringify(f.state))));
  assert.equal(f.executed(), 1); await app();
});

test("checkpoint never executes or wakes stopped compute even with a live matching host PID", async () => {
  const app = await preview(); const f = await checkpointFixture();
  for (const state of ["stopped", "archived", "starting", "error"]) {
    f.sandbox.state = state;
    assert.deepEqual(await f.recover(), { state: "unverified" });
  }
  assert.equal(f.executed(), 0); assert.equal(f.calls.includes("execute"), false);
  assert.equal(await alive(f.owner.pid), true); await app();
});

test("checkpoint refuses changed kernel birth and does not execute the copy command", async () => {
  const f = await checkpointFixture(); f.params.owner = { ...f.owner, startTicks: String(BigInt(f.owner.startTicks) + 1n) };
  assert.deepEqual(await f.recover(), { state: "unverified" }); assert.equal(f.executed(), 0);
  assert.equal(await alive(f.owner.pid), true);
});

test("checkpoint withholds an actual archive when allocation ownership changes during execution", async () => {
  const app = await preview(); const f = await checkpointFixture();
  const result = await handleDaytonaRunnerRecoveryExecute(f.sandbox as unknown as Sandbox, f.params, async command => {
    const output = await f.execute(command as typeof f.params.execution);
    f.sandbox.labels["paperclip-company-id"] = randomUUID(); return output;
  });
  assert.deepEqual(result, { state: "unverified" }); assert.equal(f.executed(), 1); await app();
});

test("fresh provider wrapper controls only the original runner and preserves the preview", { timeout: 15000 }, async () => {
  const app = await preview(); const f = await runningFixture();
  assert.deepEqual(await f.operate({ action: "inspect" }), { state: "running" }); await app();
  assert.deepEqual(await f.operate({ action: "signal", signal: "SIGTERM" }), { state: "signalled" });
  await until(async () => !(await alive(f.owner.pid)), "runner exit");
  assert.deepEqual(await f.operate({ action: "inspect" }), { state: "exited" });
  assert.deepEqual(await f.operate({ action: "signal", signal: "SIGTERM" }), { state: "exited" }); await app();
});

test("stubborn runner group stops after a lost response without touching the preview", { timeout: 15000 }, async () => {
  const app = await preview(); const f = await runningFixture(true);
  f.loseNextResponse();
  await assert.rejects(f.operate({ action: "stop_group" }), /lost provider response/);
  await until(async () => !(await alive(f.owner.pid)), "stubborn runner exit");
  assert.deepEqual(await f.operate({ action: "stop_group" }), { state: "stopped" }); await app();
});

test("changed kernel and provider ownership cannot authorize a signal", { timeout: 15000 }, async () => {
  const app = await preview(); const f = await runningFixture();
  for (const changed of [{ ...f.owner, startTicks: String(BigInt(f.owner.startTicks) + 1n) }, { ...f.owner, bootId: randomUUID() },
    { ...f.owner, uid: f.owner.uid + 1 }, { ...f.owner, processGroupId: f.owner.processGroupId + 1 }]) {
    assert.deepEqual(await f.operate({ action: "signal", signal: "SIGKILL" }, changed), { state: changed.uid !== f.owner.uid ? "unverified" : "mismatch" });
    assert.equal(await alive(f.owner.pid), true); await app();
  }
  const executed = f.calls.filter(value => value === "execute").length;
  f.sandbox.labels["paperclip-company-id"] = randomUUID();
  assert.deepEqual(await f.operate({ action: "signal", signal: "SIGKILL" }), { state: "unverified" });
  assert.equal(f.calls.filter(value => value === "execute").length, executed);
  assert.equal(await alive(f.owner.pid), true); await app();
});

test("provider stopped and uncertain states never wake or execute in an allocation", { timeout: 15000 }, async () => {
  const app = await preview(); const f = await runningFixture();
  // Compute state is a fixture attestation. The live local child deliberately
  // remains present, proving these paths do not execute commands or wake it.
  for (const state of ["stopped", "archived", "stopping", "error"]) {
    f.sandbox.state = state;
    assert.deepEqual(await f.operate({ action: "inspect" }), { state: ["stopped", "archived"].includes(state) ? "exited" : "unverified" });
    assert.equal(f.calls.includes("execute"), false); assert.equal(await alive(f.owner.pid), true); await app();
  }
});

test("recovery reads original state and obtains ingress while the preview stays available", { timeout: 15000 }, async () => {
  const app = await preview(); const f = await runningFixture();
  assert.deepEqual(await f.recover(), { state: "ready", workspaceConnection: f.input.workspaceConnection, runnerState: f.state }); await app();
  const result = await f.recover("ingress");
  assert.equal(result.state, "ready"); assert.ok("endpoint" in result);
  assert.equal(result.endpoint.websocketUrl, `wss://43127-fixture.proxy.daytona.test/api/runner/v1/connect/${f.state.runId}`);
  assert.equal(await alive(f.owner.pid), true); await app();
  await f.operate({ action: "signal", signal: "SIGTERM" });
  await until(async () => !(await alive(f.owner.pid)), "runner exit");
  // The fixture writes a suspended state; this tests readable retained bytes,
  // not the PRP authority's separate authenticated suspension proof.
  await fs.writeFile(f.statePath, JSON.stringify({ ...f.state, lifecycle: "suspended" }));
  const saved = await f.recover(); assert.equal(saved.state, "ready"); assert.ok("runnerState" in saved); assert.equal(saved.runnerState.lifecycle, "suspended");
  assert.deepEqual(await f.recover("ingress"), { state: "unverified" }); await app();
});

for (const cause of ["file_symlink", "parent_symlink", "oversized", "fifo", "invalid_json", "foreign_run"] as const) test(`recovery rejects ${cause} without leaking file content or stopping the preview`, { timeout: 15000 }, async () => {
  const app = await preview(); const f = await runningFixture();
  const foreign = path.join(root, `${randomUUID()}.private`); await fs.writeFile(foreign, "private fixture content");
  if (cause === "file_symlink") { await fs.unlink(f.statePath); await fs.symlink(foreign, f.statePath); }
  if (cause === "parent_symlink") {
    const moved = `${f.stateDirectory}.moved`; await fs.rename(f.stateDirectory, moved); await fs.symlink(moved, f.stateDirectory);
  }
  if (cause === "oversized") await fs.truncate(f.statePath, MAX_RECOVERY_STATE_BYTES + 1);
  if (cause === "fifo") { await fs.unlink(f.statePath); await exec("mkfifo", [f.statePath]); }
  if (cause === "invalid_json") await fs.writeFile(f.statePath, "private fixture content");
  if (cause === "foreign_run") await fs.writeFile(f.statePath, JSON.stringify({ ...f.state, runId: randomUUID() }));
  assert.deepEqual(await f.recover(), { state: "unverified" }); assert.equal(await alive(f.owner.pid), true); await app();
});
