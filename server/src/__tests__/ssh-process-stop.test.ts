import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { terminateLocalService } from "../services/local-service-supervisor.js";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { runningProcesses } from "@paperclipai/adapter-utils/server-utils";
import {
  buildSshEnvLabFixtureConfig,
  buildSshSpawnTarget,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshEnvLabFixtureState,
} from "@paperclipai/adapter-utils/ssh";

// Real SSH with disposable loopback keys. No provider, API, agent, or database.
describe("OpenCode SSH transport process termination", { concurrent: false }, () => {
  let root: string;
  let fixture: SshEnvLabFixtureState;

  beforeAll(async () => {
    const support = await getSshEnvLabSupport();
    if (!support.supported) throw new Error(support.reason ?? "SSH unavailable");
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-stop-"));
    fixture = await startSshEnvLabFixture({ statePath: path.join(root, "state.json") });
  }, 30_000);

  afterAll(async () => {
    if (fixture) await stopSshEnvLabFixture(fixture);
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function isRunning(pid: number) {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    return stat.length > 0 && !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2)[0]);
  }

  it.each(["clean", "timeout", "cancel", "kill", "failure", "concurrent", "identity", "error", "deadline", "warning"] as const)("stops remote processes and retains output after %s", async mode => {
    const timed = ["timeout", "kill", "concurrent"].includes(mode);
    const nonce = randomUUID();
    const runId = `ssh-stop-${nonce}`;
    const spec = { ...await buildSshEnvLabFixtureConfig(fixture), remoteCwd: fixture.workspaceDir };
    if (mode === "warning") spec.strictHostKeyChecking = false;
    const remotePids: number[] = [];
    const chunks: string[] = [];
    const stopped = vi.fn();
    const childScript = `process.on('SIGHUP',()=>{});${mode === "kill" ? "process.on('SIGTERM',()=>{});" : ""}setInterval(()=>{},1000);/*${nonce}*/`;
    const script = `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});
      process.stdout.on('error',()=>{});
      process.stderr.on('error',()=>{});
      process.on('SIGHUP',()=>{});
      process.on('SIGTERM',()=>{if (${JSON.stringify(mode)}==='kill') return;if (${JSON.stringify(mode)}==='warning') process.stderr.write('SHUTDOWN:${nonce}\\n');child.kill('SIGTERM');process.stdout.write('FINAL:${nonce}\\n',()=>process.exit(0));});
      console.log('INPUT:'+require('node:fs').readFileSync(0,'utf8'));
      console.log('UNICODE:£🐟');
      console.log('READY:${nonce}:'+process.pid+':'+child.pid);
      console.error('STDERR:${nonce}');
      if (['clean','error','deadline'].includes(${JSON.stringify(mode)})) setTimeout(()=>{child.kill('SIGTERM');console.log('NATURAL:${nonce}');process.stdout.write('FINAL:${nonce}\\n',()=>process.exit(${mode === 'error' ? 23 : 0}));},100);
      else setInterval(()=>process.stdout.write('TICK:${nonce}\\n'),50);
    `;
    let pending: ReturnType<typeof runAdapterExecutionTargetProcess> | undefined;
    let guard: ReturnType<typeof runAdapterExecutionTargetProcess> | undefined;
    let guardPid = 0;
    const guardId = `guard-${nonce}`;
    const guardNonce = `GUARD-${nonce}`;
    const stopLocal = async (id: string) => {
      const owned = runningProcesses.get(id);
      if (owned) await terminateLocalService({ pid: owned.child.pid!, processGroupId: owned.processGroupId }, { forceAfterMs: 100 });
    };
    try {
      if (mode === "concurrent" || mode === "identity") {
        guard = runAdapterExecutionTargetProcess(guardId, {
          kind: "remote", transport: "ssh", spec, remoteCwd: fixture.workspaceDir,
        }, process.execPath, ["-e", `process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>process.exit(0));console.log('${guardNonce}:'+process.pid);setInterval(()=>{},1000);`], {
          cwd: root, env: {}, timeoutSec: 15, graceSec: 0.1,
          onLog: async (_stream, chunk) => {
            const match = chunk.match(new RegExp(`${guardNonce}:(\\d+)`));
            if (match) guardPid = Number(match[1]);
          },
        });
        await expect.poll(() => guardPid, { timeout: 5_000 }).toBeGreaterThan(0);
      }
      pending = runAdapterExecutionTargetProcess(runId, {
        kind: "remote", transport: "ssh", spec, remoteCwd: fixture.workspaceDir,
      }, process.execPath, ["-e", script], {
        cwd: root, env: {}, stdin: "provider-free", timeoutSec: mode === "deadline" ? 0.8 : timed ? 3 : 10, graceSec: 0.1,
        onProcessStopped: stopped,
        onLog: async (_stream, chunk) => {
          chunks.push(chunk);
          const match = chunks.join("").match(new RegExp(`READY:${nonce}:(\\d+):(\\d+)`));
          if (match && !remotePids.length) remotePids.push(Number(match[1]), Number(match[2]));
        },
      });
      await expect.poll(() => remotePids.length, { timeout: 5_000 }).toBe(2);
      if (mode === "cancel" || mode === "failure" || mode === "identity" || mode === "warning") {
        if (mode === "identity") {
          const stat = await readFile(`/proc/${remotePids[0]}/stat`, "utf8");
          const group = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2];
          let changed = false;
          for (const name of await readdir(os.tmpdir())) {
            if (!name.startsWith("paperclip-ssh-")) continue;
            const dir = path.join(os.tmpdir(), name);
            if ((await readFile(path.join(dir, "group"), "utf8").catch(() => "")).trim() === group) {
              await writeFile(path.join(dir, "reader"), String(guardPid));
              changed = true;
            }
          }
          expect(changed).toBe(true);
        }
        // Existing connection remains open, but cleanup cannot open a new one.
        if (mode === "failure") spec.port = 1;
        await stopLocal(runId);
      }
      const result = await pending;
      expect(result.stdout).toContain(`READY:${nonce}`);
      if (mode === "warning") {
        expect(result.stderr.split(`SHUTDOWN:${nonce}`).length - 1).toBe(1);
        expect(result.stderr.split("Permanently added").length - 1).toBe(1);
      }
      else expect(result.stderr).toBe(`STDERR:${nonce}\n`);
      expect.soft(result.stdout).toContain("INPUT:provider-free");
      expect(result.stdout.split("UNICODE:£🐟").length - 1).toBe(1);
      expect(chunks.join("")).toContain(`READY:${nonce}`);
      if (mode === "deadline") { console.log(JSON.stringify({mode, timedOut: result.timedOut, naturalExit: result.stdout.includes(`NATURAL:${nonce}`)})); expect(result.stdout).toContain(`NATURAL:${nonce}`); }
      expect(result.timedOut).toBe(timed);
      if (mode === "clean" || mode === "error") {
        expect(result.exitCode).toBe(mode === "error" ? 23 : 0);
        expect(result.signal).toBeNull();
      }
      expect(runningProcesses.has(runId)).toBe(false);
      const alive = await Promise.all(remotePids.map(isRunning));
      console.log(JSON.stringify({ mode, timedOut: result.timedOut, signal: result.signal,
        exitCode: result.exitCode, initialOutputCaptured: true,
        finalOutputCaptured: result.stdout.includes(`FINAL:${nonce}`),
        remoteParentAlive: alive[0], remoteChildAlive: alive[1],
        providerStopConfirmed: stopped.mock.calls.length > 0 }));
      if (mode === "failure" || mode === "identity") {
        expect(result.errorCode).toBe("ssh_remote_cleanup_failed");
        expect(result.remoteProcessStopped).toBe(false);
        expect(stopped).not.toHaveBeenCalled();
        expect(alive).toEqual([true, true]);
      } else {
        expect(stopped).toHaveBeenCalledOnce();
        expect(result.remoteProcessStopped).toBe(true);
        if (mode !== "kill") expect(result.stdout).toContain(`FINAL:${nonce}`);
        await expect.poll(async () => Promise.all(remotePids.map(isRunning)), { timeout: 1_000 }).toEqual([false, false]);
        // Recovery appends only unseen bytes, without replaying earlier logs.
        expect(result.stdout.split(`READY:${nonce}`).length - 1).toBe(1);
        expect(chunks.join("").split(`READY:${nonce}`).length - 1).toBe(1);
      }
      if (mode === "concurrent" || mode === "identity") {
        expect(await isRunning(guardPid)).toBe(true);
        await stopLocal(guardId);
        expect((await guard!).remoteProcessStopped).toBe(true);
        expect(await isRunning(guardPid)).toBe(false);
      }
    } finally {
      if (guard) { await stopLocal(guardId); await guard.catch(() => undefined); }
      // Assertion failure must not leave the reproduced orphan behind. The nonce
      // proves ownership before any signal; never signal an arbitrary stored PID.
      for (const pid of remotePids) {
        const cmd = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
        if (cmd.includes(nonce)) {
          // The test-only failure case cannot use the unavailable SSH channel.
          // Verify its nonce before stopping that test's group, including owner.
          const stat = await readFile(`/proc/${pid}/stat`, "utf8");
          const group = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
          try { process.kill(-group, "SIGKILL"); } catch { /* already exited */ }
          for (const name of await readdir(os.tmpdir())) {
            if (!name.startsWith("paperclip-ssh-")) continue;
            const dir = path.join(os.tmpdir(), name);
            if ((await readFile(path.join(dir, "group"), "utf8").catch(() => "")).trim() === String(group)) {
              await expect.poll(async () => Boolean(await readFile(path.join(dir, "drained")).catch(() => null)), { timeout: 2_000 }).toBe(true);
              await rm(dir, { recursive: true, force: true });
            }
          }
        }
      }
      for (const pid of remotePids) {
        await expect.poll(() => isRunning(pid), { timeout: 2_000 }).toBe(false);
      }
      if (pending) await pending.catch(() => undefined);
      console.log(JSON.stringify({ mode, testCleanupNoLiveRemoteProcesses: true }));
    }
  }, 20_000);
  it("fences a delayed launch after cancellation before SSH spawn", async () => {
    const before = new Set(await readdir(os.tmpdir()));
    const spec = {...await buildSshEnvLabFixtureConfig(fixture), remoteCwd: fixture.workspaceDir};
    const marker = path.join(fixture.workspaceDir, "must-not-start");
    const target = await buildSshSpawnTarget({spec, command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
      env: {}, ownedProcessGraceSec: 0.1});
    try {
      expect((await target.finish!(0, 0)).stopped).toBe(true);
      const launched = promisify(execFile)(target.command, target.args, {timeout: 5_000});
      launched.child.stdin?.end(target.stdinPrefix);
      await expect(launched).rejects.toMatchObject({code: 125});
      expect(await readFile(marker).catch(() => null)).toBeNull();
    } finally {
      await target.finish!(0, 0);
      await target.cleanup();
      // The test has consumed the only delayed launch. Its fence is now safe
      // to remove; runtime cleanup must retain it while a late launch can race.
      for (const name of await readdir(os.tmpdir())) {
        if (!before.has(name) && name.startsWith("paperclip-ssh-")) {
          const dir = path.join(os.tmpdir(), name);
          if ((await readdir(dir)).join() === "cancelled") await rm(dir, {recursive: true});
        }
      }
    }
  }, 10_000);

  it("rejects incomplete output recovery when the remote spool is missing", async () => {
    const spec = {...await buildSshEnvLabFixtureConfig(fixture), remoteCwd: fixture.workspaceDir};
    const target = await buildSshSpawnTarget({spec, command: process.execPath,
      args: ["-e", "process.on('SIGTERM',()=>process.exit(0));console.log('SPOOL_READY');setInterval(()=>{},1000)"],
      env: {}, ownedProcessGraceSec: 0.1});
    const dir = Buffer.from(target.stdinPrefix.trim(), "base64").toString("utf8").match(/\/tmp\/paperclip-ssh-[a-f0-9-]+/)![0];
    const proc = spawn(target.command, target.args, {stdio: ["pipe", "pipe", "pipe"]});
    proc.stdin?.end(target.stdinPrefix);
    let stdout = "";
    proc.stdout.on("data", chunk => {stdout += String(chunk);});
    proc.stderr.resume();
    const finished = new Promise<void>(resolve => proc.once("close", () => resolve()));
    try {
      await expect.poll(() => stdout, {timeout: 5_000}).toContain("SPOOL_READY");
      await unlink(path.join(dir, "stdout"));
      const result = await target.finish!(0, 0);
      console.log(JSON.stringify({missingSpoolAccepted: result.stopped, recoveredBytes: result.stdout.length}));
      expect(result.stopped).toBe(false);
      expect(await readdir(dir)).toContain("stderr");
    } finally {
      await target.finish!(0, 0);
      await finished;
      await target.cleanup();
      await rm(dir, {recursive: true, force: true});
    }
  }, 15_000);

  it("preserves stdin through the native SSH launcher on the target shell", async () => {
    const spec = {...await buildSshEnvLabFixtureConfig(fixture), remoteCwd: fixture.workspaceDir};
    const result = await runAdapterExecutionTargetProcess(randomUUID(), {
      kind: "remote", transport: "ssh", spec, remoteCwd: fixture.workspaceDir,
    }, process.execPath, ["-e", "process.stdout.write(require('node:fs').readFileSync(0,'utf8'))"], {
      cwd: root, env: {}, stdin: "provider-free prompt", timeoutSec: 5, graceSec: 0.1,
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("provider-free prompt");
  }, 10_000);

});
