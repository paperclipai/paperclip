import { describe, expect, it, vi, afterEach } from "vitest";
import {
  createCodeBuddyStreamLogHandler,
  inspectCodeBuddyStderrLine,
  inspectCodeBuddyStreamJsonLine,
} from "./stream-liveness.js";

describe("inspectCodeBuddyStreamJsonLine", () => {
  it("detects stream-json result with is_error", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "模型调用失败",
    });
    expect(inspectCodeBuddyStreamJsonLine(line)?.errorCode).toBe("codebuddy_execution_error");
    expect(inspectCodeBuddyStreamJsonLine(line)?.errorMessage).toContain("模型调用失败");
  });

  it("ignores successful result lines", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" });
    expect(inspectCodeBuddyStreamJsonLine(line)).toBeNull();
  });
});

describe("inspectCodeBuddyStderrLine", () => {
  it("detects max turns exceeded", () => {
    expect(inspectCodeBuddyStderrLine("Error: Max turns (1) exceeded")?.errorCode).toBe(
      "codebuddy_max_turns_exceeded",
    );
  });
});

describe("createCodeBuddyStreamLogHandler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards chunks to onLog and records fatal stop from stdout", async () => {
    const chunks: string[] = [];
    const handler = createCodeBuddyStreamLogHandler({
      runId: "run-test",
      graceSec: 1,
      onLog: async (_stream, chunk) => {
        chunks.push(chunk);
      },
    });

    const errLine = `${JSON.stringify({ type: "result", is_error: true, result: "boom" })}\n`;
    await handler.onLog("stdout", errLine);
    await handler.flush();

    expect(chunks.join("")).toContain("boom");
    expect(handler.getFatalStop()?.errorMessage).toContain("boom");
  });
});
