/** Real ACPX bridge plumbing and kernel handoff; no model/provider credentials. */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { startAdapterExecutionTargetProcessSessionBridge } from "../../packages/adapter-utils/src/execution-target.js";
import type { CommandManagedRuntimeRunner } from "../../packages/adapter-utils/src/command-managed-runtime.js";
import type { RemoteProcessIdentity } from "../../packages/adapter-utils/src/remote-process-identity.js";
import { runtimeServiceProcessHandoffSource } from "../../packages/plugins/sdk/src/runtime-service-process-handoff.js";

const exec = promisify(execFile);
let root: string;
before(async () => {
  assert.equal(process.platform, "linux"); assert.notEqual(process.getuid?.(), 0);
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-owner-")));
});
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
async function kernel(pid: number): Promise<RemoteProcessIdentity | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return null;
    return { version: 1, pid, uid: (await fs.stat(`/proc/${pid}`)).uid, processGroupId: Number(fields[2]), startTicks: fields[19]!, bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() };
  } catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null; throw error; }
}
async function waitFor<T>(read: () => Promise<T | null>, message: string): Promise<T> {
  for (let i = 0; i < 250; i++) { const value = await read(); if (value !== null) return value; await delay(20); }
  throw new Error(message);
}
function providerRunner() {
  const pending = new Set<Promise<unknown>>();
  const runner: CommandManagedRuntimeRunner = { execute(input) {
    const startedAt = new Date().toISOString();
    const work = new Promise<any>((resolve, reject) => {
      let logs = Promise.resolve();
      const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env },
        timeout: input.timeoutMs ?? 15000, maxBuffer: 8 * 1024 * 1024 }, async (error, stdout, stderr) => {
        try {
          await logs;
          if (error && typeof error.code !== "number") throw error;
          resolve({ stdout, stderr, exitCode: error ? error.code : 0, signal: error?.signal ?? null,
            timedOut: error?.killed ?? false, startedAt, finishedAt: new Date().toISOString(), durationMs: 0, pid: child.pid ?? null });
        } catch (error) { reject(error); }
      });
      child.stdout?.on("data", chunk => { logs = logs.then(() => input.onLog?.("stdout", String(chunk))); void logs.catch(() => {}); });
      child.stderr?.on("data", chunk => { logs = logs.then(() => input.onLog?.("stderr", String(chunk))); void logs.catch(() => {}); });
      child.stdin?.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") reject(error); });
      child.stdin?.end(input.stdin);
    });
    pending.add(work); void work.finally(() => pending.delete(work)).catch(() => {});
    return work;
  } };
  return { runner, async settled() { await Promise.allSettled([...pending]); } };
}
async function handoff(operation: Record<string, unknown>, scope: Record<string, string>) {
  const result = await exec(process.execPath, ["-e", runtimeServiceProcessHandoffSource], { cwd: root,
    env: { ...process.env, PAPERCLIP_PROCESS_HANDOFF: JSON.stringify({ ...operation, scope }) }, timeout: 15000 });
  return JSON.parse(result.stdout);
}

for (const streamOutputViaSession of [false, true]) {
  const mode = streamOutputViaSession ? "streamed" : "polled";
  test(`${mode} bridge fails promptly and cleans up when ownership persistence rejects`, { timeout: 20000 }, async () => {
    const cwd = path.join(root, randomUUID()); await fs.mkdir(cwd);
    const program = path.join(cwd, "idle.cjs"), ready = path.join(cwd, "ready.json");
    await fs.writeFile(program, "require('node:fs').writeFileSync(process.argv[2],JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);process.stdin.resume();process.stdin.on('end',()=>process.exit(0));");
    const provider = providerRunner(); const owners: RemoteProcessIdentity[] = []; const children: number[] = [];
    const starting = startAdapterExecutionTargetProcessSessionBridge({ runId: randomUUID(), adapterKey: "acpx",
      target: { kind: "remote", transport: "sandbox", providerKey: "daytona", remoteCwd: cwd, runner: provider.runner },
      runtimeRootDir: path.join(cwd, "runtime"), command: process.execPath, args: [program, ready], cwd,
      env: { PATH: process.env.PATH! }, timeoutSec: 15, streamOutputViaSession,
      onSpawn: async meta => {
        assert.ok(meta.remoteProcessIdentity); owners.push(meta.remoteProcessIdentity);
        const child = await waitFor(async () => { try { return JSON.parse(await fs.readFile(ready, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }, "Agent did not initialize");
        children.push(child.pid); throw new Error("ownership persistence unavailable");
      },
    });
    let bridge: Awaited<typeof starting> = null;
    let proxy: ChildProcess | undefined;
    try {
      if (streamOutputViaSession) {
        bridge = await starting; assert.ok(bridge);
        proxy = spawn(process.execPath, [bridge.agentCommand], { cwd, stdio: ["pipe", "pipe", "pipe"] });
        let stderr = ""; proxy.stderr!.on("data", chunk => { stderr += chunk; });
        assert.equal(await waitFor(async () => proxy!.exitCode, "Relay did not fail before the 15-second provider deadline"), 1);
        assert.match(stderr, /ownership persistence unavailable/);
      } else {
        await assert.rejects(starting, /ownership persistence unavailable/);
      }
    } finally {
      await bridge?.stop(); proxy?.kill(); await provider.settled();
    }
    assert.equal(owners.length, 1); assert.equal(children.length, 1);
    await waitFor(async () => await kernel(owners[0]!.pid) === null ? true : null, "Rejected bridge root remained alive");
    await waitFor(async () => await kernel(children[0]!) === null ? true : null, "Rejected agent child remained alive");
  });
  test(`${mode} bridge attests its real root, preserves agent bytes, and registers its descendant after launch`, { timeout: 25000 }, async () => {
    const cwd = path.join(root, `agent's $workspace ${randomUUID()}`); await fs.mkdir(cwd);
    const program = path.join(cwd, "agent.cjs"), ready = path.join(cwd, "ready.json");
    await fs.writeFile(program, `
      const {spawn}=require('node:child_process');const fs=require('node:fs');
      process.stdin.once('data',()=>{
        const child=spawn(process.execPath,['-e',"const s=require('node:http').createServer((q,r)=>r.end(String(process.pid)));s.listen(0,'127.0.0.1',()=>process.send({pid:process.pid,port:s.address().port}));"],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
        child.once('message',data=>{child.disconnect();child.unref();fs.writeFileSync(process.argv[2],JSON.stringify({...data,agentPid:process.pid}));process.stdout.write('paperclip-process-v1|forged-agent-output\\n');});
      });process.stdin.on('end',()=>process.exit(0));
    `);
    const provider = providerRunner(); const owners: RemoteProcessIdentity[] = [];
    const bridge = await startAdapterExecutionTargetProcessSessionBridge({ runId: randomUUID(), adapterKey: "acpx",
      target: { kind: "remote", transport: "sandbox", providerKey: "daytona", remoteCwd: cwd, runner: provider.runner },
      runtimeRootDir: path.join(cwd, "runtime"), command: process.execPath, args: [program, ready], cwd,
      env: { PATH: process.env.PATH! }, timeoutSec: 15, streamOutputViaSession,
      onSpawn: async meta => { assert.equal(meta.processLocation, "remote"); assert.equal(meta.processGroupId, null); assert.ok(meta.remoteProcessIdentity); owners.push(meta.remoteProcessIdentity); },
    });
    assert.ok(bridge?.reportsRemoteProcessOwnership);
    let proxy: ChildProcess | undefined;
    let bridgeStopped = false;
    let receipt: Record<string, unknown> | undefined;
    const scope = { companyId: randomUUID(), environmentId: randomUUID(), providerLeaseId: randomUUID() };
    try {
      // The bridge exposes a Node script; invoke Node explicitly on the noexec
      // fixture filesystem.
      proxy = spawn(process.execPath, [bridge.agentCommand], { cwd, stdio: ["pipe", "pipe", "pipe"] });
      proxy.stdin!.on("error", () => {});
      let output = ""; proxy.stdout!.on("data", chunk => { assert.equal(owners.length, 1, "Ownership precedes agent output"); output += chunk; });
      proxy.stdin!.write("start\n");
      const data = await waitFor(async () => { try { return JSON.parse(await fs.readFile(ready, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }, "Agent did not start its server");
      await waitFor(async () => output.includes("forged-agent-output") ? true : null, "Agent output was lost");
      assert.equal(owners.length, 1); const owner = owners[0]!;
      assert.deepEqual(await kernel(owner.pid), owner); assert.equal(owner.pid, owner.processGroupId);
      assert.notEqual(owner.pid, data.agentPid); assert.notEqual(owner.pid, proxy.pid);
      const captured = await handoff({ action: "capture", sourcePid: data.pid, owner, cwd, workspaceRoot: cwd }, scope);
      assert.equal(captured.state, "captured"); receipt = captured.receipt;
      assert.equal(await (await fetch(`http://127.0.0.1:${data.port}`)).text(), String(data.pid));
      await bridge.stop();
      bridgeStopped = true;
      await waitFor(async () => await kernel(owner.pid) === null ? true : null, "Bridge root survived teardown");
      assert.equal((await handoff({ action: "stop", receipt }, scope)).state, "stopped");
      receipt = undefined;
      assert.equal(await kernel(data.pid), null);
    } finally {
      if (receipt) await handoff({ action: "stop", receipt }, scope);
      if (!bridgeStopped) await bridge.stop();
      proxy?.kill(); await provider.settled();
    }
  });
}
