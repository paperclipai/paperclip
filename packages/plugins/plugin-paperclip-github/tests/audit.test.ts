import { describe, it, expect, vi } from "vitest";
import { wrapTool, RefusalError } from "../src/audit.js";
import type { PluginActivityLogEntry, ToolResult } from "@paperclipai/plugin-sdk";

function makeAuditCtx() {
  const logCalls: PluginActivityLogEntry[] = [];
  return {
    activity: {
      log: async (entry: PluginActivityLogEntry): Promise<void> => {
        logCalls.push(entry);
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    logCalls,
  };
}

const runCtx = {
  agentId: "agent-1",
  runId: "run-1",
  companyId: "company-1",
  projectId: "project-1",
};

describe("wrapTool", () => {
  it("logs an activity entry on success", async () => {
    const ctx = makeAuditCtx();
    const wrapped = wrapTool(
      { activity: ctx.activity, logger: ctx.logger as never },
      "test_tool",
      async () => ({ content: "ok", data: { prNumber: 42 } }) satisfies ToolResult,
    );
    const result = await wrapped({}, runCtx);
    expect(result.content).toBe("ok");
    expect(ctx.logCalls).toHaveLength(1);
    expect(ctx.logCalls[0]?.companyId).toBe("company-1");
    expect((ctx.logCalls[0]?.metadata as { summary?: { prNumber?: number } } | undefined)?.summary?.prNumber).toBe(42);
  });

  it("logs an activity entry on returned-error refusal", async () => {
    const ctx = makeAuditCtx();
    const wrapped = wrapTool(
      { activity: ctx.activity, logger: ctx.logger as never },
      "refusing_tool",
      async () => ({ error: "authorization_failed: token abc123 failed" }) satisfies ToolResult,
    );
    const result = await wrapped({}, runCtx);
    expect(result.error).toBe("authorization_failed: token abc123 failed");
    expect(ctx.logCalls).toHaveLength(1);
    expect((ctx.logCalls[0]?.metadata as { refusal?: boolean } | undefined)?.refusal).toBe(true);
    expect((ctx.logCalls[0]?.metadata as { code?: string } | undefined)?.code).toBe("authorization_failed");
    expect(ctx.logCalls[0]?.message).toBe("refusing_tool: refused");
  });

  it("converts thrown RefusalError into ToolResult { error } with stable code", async () => {
    const ctx = makeAuditCtx();
    const wrapped = wrapTool(
      { activity: ctx.activity, logger: ctx.logger as never },
      "throwing_tool",
      async () => {
        throw new RefusalError("evidence_too_thin", "details required");
      },
    );
    const result = await wrapped({}, runCtx);
    expect(result.error).toBe("evidence_too_thin: details required");
    expect(result.content).toBeUndefined();
    expect(ctx.logCalls).toHaveLength(1);
    expect((ctx.logCalls[0]?.metadata as { code?: string } | undefined)?.code).toBe("evidence_too_thin");
    expect((ctx.logCalls[0]?.metadata as { reason?: string } | undefined)?.reason).toBeUndefined();
  });

  it("converts an unexpected throw into a generic error result", async () => {
    const ctx = makeAuditCtx();
    const wrapped = wrapTool(
      { activity: ctx.activity, logger: ctx.logger as never },
      "buggy_tool",
      async () => {
        throw new Error("kaboom");
      },
    );
    const result = await wrapped({}, runCtx);
    expect(result.error).toBe("tool_unhandled_error: kaboom");
  });

  it("does not crash if activity.log itself throws", async () => {
    const ctx = {
      activity: {
        log: async (_entry: PluginActivityLogEntry): Promise<void> => {
          throw new Error("audit pipeline broken");
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    };
    const wrapped = wrapTool({ activity: ctx.activity, logger: ctx.logger as never }, "x", async () => ({
      content: "ok",
    }));
    const result = await wrapped({}, runCtx);
    expect(result.content).toBe("ok");
    expect(ctx.logger.error).toHaveBeenCalled();
  });
});
