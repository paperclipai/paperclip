import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { assertNoHostAcpxAuthEnvironment, splitWindowsAgentCommand, stockAcpRuntimeOptions } from "./stock-runtime-options.js";
import { typedTerminalSessionFailure, typedTerminalTurnResult } from "./terminal-session-failure.js";

function fakeChild(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), { pid, stderr: new EventEmitter() }) as unknown as ChildProcess;
}

const base = { cwd: "/advertised" } as Parameters<typeof stockAcpRuntimeOptions>[0];
const launch = { launchId: "l", scope: { kind: "client" as const }, command: "agent", args: [], cwd: "/advertised" };

describe("stock ACPX spawn options", () => {
  it("passes options through untouched without engine hooks", () => {
    expect(stockAcpRuntimeOptions(base)).toEqual(base);
  });

  it("spawns in the host-only cwd and observes the agent's stderr", () => {
    const child = fakeChild(41);
    const spawnAgent = vi.fn((_input: unknown) => child);
    const stderr: string[] = [];
    const stock = stockAcpRuntimeOptions({ ...base, spawnAgent, spawnCwd: "/host", onAgentStderr: chunk => { stderr.push(chunk); throw new Error("ignored"); } });
    expect(stock).not.toHaveProperty("spawnCwd");
    expect(stock).not.toHaveProperty("onAgentStderr");
    expect(stock.spawnAgent!({ command: "agent", args: ["--acp"], options: { cwd: "/advertised", env: {} } })).toBe(child);
    expect(spawnAgent).toHaveBeenCalledWith({ command: "agent", args: ["--acp"], options: { cwd: "/host", env: {} } });
    child.stderr!.emit("data", Buffer.from("warning\n"));
    expect(stderr).toEqual(["warning\n"]);
  });

  it("admits only the agent process, not ACPX command probes", async () => {
    const onAgentSpawn = vi.fn(async () => {});
    const onSpawned = vi.fn();
    const stock = stockAcpRuntimeOptions({ ...base, spawnAgent: (_input: unknown) => fakeChild(42), onAgentSpawn, processLifecycle: { onSpawned } });
    stock.spawnAgent!({ command: "agent", args: [], options: {} });
    await stock.processLifecycle!.onSpawned!({ ...launch, pid: 7, startedAt: "t0" });
    expect(onAgentSpawn).not.toHaveBeenCalled();
    await stock.processLifecycle!.onSpawned!({ ...launch, pid: 42, startedAt: "t1" });
    expect(onAgentSpawn).toHaveBeenCalledExactlyOnceWith({ pid: 42, startedAt: "t1" });
    expect(onSpawned).toHaveBeenCalledTimes(2);
  });

  it("propagates an admission rejection so ACPX terminates the agent", async () => {
    const stock = stockAcpRuntimeOptions({ ...base, spawnAgent: (_input: unknown) => fakeChild(43), onAgentSpawn: async () => { throw new Error("not admitted"); } });
    stock.spawnAgent!({ command: "agent", args: [], options: {} });
    await expect(stock.processLifecycle!.onSpawned!({ ...launch, pid: 43, startedAt: "t" })).rejects.toThrow("not admitted");
  });
});

describe("agent environment", () => {
  it("launches with exactly the engine's environment, read at each spawn", () => {
    const spawnAgent = vi.fn((_input: unknown) => fakeChild(44));
    let current: Record<string, string> = { PATH: "/run-1/bin" };
    const stock = stockAcpRuntimeOptions({ ...base, spawnAgent, agentEnvironment: () => current });
    stock.spawnAgent!({ command: "agent", args: [], options: { env: { PATH: "/host/bin", HOST_SECRET: "x" } } });
    expect(spawnAgent).toHaveBeenLastCalledWith({ command: "agent", args: [], options: { env: { PATH: "/run-1/bin" } } });
    // A warm runtime respawns with the current run's environment.
    current = { PATH: "/run-2/bin" };
    stock.spawnAgent!({ command: "agent", args: [], options: { env: { PATH: "/host/bin" } } });
    expect(spawnAgent).toHaveBeenLastCalledWith({ command: "agent", args: [], options: { env: { PATH: "/run-2/bin" } } });
  });

  it("refuses host ACPX auth credentials that ACPX would apply to every agent", () => {
    expect(() => assertNoHostAcpxAuthEnvironment({ PATH: "/bin" })).not.toThrow();
    expect(() => assertNoHostAcpxAuthEnvironment({ ACPX_AUTH_OPENAI: "k", acpx_auth_x: "y" })).toThrow(/ACPX_AUTH_OPENAI, acpx_auth_x/);
  });
});

describe("Windows agent command split", () => {
  it("keeps backslashes and groups quoted words", () => {
    expect(splitWindowsAgentCommand('"C:\\Program Files\\nodejs\\node.exe" C:\\agents\\acp.js --flag \'a b\''))
      .toEqual(["C:\\Program Files\\nodejs\\node.exe", "C:\\agents\\acp.js", "--flag", "a b"]);
  });

  it("rejects an unterminated quote or an empty command", () => {
    expect(() => splitWindowsAgentCommand('"C:\\agent')).toThrow(/unterminated quote/);
    expect(() => splitWindowsAgentCommand("   ")).toThrow(/empty command/);
    expect(() => splitWindowsAgentCommand('"" x')).toThrow(/empty command/);
  });
});

describe("typed terminal session failures", () => {
  const meta = (failure: unknown) => ({ jetbrains: { air: { version: 1, sessionFailure: failure } } });

  it("reads typed errors and maps unknown categories", () => {
    expect(typedTerminalSessionFailure(meta({ severity: "error", category: "limit", title: "t", details: "d" }))).toEqual({ category: "limit", title: "t", details: "d" });
    expect(typedTerminalSessionFailure(meta({ severity: "error", category: "other" }))).toEqual({ category: "unknown" });
    for (const value of [undefined, {}, meta({ severity: "warning", category: "limit" }), { jetbrains: { air: { version: 0, sessionFailure: { severity: "error" } } } }]) {
      expect(typedTerminalSessionFailure(value)).toBeNull();
    }
  });

  it("fails a normally stopped turn and leaves other results unchanged", () => {
    const onFailure = vi.fn();
    expect(typedTerminalTurnResult({ status: "completed", _meta: meta({ severity: "error", category: "service" }) }, onFailure))
      .toEqual({ status: "failed", error: { message: "ACP agent reported a terminal service failure.", code: "RUNTIME" } });
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({ category: "service" });
    const completed = { status: "completed" as const, stopReason: "end_turn" };
    expect(typedTerminalTurnResult(completed, onFailure)).toBe(completed);
    const failed = { status: "failed" as const, error: { message: "x" } };
    expect(typedTerminalTurnResult(failed, onFailure)).toBe(failed);
  });
});
