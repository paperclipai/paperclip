import { describe, expect, it, vi } from "vitest";

const { executeAcp, runProcess } = vi.hoisted(() => ({
  executeAcp: vi.fn(async () => { throw new Error("ACP session startup failed"); }),
  runProcess: vi.fn(),
}));

vi.mock("./acp.js", () => ({
  createKimiAcpExecutor: () => executeAcp,
  resolveKimiExecutionEngineForRun: async () => ({ engine: "acp", explicit: false }),
}));
vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  runAdapterExecutionTargetProcess: runProcess,
}));

import { execute } from "./execute.js";

describe("Kimi ACP failure handling", () => {
  it("does not replay a failed default ACP invocation through CLI", async () => {
    await expect(execute({ config: {} } as never)).rejects.toThrow("ACP session startup failed");
    expect(executeAcp).toHaveBeenCalledTimes(1);
    expect(runProcess).not.toHaveBeenCalled();
  });
});
