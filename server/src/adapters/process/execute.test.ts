import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "./execute.js";

// ── CLI-202 regression: process adapter failure error messages ───────────────

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-process-test",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "TestAgent",
      adapterType: "process",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {},
    context: {},
    onLog: async () => {},
    ...overrides,
  };
}

describe("process adapter execute — error messages", () => {
  it("throws when command is missing from config", async () => {
    await expect(execute(makeCtx({ config: {} }) as any)).rejects.toThrow(
      "Process adapter missing command",
    );
  });

  it("returns errorMessage with exit code when process exits non-zero", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-test-"));
    const scriptPath = path.join(dir, "fail.mjs");
    await fs.writeFile(scriptPath, "process.exit(2);\n", "utf8");
    await fs.chmod(scriptPath, 0o755);

    const result = await execute(makeCtx({
      config: { command: process.execPath, args: [scriptPath], cwd: dir },
    }) as any);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.errorMessage).toMatch(/Process exited with code 2/);
  });

  it("returns errorMessage with timeout duration when process times out", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-test-timeout-"));
    const scriptPath = path.join(dir, "hang.mjs");
    // Sleep indefinitely — the adapter will kill it via timeout
    await fs.writeFile(scriptPath, "setTimeout(() => {}, 60_000);\n", "utf8");
    await fs.chmod(scriptPath, 0o755);

    const result = await execute(makeCtx({
      config: { command: process.execPath, args: [scriptPath], cwd: dir, timeoutSec: 1, graceSec: 1 },
    }) as any);

    expect(result.timedOut).toBe(true);
    expect(result.errorMessage).toMatch(/Timed out after 1s/);
  }, 10_000);
});
