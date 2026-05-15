import { describe, expect, it } from "vitest";
import { execute } from "./execute.js";

describe("kimi_local execute", () => {
  it("runs a simple prompt via wire protocol", async () => {
    const logs: Array<{ stream: "stdout" | "stderr"; text: string }> = [];

    const result = await execute({
      runId: "test-run-" + Date.now(),
      agent: {
        id: "test-agent",
        companyId: "test-company",
        name: "Test Agent",
        adapterType: "kimi_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        promptTemplate: "Say hello briefly",
        timeoutSec: 25,
        graceSec: 5,
      },
      context: {
        paperclipWorkspace: { cwd: process.cwd() },
      },
      onLog: async (stream, text) => {
        logs.push({ stream, text });
      },
    });

    const stdoutText = logs.filter(l => l.stream === "stdout").map(l => l.text).join("");
    const stderrText = logs.filter(l => l.stream === "stderr").map(l => l.text).join("");
    const lines = stdoutText.split(/\r?\n/).filter(Boolean);

    console.log("Total lines:", lines.length);
    console.log("Last 5 lines:");
    for (const line of lines.slice(-5)) {
      console.log(line.slice(0, 400));
    }
    console.log("=== STDERR ===");
    console.log(stderrText.slice(0, 500));
    console.log("exitCode:", result.exitCode);
    console.log("timedOut:", result.timedOut);
    console.log("summary:", result.summary);
    console.log("usage:", result.usage);
    console.log("errorMessage:", result.errorMessage);

    expect(stdoutText.length).toBeGreaterThan(0);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.summary?.length ?? 0).toBeGreaterThan(0);
    expect(result.usage?.outputTokens ?? 0).toBeGreaterThan(0);
  }, 45000);
});
