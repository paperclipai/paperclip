import { describe, expect, it } from "vitest";
import { allocateEnvVarsBudget } from "./env-budget.js";

describe("allocateEnvVarsBudget", () => {
  it("drops lowest-priority keys when >50 keys", () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 60; i++) env[`LOW_${i}`] = "x";
    env.PAPERCLIP_RUN_ID = "run-1";
    env.PAPERCLIP_API_KEY = "jwt";
    const { env: out, droppedKeys } = allocateEnvVarsBudget(env);
    expect(Object.keys(out).length).toBeLessThanOrEqual(50);
    expect(out.PAPERCLIP_RUN_ID).toBe("run-1");
    expect(droppedKeys.length).toBeGreaterThan(0);
  });

  it("never includes PAPERCLIP_WAKE_PAYLOAD_JSON", () => {
    const { env } = allocateEnvVarsBudget({ PAPERCLIP_WAKE_PAYLOAD_JSON: "x".repeat(8000) });
    expect(env).not.toHaveProperty("PAPERCLIP_WAKE_PAYLOAD_JSON");
  });

  it("truncates oversized values", () => {
    const { env, truncatedKeys } = allocateEnvVarsBudget({ CUSTOM: "y".repeat(5000) });
    expect(truncatedKeys).toContain("CUSTOM");
    expect(Buffer.byteLength(env.CUSTOM ?? "", "utf8")).toBeLessThanOrEqual(4096);
  });
});
