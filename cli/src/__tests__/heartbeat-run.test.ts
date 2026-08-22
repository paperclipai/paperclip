import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatRun } from "../commands/heartbeat-run.js";

const ORIGINAL_EXIT_CODE = process.exitCode;

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = ORIGINAL_EXIT_CODE;
});

describe("heartbeat run command", () => {
  it("fails loudly for invalid wakeup sources", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await heartbeatRun({
      agentId: "agent-1",
      source: "timer",
      trigger: "manual",
      timeoutMs: "0",
    });

    expect(process.exitCode).toBe(1);
    expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toContain("Invalid heartbeat source: timer");
  });
});
