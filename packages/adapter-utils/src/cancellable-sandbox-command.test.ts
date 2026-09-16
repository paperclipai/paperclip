import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { executeCancellableSandboxCommand } from "./cancellable-sandbox-command.js";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { runAdapterExecutionTargetProcess } from "./execution-target.js";
import { beginAdapterRunCancellation, cancelAdapterRunExecution, finishAdapterRunCancellation } from "./adapter-run-cancellation.js";

describe("sandbox CLI cancellation through the execution target", () => {
  it.each(["SIGTERM", "SIGKILL"] as const)("preserves a child's external %s termination", async (signal) => {
    const runId = randomUUID();
    beginAdapterRunCancellation(runId);
    const runner: CommandManagedRuntimeRunner = { execute: async (input) => new Promise((resolve, reject) => {
      const child = spawn(input.command === "node" ? process.execPath : input.command, input.args ?? [], { stdio: "ignore" });
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal, stdout: "", stderr: "", timedOut: false, pid: child.pid ?? null, startedAt: null }));
    }) };
    try {
      const result = await executeCancellableSandboxCommand(runId, runner, {
        command: process.execPath, args: ["-e", `process.kill(process.pid, '${signal}')`],
      }, 100);
      expect(result.signal).toBe(signal);
      expect(result.exitCode).toBeNull();
    } finally { finishAdapterRunCancellation(runId); }
  });

  it("retains a failed cancellation for an explicit retry", async () => {
    const runId = randomUUID();
    beginAdapterRunCancellation(runId);
    const result = { exitCode: 143, signal: null, stdout: "", stderr: "", timedOut: false, pid: null, startedAt: null };
    let complete!: (value: typeof result) => void;
    const running = new Promise<typeof result>((resolve) => { complete = resolve; });
    let requests = 0;
    const runner: CommandManagedRuntimeRunner = { execute: async (input) => {
      if (input.bypassSession) {
        requests++;
        if (requests === 1) return { ...result, exitCode: 1 };
        complete(result);
        return { ...result, exitCode: 0 };
      }
      return running;
    } };
    const execution = executeCancellableSandboxCommand(runId, runner, { command: "node", args: [] }, 100)
      .finally(() => finishAdapterRunCancellation(runId));
    try {
      await expect(cancelAdapterRunExecution(runId)).rejects.toThrow("execution may still be active");
      await cancelAdapterRunExecution(runId);
      expect((await execution).exitCode).toBe(143);
      expect(requests).toBe(2);
    } finally {
      complete(result);
      await execution;
    }
  });

  it("interrupts a live remote command before its own timeout and leaves the sandbox usable", async () => {
    const runId = randomUUID();
    beginAdapterRunCancellation(runId);
    let ready!: () => void;
    const readiness = new Promise<void>((resolve) => { ready = resolve; });
    const controls: boolean[] = [];
    const runner: CommandManagedRuntimeRunner = {
      execute: async (input) => {
        if (input.env?.PAPERCLIP_SANDBOX_EXEC_CHANNEL === "bridge") controls.push(input.bypassSession === true);
        const startedAt = new Date().toISOString();
        return new Promise((resolve, reject) => {
          const child = spawn(input.command === "node" ? process.execPath : input.command, input.args, {
            cwd: input.cwd, env: { ...process.env, ...input.env }, stdio: ["pipe", "pipe", "pipe"],
          });
          let stdout = "", stderr = "";
          child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.includes("READY")) ready(); });
          child.stderr.on("data", (chunk) => { stderr += chunk; });
          child.on("error", reject);
          child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr, timedOut: false, pid: child.pid ?? null, startedAt, finishedAt: new Date().toISOString() }));
          child.stdin.end(input.stdin);
        });
      },
    };
    const execution = runAdapterExecutionTargetProcess(runId, {
      kind: "remote", transport: "sandbox", providerKey: "daytona", environmentId: "environment",
      leaseId: "lease", remoteCwd: process.cwd(), runner,
    }, process.execPath, ["-e", "const {spawn}=require('node:child_process');spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});console.log('READY');setTimeout(()=>process.exit(0),1500)\"],{stdio:'inherit'});process.on('SIGTERM',()=>process.exit(0));setTimeout(()=>process.exit(0),1500)"], {
      cwd: process.cwd(), env: {}, timeoutSec: 10, graceSec: 0.1, onLog: async () => {},
    }).finally(() => finishAdapterRunCancellation(runId));
    await Promise.race([readiness, execution.then(() => { throw new Error("Command ended before readiness"); })]);
    const started = performance.now();
    await cancelAdapterRunExecution(runId);
    const result = await execution;
    expect(result.exitCode).toBe(143);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(controls).toEqual([true]);
    const after = await runner.execute({ command: "node", args: ["-e", "console.log('SAVE_AVAILABLE')"] });
    expect(after.stdout.trim()).toBe("SAVE_AVAILABLE");
  });
});
