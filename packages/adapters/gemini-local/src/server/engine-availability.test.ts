import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGeminiExecutionEngineForRun } from "./acp.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

const remoteCommandProbe = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock("@paperclipai/adapter-utils/execution-target", async importOriginal => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  ensureAdapterExecutionTargetCommandResolvable: remoteCommandProbe,
}));

const originalVersion = process.version;
afterEach(() => Object.defineProperty(process, "version", { value: originalVersion }));

describe("gemini engine availability", () => {
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
    await expect(resolveGeminiExecutionEngineForRun({ config: { engine: "cli" } }))
      .resolves.toEqual({ engine: "cli", explicit: true });
  });

  it("keeps an unavailable ACP command as a failure, not a CLI selection", async () => {
    Object.defineProperty(process, "version", { value: "v24.11.0" });
    const result = await resolveGeminiExecutionEngineForRun({
      config: { agentCommand: "/nonexistent/paperclip-test/acp", command: "/nonexistent/paperclip-test/acp" },
    });
    expect(result.engine).toBe("acp");
    expect(result.unavailableReason).toContain("not available");
  });
});


describe("managed SSH ACP selection", () => {
  afterEach(() => remoteCommandProbe.mockReset().mockResolvedValue(undefined));
  it.each(["account", "host auth", "missing account", "missing command"])("checks the selected %s setup", async reason => {
    Object.defineProperty(process, "version", { value: "v24.11.0" });
    const config = { managedAiConnection: reason === "missing account" ? undefined : { identity: "fixture-account" } };
    const target = { kind: "remote" as const, transport: "ssh" as const, remoteCwd: "/remote/workspace",
      workspaceRealization: { mode: "in_place" as const, authoritativeRoot: "/remote/workspace", pathAliases: [], outboundRestorePaths: [] },
      spec: { useHostAuth: reason === "host auth", host: "ssh.example.test", port: 22, username: "fixture",
        remoteCwd: "/remote/workspace", remoteWorkspacePath: "/remote/workspace", privateKey: null, knownHosts: null, strictHostKeyChecking: true } };
    if (reason === "missing command") remoteCommandProbe.mockRejectedValueOnce(new Error("missing command"));
    const result = await resolveGeminiExecutionEngineForRun({ config, executionTarget: target });
    expect(result.engine).toBe("acp");
    if (reason === "account") {
      expect(result.unavailableReason).toBeUndefined();
      expect(remoteCommandProbe).toHaveBeenCalledOnce();
      expect(remoteCommandProbe.mock.calls[0]![3]).toEqual({ PATH: process.env.PATH });
    } else expect(result.unavailableReason).toBeTruthy();
  });
});
