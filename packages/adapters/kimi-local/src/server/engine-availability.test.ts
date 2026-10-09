import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveKimiExecutionEngineForRun } from "./acp.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

const originalVersion = process.version;
afterEach(() => Object.defineProperty(process, "version", { value: originalVersion }));

describe("kimi engine availability", () => {
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
    await expect(resolveKimiExecutionEngineForRun({ config: { engine: "cli" } }))
      .resolves.toEqual({ engine: "cli", explicit: true });
  });

  it("keeps an unavailable ACP command as a failure, not a CLI selection", async () => {
    Object.defineProperty(process, "version", { value: "v24.11.0" });
    const result = await resolveKimiExecutionEngineForRun({
      config: { agentCommand: "/nonexistent/paperclip-test/acp", command: "/nonexistent/paperclip-test/acp" },
    });
    expect(result.engine).toBe("acp");
    expect(result.unavailableReason).toContain("not available");
  });
});
