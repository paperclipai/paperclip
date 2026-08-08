import { describe, expect, it } from "vitest";
import { buildLeaseSandboxId, buildSentinelPath, isTimeoutError } from "./helpers.js";

describe("bridge sandbox helpers", () => {
  it("builds reusable lease IDs from environment IDs", () => {
    expect(buildLeaseSandboxId({
      environmentId: "Env_123",
      runId: "run-ignored",
      reuseLease: true,
      normalizeId: true,
    })).toBe("pc-env-env-123");
  });

  it("builds ephemeral lease IDs from run IDs", () => {
    expect(buildLeaseSandboxId({
      environmentId: "env-1",
      runId: "Run_123",
      reuseLease: false,
      normalizeId: true,
      randomId: "ABCD1234",
    })).toBe("pc-run-123-abcd1234");
  });

  it("builds the workspace sentinel path", () => {
    expect(buildSentinelPath("/workspace/paperclip/")).toBe("/workspace/paperclip/.paperclip-lease.json");
  });

  it("detects timeout-shaped errors", () => {
    expect(isTimeoutError(new Error("command timed out after 10s"))).toBe(true);
    expect(isTimeoutError(new Error("some other error"))).toBe(false);
  });
});
