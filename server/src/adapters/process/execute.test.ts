import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runChildProcess: vi.fn(),
}));

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  runChildProcess: mocks.runChildProcess,
}));

import { execute } from "./execute.js";

describe("process adapter execution", () => {
  it("fails when a child is terminated by a signal with no exit code", async () => {
    mocks.runChildProcess.mockResolvedValueOnce({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      stdout: "",
      stderr: "",
    });

    const result = await execute({
      runId: "signal-test",
      agent: { id: "agent", companyId: "company" },
      config: { command: process.execPath },
      onLog: async () => {},
      onMeta: async () => {},
    } as any);

    expect(result).toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
    });
    expect(result.errorMessage).toContain("SIGTERM");
    expect(result.resultJson).toEqual({ stdout: "", stderr: "" });
  });
});
