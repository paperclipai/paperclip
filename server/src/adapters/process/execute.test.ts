import { describe, expect, it } from "vitest";
import { execute } from "./execute.js";

describe("process adapter execute", () => {
  it("preserves partial stdout and stderr when a process times out", async () => {
    const result = await execute({
      runId: "run-process-timeout-partial-output",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Process Agent",
        adapterType: "process",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write('partial report path: /tmp/bookforge-report.json'); process.stderr.write('partial warning'); setInterval(() => {}, 1000);",
        ],
        timeoutSec: 1,
        graceSec: 1,
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    });

    expect(result.timedOut).toBe(true);
    expect(result.errorMessage).toContain("Timed out after 1s");
    expect(result.resultJson).toMatchObject({
      partial: true,
      stopReason: "timeout",
      stdout: expect.stringContaining("/tmp/bookforge-report.json"),
      stderr: expect.stringContaining("partial warning"),
    });
  });
});
