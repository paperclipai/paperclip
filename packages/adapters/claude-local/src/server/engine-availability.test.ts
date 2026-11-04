import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveClaudeExecutionEngineForRun } from "./acp.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

const originalVersion = process.version;
afterEach(() => Object.defineProperty(process, "version", { value: originalVersion }));

describe("claude engine availability", () => {
  it.each([undefined, "auto", "acp"])("reports a setup failure for engine=%s without starting a process", async (engine) => {
    Object.defineProperty(process, "version", { value: "v18.0.0" });
    const config = { engine };
    const onSpawn = vi.fn();
    const result = await execute({ config, onSpawn } as never);
    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "adapter_engine_unavailable",
      errorMessage: expect.stringContaining("Node v18.0.0"),
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    expect(result.errorMessage).toContain(process.execPath);
    expect(onSpawn).not.toHaveBeenCalled();
    const diagnostic = await testEnvironment({ config } as never);
    expect(diagnostic.status).toBe("fail");
    expect(diagnostic.checks).toContainEqual(expect.objectContaining({
      code: "adapter_engine_unavailable", level: "error",
    }));
  });

  it("does not apply ACP prerequisites to explicitly selected CLI", async () => {
    Object.defineProperty(process, "version", { value: "v18.0.0" });
    await expect(resolveClaudeExecutionEngineForRun({ config: { engine: "cli" } }))
      .resolves.toEqual({ engine: "cli", explicit: true });
  });

  it("keeps an unavailable ACP command as a failure, not a CLI selection", async () => {
    Object.defineProperty(process, "version", { value: "v24.11.0" });
    const result = await resolveClaudeExecutionEngineForRun({
      config: { agentCommand: "/nonexistent/paperclip-test/acp", command: "/nonexistent/paperclip-test/acp" },
    });
    expect(result.engine).toBe("acp");
    expect(result.unavailableReason).toContain("not available");
  });
});


describe("cold sandbox ACP setup", () => {
  it("installs the default ACP server inside the selected sandbox without switching engines", async () => {
    Object.defineProperty(process, "version", { value: "v24.11.0" });
    let installed = false;
    const commands: string[] = [];
    const runner = { execute: async (input: { args: string[]; env?: Record<string, string> }) => {
      const command = input.args.join(" ");
      commands.push(command);
      expect(input.env?.ANTHROPIC_API_KEY).toBeUndefined();
      if (command.includes("npm install")) installed = true;
      return { exitCode: installed ? 0 : 1, timedOut: false, signal: null, stdout: installed ? "/usr/local/bin/claude-agent-acp" : "", stderr: "", pid: null, startedAt: new Date().toISOString() };
    }};
    await expect(resolveClaudeExecutionEngineForRun({ config: {}, executionTarget: {
      kind: "remote", transport: "sandbox", providerKey: "daytona", remoteCwd: "/work", runner,
    } as never })).resolves.toEqual({ engine: "acp", explicit: false });
    expect(commands.filter(command => command.includes("npm install"))).toHaveLength(1);
    expect(commands.some(command => command.includes("@agentclientprotocol/claude-agent-acp@0.73.0"))).toBe(true);
  });

  it("does not install or substitute for an operator's unavailable custom ACP command", async () => {
    Object.defineProperty(process, "version", { value: "v24.11.0" });
    const runner = { execute: vi.fn(async () => ({ exitCode: 1, timedOut: false, stdout: "", stderr: "", signal: null, pid: null, startedAt: new Date().toISOString() })) };
    const result = await resolveClaudeExecutionEngineForRun({ config: { agentCommand: "custom-acp" }, executionTarget: {
      kind: "remote", transport: "sandbox", providerKey: "daytona", remoteCwd: "/work", runner,
    } as never });
    expect(result).toMatchObject({ engine: "acp", unavailableReason: expect.stringContaining("custom-acp") });
    expect(runner.execute).toHaveBeenCalledTimes(1);
  });
});
