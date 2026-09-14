/** Direct adapter CLI seam with actual Linux processes; no model or provider credentials. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { runAdapterExecutionTargetProcess, type AdapterSandboxExecutionTarget } from "../../packages/adapter-utils/src/execution-target.js";
import type { CommandManagedRuntimeRunner } from "../../packages/adapter-utils/src/command-managed-runtime.js";
import type { AdapterProcessSpawnMetadata } from "../../packages/adapter-utils/src/types.js";
import type { RemoteProcessIdentity } from "../../packages/adapter-utils/src/remote-process-identity.js";
import { runtimeServiceProcessHandoffSource } from "../../packages/plugins/sdk/src/runtime-service-process-handoff.js";

const exec = promisify(execFile);
let root: string;
before(async () => {
  assert.equal(process.platform, "linux"); assert.notEqual(process.getuid?.(), 0);
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cli-owner-")));
});
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

async function kernel(pid: number): Promise<RemoteProcessIdentity | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return null;
    return { version: 1, pid, uid: (await fs.stat(`/proc/${pid}`)).uid, processGroupId: Number(fields[2]),
      startTicks: fields[19]!, bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() };
  } catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null; throw error; }
}
async function waitFor<T>(read: () => Promise<T | null>, message: string): Promise<T> {
  for (let i = 0; i < 350; i++) { const value = await read(); if (value !== null) return value; await delay(20); }
  throw new Error(message);
}
async function readReady(file: string): Promise<{ pid: number; port?: number } | null> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function providerRunner() {
  const pending = new Set<Promise<unknown>>();
  const invocations: { useSession?: boolean; bypassSession?: boolean }[] = [];
  const runner: CommandManagedRuntimeRunner = { execute(input) {
    invocations.push({ useSession: input.useSession, bypassSession: input.bypassSession });
    const startedAt = new Date().toISOString();
    const work = new Promise<any>((resolve, reject) => {
      let logs = Promise.resolve();
      const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env },
        timeout: input.timeoutMs ?? 20000, maxBuffer: 8 * 1024 * 1024 }, async (error, stdout, stderr) => {
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
  return { runner, invocations, async settled() { await Promise.allSettled([...pending]); } };
}
function target(cwd: string, runner: CommandManagedRuntimeRunner, streamed: boolean): AdapterSandboxExecutionTarget {
  return { kind: "remote", transport: "sandbox", providerKey: "daytona", remoteCwd: cwd, runner,
    effectiveCapabilities: { reusableLeases: true, nativeSyncIn: false, nativeSyncOut: false,
      persistentProcessSessions: true, independentControlCommands: true, incrementalSessionOutput: streamed,
      concurrentSyncOperations: false, duplexCommandStream: false, runnerWebSocketIngress: false } };
}
async function handoff(operation: Record<string, unknown>, scope: Record<string, string>) {
  const result = await exec(process.execPath, ["-e", runtimeServiceProcessHandoffSource], { cwd: root,
    env: { ...process.env, PAPERCLIP_PROCESS_HANDOFF: JSON.stringify({ ...operation, scope }) }, timeout: 15000 });
  return JSON.parse(result.stdout);
}

for (const streamed of [false, true]) {
  const mode = streamed ? "streamed" : "polled";
  test(`${mode} direct CLI preserves stdin, argv, output and a registered server after completion`, { timeout: 30000 }, async () => {
    const cwd = path.join(root, randomUUID()); await fs.mkdir(cwd);
    const provider = providerRunner(); const owners: AdapterProcessSpawnMetadata[] = [];
    const program = path.join(cwd, "agent.cjs"), ready = path.join(cwd, "ready.json"), finish = path.join(cwd, "finish");
    const server = path.join(cwd, "server.cjs");
    await fs.writeFile(server, "const fs=require('node:fs');const s=require('node:http').createServer((q,r)=>r.end('preview'));s.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,port:s.address().port})));\n");
    await fs.writeFile(program, `const fs=require('node:fs'); let input=''; process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
  process.stdout.write(JSON.stringify({stdin:input,args:process.argv.slice(2),cwd:process.cwd(),env:process.env.FIXTURE_VALUE})+'\\n');
  process.stderr.write('unicode stderr: café 🌱\\n');
  process.stdout.write('paperclip-process-v1|forged-agent-output\\n');
  const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(server)},${JSON.stringify(ready)}],{detached:true,stdio:'ignore'});child.unref();
  const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})){clearInterval(timer);process.exitCode=0;}},20);
});`);
    const scope = { companyId: randomUUID(), environmentId: randomUUID(), providerLeaseId: randomUUID() };
    const stdout: string[] = [], stderr: string[] = [];
    let receipt: Record<string, unknown> | undefined;
    const running = runAdapterExecutionTargetProcess(randomUUID(), target(cwd, provider.runner, streamed), process.execPath,
      [program, "literal 'quotes' $() `text`", "line\nbreak"], {
        cwd, env: { PATH: process.env.PATH!, FIXTURE_VALUE: "explicit-value" }, stdin: "hello\n🌱 from stdin\n", timeoutSec: 15, graceSec: 1,
        onSpawn: async meta => { assert.equal(meta.processLocation, "remote"); assert.equal(meta.processGroupId, null); owners.push(meta); },
        onLog: async (stream, chunk) => { (stream === "stdout" ? stdout : stderr).push(chunk); },
        runLogTail: { create: () => { throw new Error("The old log tail must not duplicate bridge output"); } },
      });
    void running.catch(() => {});
    try {
      const data = await waitFor(() => readReady(ready), "CLI did not start server after stdin EOF");
      await waitFor(async () => owners.length ? true : null, "CLI owner missing");
      assert.equal(owners.length, 1); const owner = owners[0]!.remoteProcessIdentity!;
      assert.deepEqual(await kernel(owner.pid), owner);
      const capture = await handoff({ action: "capture", sourcePid: data.pid, owner, cwd, workspaceRoot: cwd }, scope);
      assert.equal(capture.state, "captured"); receipt = capture.receipt;
      await fs.writeFile(finish, "done");
      const result = await running;
      assert.equal(result.exitCode, 0); assert.equal(result.timedOut, false); assert.equal(result.pid, null);
      const lines = result.stdout.trimEnd().split("\n");
      assert.deepEqual(JSON.parse(lines[0]!), { stdin: "hello\n🌱 from stdin\n", args: ["literal 'quotes' $() `text`", "line\nbreak"], cwd, env: "explicit-value" });
      assert.equal(lines[1], "paperclip-process-v1|forged-agent-output"); assert.equal(lines.length, 2);
      assert.equal(result.stderr, "unicode stderr: café 🌱\n");
      assert.equal(stdout.join(""), result.stdout); assert.equal(stderr.join(""), result.stderr);
      assert.equal(provider.invocations.some(call => call.useSession), streamed);
      await waitFor(async () => await kernel(owner.pid) === null ? true : null, "CLI wrapper survived completion");
      assert.equal(await (await fetch(`http://127.0.0.1:${data.port}`)).text(), "preview");
      assert.equal((await handoff({ action: "stop", receipt }, scope)).state, "stopped"); receipt = undefined;
      assert.equal(await kernel(data.pid), null);
    } finally {
      await fs.writeFile(finish, "done");
      await running.catch(() => {});
      if (receipt) await handoff({ action: "stop", receipt }, scope);
      await provider.settled();
    }
  });

  test(`${mode} direct CLI preserves a nonzero exit and duplex completion failure`, { timeout: 25000 }, async () => {
    const cwd = path.join(root, randomUUID()); await fs.mkdir(cwd);
    const provider = providerRunner();
    for (const exitCode of [37, 0]) {
      let owner: RemoteProcessIdentity | undefined;
      let settlements = 0;
      const result = await runAdapterExecutionTargetProcess(randomUUID(), target(cwd, provider.runner, streamed), process.execPath,
        ["-e", `process.stdout.write('done\\n');process.stderr.write('diagnostic\\n');process.exitCode=${exitCode};`], {
          cwd, env: { PATH: process.env.PATH! }, stdin: "", timeoutSec: 10, graceSec: 1,
          onSpawn: async meta => { owner = meta.remoteProcessIdentity; }, onLog: async () => {},
          settleRunDisposition: () => { settlements++; return { failed: true, lossReason: "other" }; },
        });
      assert.ok(owner); assert.equal(result.stdout, "done\n"); assert.equal(result.timedOut, false);
      assert.equal(result.exitCode, exitCode === 0 ? 1 : exitCode);
      assert.equal(settlements, exitCode === 0 ? 1 : 0);
      if (exitCode === 0) assert.equal(result.errorCode, "duplex_channel_lost");
      else assert.equal(result.stderr, "diagnostic\n");
      await waitFor(async () => await kernel(owner!.pid) === null ? true : null, "CLI wrapper survived nonzero exit");
    }
    await provider.settled();
  });

  test(`${mode} direct CLI timeout cleans up a stubborn command and its wrapper`, { timeout: 20000 }, async () => {
    const cwd = path.join(root, randomUUID()); await fs.mkdir(cwd);
    const ready = path.join(cwd, "ready.json"); const provider = providerRunner();
    let owner: RemoteProcessIdentity | undefined;
    const result = await runAdapterExecutionTargetProcess(randomUUID(), target(cwd, provider.runner, streamed), process.execPath,
      ["-e", `require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`], {
        cwd, env: { PATH: process.env.PATH! }, timeoutSec: 1, graceSec: 0.2,
        onSpawn: async meta => { owner = meta.remoteProcessIdentity; }, onLog: async () => {},
      });
    assert.equal(result.timedOut, true); assert.ok(owner);
    const data = await readReady(ready); assert.ok(data);
    await waitFor(async () => await kernel(owner!.pid) === null && await kernel(data.pid) === null ? true : null,
      "Timed-out CLI or wrapper survived teardown");
    await provider.settled();
  });

  test(`${mode} direct CLI fails and stops when ownership cannot be persisted`, { timeout: 20000 }, async () => {
    const cwd = path.join(root, randomUUID()); await fs.mkdir(cwd);
    const ready = path.join(cwd, "ready.json"); const provider = providerRunner();
    let owner: RemoteProcessIdentity | undefined;
    const running = runAdapterExecutionTargetProcess(randomUUID(), target(cwd, provider.runner, streamed), process.execPath,
      ["-e", `require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`], {
        cwd, env: { PATH: process.env.PATH! }, timeoutSec: 10, graceSec: 1,
        onSpawn: async meta => {
          owner = meta.remoteProcessIdentity;
          await waitFor(() => readReady(ready), "CLI did not start before persistence failure");
          throw new Error("fixture database unavailable");
        }, onLog: async () => {},
      });
    if (streamed) {
      const result = await running;
      assert.equal(result.exitCode, 1); assert.equal(result.timedOut, false);
      assert.match(result.stderr, /fixture database unavailable/);
    } else await assert.rejects(running, /fixture database unavailable/);
    assert.ok(owner); const data = await readReady(ready); assert.ok(data);
    await waitFor(async () => await kernel(owner!.pid) === null && await kernel(data.pid) === null ? true : null,
      "CLI survived rejected ownership persistence");
    await provider.settled();
  });
}
