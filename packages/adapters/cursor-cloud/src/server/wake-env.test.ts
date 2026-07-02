import { describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildCursorCloudWakeEnv } from "./wake-env.js";

function mockCtx(overrides: Record<string, unknown> = {}): AdapterExecutionContext {
  const { runId, authToken, ...contextFields } = overrides;
  return {
    runId: typeof runId === "string" ? runId : "run-default",
    authToken: typeof authToken === "string" ? authToken : undefined,
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Test Agent",
      adapterType: "cursor_cloud",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {},
    context: contextFields,
    onLog: async () => {},
  };
}

describe("buildCursorCloudWakeEnv", () => {
  it("does not include PAPERCLIP_WAKE_PAYLOAD_JSON in cloud env", () => {
    const hugePayload = { comments: [{ body: "z".repeat(20_000) }] };
    const env = buildCursorCloudWakeEnv(mockCtx({ paperclipWake: hugePayload }), { MY_SECRET: "ok" });
    expect(env.PAPERCLIP_WAKE_PAYLOAD_JSON).toBeUndefined();
  });

  it("all env values are <= 4096 bytes after clamp", () => {
    const env = buildCursorCloudWakeEnv(
      mockCtx({ paperclipWake: { comments: [{ body: "z".repeat(20_000) }] } }),
      { BIG_SECRET: "a".repeat(5000) },
    );
    for (const value of Object.values(env)) {
      expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(4096);
    }
  });

  it("keeps essential PAPERCLIP_* keys", () => {
    const env = buildCursorCloudWakeEnv(
      mockCtx({ runId: "run-abc", taskId: "issue-123", authToken: "jwt-token" }),
      {},
    );
    expect(env.PAPERCLIP_RUN_ID).toBe("run-abc");
    expect(env.PAPERCLIP_TASK_ID).toBe("issue-123");
    expect(env.PAPERCLIP_API_KEY).toBe("jwt-token");
  });
});
