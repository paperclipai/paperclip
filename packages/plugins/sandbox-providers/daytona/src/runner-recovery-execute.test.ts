import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { Sandbox } from "@daytonaio/sdk";
import type { PluginEnvironmentExecuteResult, PluginEnvironmentRunnerRecoveryExecuteParams } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

// Provider unit tests use injected sandbox objects; the standalone SDK is not
// installed by the root workspace test command.
vi.mock("@daytonaio/sdk", () => ({ DaytonaNotFoundError: class extends Error {} }));
import { handleDaytonaRunnerRecoveryExecute, runnerRecoveryExecuteSource } from "./runner-recovery-execute.js";

function fixture() {
  const input: PluginEnvironmentRunnerRecoveryExecuteParams = { companyId: randomUUID(), environmentId: randomUUID(), providerLeaseId: randomUUID(),
    driverKey: "daytona", config: {}, workspaceRoot: "/workspace/app", execution: { command: "tar", args: ["-czf", "-", "."], timeoutMs: 120_000 },
    workspaceConnection: { scopeId: randomUUID(), fingerprint: "a".repeat(64) },
    owner: { version: 1, pid: 40, processGroupId: 40, uid: 1000, bootId: randomUUID(), startTicks: "100" } };
  const sandbox = { id: input.providerLeaseId, state: "started", labels: { "paperclip-company-id": input.companyId, "paperclip-environment-id": input.environmentId },
    refreshData: vi.fn(async () => {}), start: vi.fn(), stop: vi.fn(), delete: vi.fn(),
    process: { executeCommand: vi.fn(async () => ({ exitCode: 0, result: JSON.stringify({ state: "running" }) })) } };
  const result: PluginEnvironmentExecuteResult = { exitCode: 0, timedOut: false, stdout: "checkpoint", stderr: "" };
  const execute = vi.fn(async (_command: PluginEnvironmentRunnerRecoveryExecuteParams["execution"]) => result);
  const run = () => handleDaytonaRunnerRecoveryExecute(sandbox as unknown as Sandbox, input, execute);
  return { input, sandbox, result, execute, run };
}
describe("original allocation recovery commands", () => {
  it.each(["running", "exited"])("permits checkpoint work with a verified %s root on already-started compute", async state => {
    const f = fixture(); f.sandbox.process.executeCommand.mockResolvedValue({ exitCode: 0, result: JSON.stringify({ state }) });
    expect(await f.run()).toEqual({ state: "executed", workspaceConnection: f.input.workspaceConnection, result: f.result });
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ command: "/usr/bin/env", cwd: "/", timeoutMs: 120_000 }));
    expect(JSON.parse(f.execute.mock.calls[0]![0].env!.PAPERCLIP_RECOVERY_EXECUTION)).toEqual({ root: f.input.workspaceRoot, cwd: f.input.workspaceRoot, command: "tar", args: ["-czf", "-", "."] });
    expect(f.sandbox.refreshData).toHaveBeenCalledTimes(2);
    for (const mutation of [f.sandbox.start, f.sandbox.stop, f.sandbox.delete]) expect(mutation).not.toHaveBeenCalled();
  });
  it.each(["stopped", "archived", "starting", "stopping", "error"])("does not execute or wake %s compute", async state => {
    const f = fixture(); f.sandbox.state = state;
    expect(await f.run()).toEqual({ state: "unverified" }); expect(f.execute).not.toHaveBeenCalled(); expect(f.sandbox.process.executeCommand).not.toHaveBeenCalled();
    expect(f.sandbox.start).not.toHaveBeenCalled();
  });
  it.each(["mismatch", "unverified"])("refuses commands for %s process evidence", async state => {
    const f = fixture(); f.sandbox.process.executeCommand.mockResolvedValue({ exitCode: 0, result: JSON.stringify({ state }) });
    expect(await f.run()).toEqual({ state: "unverified" }); expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(["cwd", "root", "nul", "timeout", "negative_timeout", "infinite_timeout"])("refuses invalid %s before contacting compute", async cause => {
    const f = fixture();
    if (cause === "cwd") f.input.execution.cwd = "/workspace/other";
    if (cause === "root") f.input.workspaceRoot = "/";
    if (cause === "nul") f.input.execution.args = ["bad\0argument"];
    if (cause === "timeout") f.input.execution.timeoutMs = 120_001;
    if (cause === "negative_timeout") f.input.execution.timeoutMs = -1;
    if (cause === "infinite_timeout") f.input.execution.timeoutMs = Infinity;
    expect(await f.run()).toEqual({ state: "unverified" }); expect(f.sandbox.refreshData).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(["stopped", "ownership", "timeout", "no_exit"])("withholds results after %s uncertainty", async cause => {
    const f = fixture(); f.execute.mockImplementation(async () => {
      if (cause === "stopped") f.sandbox.state = "stopped";
      if (cause === "ownership") f.sandbox.labels["paperclip-company-id"] = randomUUID();
      return { ...f.result, timedOut: cause === "timeout", exitCode: cause === "no_exit" ? null : 0 };
    });
    expect(await f.run()).toEqual({ state: "unverified" }); expect(f.sandbox.start).not.toHaveBeenCalled();
  });
  it("preserves an ordinary command failure without reporting successful checkpoint work", async () => {
    const f = fixture(); f.result.exitCode = 2; f.result.stderr = "missing directory";
    expect(await f.run()).toMatchObject({ state: "executed", result: { exitCode: 2, stderr: "missing directory" } });
  });
});


describe("recovery command physical working directory", () => {
  it.each(["root", "nested", "swap"])("rejects redirected paths or pins cwd through a %s substitution", async kind => {
    const temp = await realpath(await mkdtemp(path.join(tmpdir(), "recovery-cwd-")));
    const root = path.join(temp, "workspace"), outside = path.join(temp, "outside");
    const cwd = path.join(root, "child");
    await mkdir(cwd, { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(cwd, "sentinel"), "approved");
    await writeFile(path.join(outside, "sentinel"), "outside");
    let source = runnerRecoveryExecuteSource;
    try {
      if (kind === "root") {
        await rm(root, { recursive: true });
        await symlink(outside, root);
      } else if (kind === "nested") {
        await rm(cwd, { recursive: true });
        await symlink(outside, cwd);
      } else {
        // Inject the filesystem race at the real spawn boundary. The child
        // must inherit the pinned directory instead of reopening the cwd path.
        source = `const cp = require('node:child_process'); const originalSpawn = cp.spawn;
          cp.spawn = (...args) => {
            const fs = require('node:fs');
            fs.renameSync(${JSON.stringify(cwd)}, ${JSON.stringify(cwd + "-retained")});
            fs.symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(cwd)});
            return originalSpawn(...args);
          };\n` + source;
      }
      const execution = promisify(execFile)(process.execPath, ["-e", source], {
        env: { ...process.env, PAPERCLIP_RECOVERY_EXECUTION: JSON.stringify({ root, cwd, command: process.execPath,
          args: ["-e", "process.stdout.write(require('node:fs').readFileSync('sentinel', 'utf8'))"] }) },
      });
      if (kind === "swap") expect((await execution).stdout).toBe("approved");
      else await expect(execution).rejects.toMatchObject({ code: 125, stderr: "PAPERCLIP_RECOVERY_CWD_UNVERIFIED" });
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
