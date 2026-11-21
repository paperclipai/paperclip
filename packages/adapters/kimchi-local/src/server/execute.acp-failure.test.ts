import { describe, expect, it, vi } from "vitest";
import type { KimchiEngineSelection } from "./acp.js";

const { executeAcp, resolveEngine } = vi.hoisted(() => ({
  executeAcp: vi.fn(async () => { throw new Error("ACP session startup failed"); }),
  resolveEngine: vi.fn(async (_input: unknown): Promise<KimchiEngineSelection> => ({ engine: "acp", explicit: false })),
}));

vi.mock("./acp.js", () => ({
  createKimchiAcpExecutor: () => executeAcp,
  resolveKimchiExecutionEngineForRun: resolveEngine,
}));

import { execute } from "./execute.js";

describe("Kimchi ACP failure handling", () => {
  it("propagates a failed ACP invocation instead of falling back to a CLI lane", async () => {
    await expect(execute({ config: {} } as never)).rejects.toThrow("ACP session startup failed");
    expect(executeAcp).toHaveBeenCalledTimes(1);
  });

  it("returns the adapter_engine_unavailable setup error when ACP prerequisites are missing", async () => {
    resolveEngine.mockResolvedValueOnce({
      engine: "acp",
      explicit: false,
      unavailableReason: "Kimchi ACP command is not available: kimchi --mode acp.",
    });
    const result = await execute({ config: {} } as never);
    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "adapter_engine_unavailable",
      errorMessage: "Kimchi ACP command is not available: kimchi --mode acp.",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
  });
});
