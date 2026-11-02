import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runChildProcess, runningProcesses, signalRunningProcess } from "./server-utils.js";
import { hasStoppedWindowsProcessJob, recordWindowsProcessJobIdentity, settleWindowsProcessJob, spawnWindowsProcessJob } from "./windows-process-job.js";

type ProcessIdentity = { processPid: number; processStartedAt: Date };
const released = (identity: ProcessIdentity) => hasStoppedWindowsProcessJob(identity.processPid, identity.processStartedAt);

describe.skipIf(process.platform !== "win32")("Windows process handoff settlement", () => {
  it("waits for host identity persistence when a fast provider has already exited", async () => {
    let releaseIdentity: (() => void) | undefined;
    let outputSeen!: () => void;
    const output = new Promise<void>(resolve => { outputSeen = resolve; });
    let returned = false;
    const done = runChildProcess(randomUUID(), process.execPath, ["-e", "console.log('finished')"], {
      cwd: tmpdir(), env: {}, timeoutSec: 15, graceSec: 2,
      onSpawn: () => new Promise<void>(resolve => { releaseIdentity = resolve; }),
      onLog: async (_stream, text) => { if (text.includes("finished")) outputSeen(); },
    }).then(result => { returned = true; return result; });
    try {
      await output;
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(returned).toBe(false);
    } finally { releaseIdentity?.(); await done; }
  });

  it("preserves stdin, environment, Unicode and quoted arguments", async () => {
    const args = ["a b", 'a"b', "trailing\\", "a&b", "é漢"];
    const result = await runChildProcess(randomUUID(), process.execPath, ["-e", "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(1),stdin:s,env:process.env.JOB_TEST_VALUE})))", ...args], {
      cwd: tmpdir(), env: { JOB_TEST_VALUE: "fixture" }, stdin: "synthetic stdin", timeoutSec: 15, graceSec: 2,
      onLog: async () => {}, onSpawn: async () => {},
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ args, stdin: "synthetic stdin", env: "fixture" });
  });

  it("keeps Windows command wrappers working in a directory with spaces", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip job command "));
    const command = path.join(dir, "echo fixture.cmd");
    try {
      await writeFile(command, "@echo off\r\necho %~1\r\n");
      const result = await runChildProcess(randomUUID(), command, ["hello world"], {
        cwd: dir, env: {}, timeoutSec: 15, graceSec: 2, onLog: async () => {}, onSpawn: async () => {},
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("hello world");
    } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  });

  it("does not grant release when the supervisor is killed before its kernel receipt", async () => {
    const child = await spawnWindowsProcessJob(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "pipe"] });
    const identity = { processPid: child.pid!, processStartedAt: new Date() };
    recordWindowsProcessJobIdentity(child, identity.processStartedAt.toISOString());
    await new Promise(resolve => child.stdout!.once("data", resolve));
    const closed = new Promise(resolve => child.once("close", resolve));
    process.kill(child.pid!);
    await closed;
    await settleWindowsProcessJob(child);
    expect(released(identity)).toBe(false);
  });

  it("settles an owned process and its closed-stdio background child before returning", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-windows-handoff-test-"));
    const output = path.join(dir, "writer.txt");
    let writerPid = 0;
    let identity: ProcessIdentity | undefined;
    const writer = "require('node:fs').appendFileSync(process.argv[1], 'ready'); setInterval(()=>require('node:fs').appendFileSync(process.argv[1], 'x'), 20)";
    const parent = "const c=require('node:child_process').spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:'ignore'});c.unref();console.log(c.pid);setTimeout(()=>{},300);";
    try {
      const result = await runChildProcess(randomUUID(), process.execPath, ["-e", parent, writer, output], {
        cwd: dir, env: {}, timeoutSec: 15, graceSec: 2, onLog: async () => {},
        onSpawn: async meta => { identity = { processPid: meta.pid, processStartedAt: new Date(meta.startedAt) }; },
      });
      writerPid = Number(result.stdout.trim());
      expect(result.exitCode, result.stderr).toBe(0);
      expect(writerPid).toBeGreaterThan(1);
      expect(released(identity!)).toBe(true);
      const before = await readFile(output, "utf8");
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(await readFile(output, "utf8")).toBe(before);
      expect(() => process.kill(writerPid, 0)).toThrow();
    } finally {
      if (writerPid > 1) { try { process.kill(writerPid); } catch {} }
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("settles an owned Stop without treating a PID from another generation as released", async () => {
    const runId = randomUUID();
    let identity: ProcessIdentity | undefined;
    const done = runChildProcess(runId, process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"], {
      cwd: tmpdir(), env: {}, timeoutSec: 15, graceSec: 2,
      onSpawn: async meta => { identity = { processPid: meta.pid, processStartedAt: new Date(meta.startedAt) }; },
      onLog: async (_stream, text) => { if (text.includes("ready")) signalRunningProcess(runningProcesses.get(runId)!, "SIGTERM"); },
    });
    await done;
    expect(released(identity!)).toBe(true);
    expect(released({ ...identity!, processStartedAt: new Date(0) })).toBe(false);
  });
});
