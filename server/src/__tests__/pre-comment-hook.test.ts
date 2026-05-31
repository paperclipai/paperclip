import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  buildAuditBlock,
  evaluatePreCommentHooks,
  parsePreCommentHooks,
  type PreCommentHookConfig,
  type PreCommentHookContext,
} from "../services/pre-comment-hook.js";

const CCO_AGENT_ID = "02cbe529-20be-4963-9742-a4548680f111";

function makeCtx(overrides: Partial<PreCommentHookContext> = {}): PreCommentHookContext {
  return {
    companyId: "company-1",
    issueId: "issue-1",
    agentId: CCO_AGENT_ID,
    body: "",
    source: "update",
    statusTransition: "to_done",
    ...overrides,
  };
}

describe("parsePreCommentHooks", () => {
  it("returns [] when adapterConfig is null/undefined/non-object", () => {
    expect(parsePreCommentHooks(null)).toEqual([]);
    expect(parsePreCommentHooks(undefined)).toEqual([]);
    expect(parsePreCommentHooks("not-an-object")).toEqual([]);
    expect(parsePreCommentHooks([])).toEqual([]);
  });

  it("returns [] when preCommentHooks is missing or not an array", () => {
    expect(parsePreCommentHooks({})).toEqual([]);
    expect(parsePreCommentHooks({ preCommentHooks: "nope" })).toEqual([]);
    expect(parsePreCommentHooks({ preCommentHooks: { trigger: {} } })).toEqual([]);
  });

  it("parses well-formed entries and ignores unknown action values", () => {
    const cfg = {
      preCommentHooks: [
        {
          trigger: {
            agentId: CCO_AGENT_ID,
            statusTransition: "to_done",
            bodyMatches: "\\b[0-9a-f]{7,40}\\b",
          },
          action: "block",
          message: "phantom hash check",
        },
        {
          trigger: { agentId: CCO_AGENT_ID },
          action: "frobnicate",
        },
      ],
    };
    const parsed = parsePreCommentHooks(cfg);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      trigger: {
        agentId: CCO_AGENT_ID,
        statusTransition: "to_done",
        bodyMatches: "\\b[0-9a-f]{7,40}\\b",
      },
      action: "block",
      message: "phantom hash check",
    });
    expect(parsed[1].action).toBeUndefined();
  });
});

describe("evaluatePreCommentHooks", () => {
  beforeEach(() => {
    mockLogActivity.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("(c) backwards-compat: no hooks → not blocked, no audit", async () => {
    const result = await evaluatePreCommentHooks({} as any, [], makeCtx({ body: "Done at 916caac" }));
    expect(result.blocked).toBe(false);
    expect(result.matches).toEqual([]);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("(a) phantom-hash-block: matching hook with action=block blocks", async () => {
    const hooks: PreCommentHookConfig[] = [
      {
        trigger: {
          agentId: CCO_AGENT_ID,
          statusTransition: "to_done",
          bodyMatches: "\\b[0-9a-f]{7,40}\\b",
        },
        action: "block",
        message: "phantom hash detector",
      },
    ];
    const result = await evaluatePreCommentHooks(
      {} as any,
      hooks,
      makeCtx({ body: "Done at 916caac on master." }),
    );
    expect(result.blocked).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].action).toBe("block");
    expect(result.matches[0].message).toBe("phantom hash detector");
    expect(result.matches[0].hookIndex).toBe(0);
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.pre_comment_hook_blocked",
        actorType: "system",
        actorId: "pre_comment_hook",
      }),
    );
  });

  it("(b) real-hash-pass: hook with bodyMatches that doesn't match → not blocked", async () => {
    const hooks: PreCommentHookConfig[] = [
      {
        trigger: {
          agentId: CCO_AGENT_ID,
          statusTransition: "to_done",
          bodyMatches: "PHANTOM",
        },
        action: "block",
      },
    ];
    const result = await evaluatePreCommentHooks(
      {} as any,
      hooks,
      makeCtx({ body: "Real done at bb9d9b4." }),
    );
    expect(result.blocked).toBe(false);
    expect(result.matches).toEqual([]);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not match when agentId differs", async () => {
    const hooks: PreCommentHookConfig[] = [
      {
        trigger: { agentId: CCO_AGENT_ID, bodyMatches: ".+" },
        action: "block",
      },
    ];
    const result = await evaluatePreCommentHooks(
      {} as any,
      hooks,
      makeCtx({ agentId: "some-other-agent", body: "anything" }),
    );
    expect(result.blocked).toBe(false);
  });

  it("does not match when statusTransition differs", async () => {
    const hooks: PreCommentHookConfig[] = [
      {
        trigger: { statusTransition: "to_done", bodyMatches: ".+" },
        action: "block",
      },
    ];
    const result = await evaluatePreCommentHooks(
      {} as any,
      hooks,
      makeCtx({ statusTransition: "to_in_progress", body: "anything" }),
    );
    expect(result.blocked).toBe(false);
  });

  it("matches when statusTransition is 'any'", async () => {
    const hooks: PreCommentHookConfig[] = [
      {
        trigger: { statusTransition: "any", bodyMatches: ".+" },
        action: "block",
      },
    ];
    const result = await evaluatePreCommentHooks(
      {} as any,
      hooks,
      makeCtx({ statusTransition: null, body: "anything" }),
    );
    expect(result.blocked).toBe(true);
  });

  it("matches when bodyMatches is unset (treat as 'always match')", async () => {
    const hooks: PreCommentHookConfig[] = [
      { trigger: { agentId: CCO_AGENT_ID }, action: "block" },
    ];
    const result = await evaluatePreCommentHooks({} as any, hooks, makeCtx({ body: "" }));
    expect(result.blocked).toBe(true);
  });

  it("warn action does not block but is recorded as a match and logged", async () => {
    const hooks: PreCommentHookConfig[] = [
      { trigger: { agentId: CCO_AGENT_ID, bodyMatches: ".+" }, action: "warn" },
    ];
    const result = await evaluatePreCommentHooks({} as any, hooks, makeCtx({ body: "x" }));
    expect(result.blocked).toBe(false);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].action).toBe("warn");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.pre_comment_hook_warned" }),
    );
  });

  it("escalate action does not block in iteration 1 but is recorded", async () => {
    const hooks: PreCommentHookConfig[] = [
      { trigger: { agentId: CCO_AGENT_ID, bodyMatches: ".+" }, action: "escalate" },
    ];
    const result = await evaluatePreCommentHooks({} as any, hooks, makeCtx({ body: "x" }));
    expect(result.blocked).toBe(false);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.pre_comment_hook_escalated" }),
    );
  });

  it("any blocking hook in a list of mixed actions blocks the comment", async () => {
    const hooks: PreCommentHookConfig[] = [
      { trigger: { bodyMatches: "x" }, action: "warn" },
      { trigger: { bodyMatches: "x" }, action: "block" },
    ];
    const result = await evaluatePreCommentHooks({} as any, hooks, makeCtx({ body: "x" }));
    expect(result.blocked).toBe(true);
    expect(result.matches).toHaveLength(2);
  });

  it("invalid regex pattern is skipped (does not throw, does not block)", async () => {
    const hooks: PreCommentHookConfig[] = [
      { trigger: { bodyMatches: "[unterminated" }, action: "block" },
    ];
    const result = await evaluatePreCommentHooks({} as any, hooks, makeCtx({ body: "x" }));
    expect(result.blocked).toBe(false);
  });

  it("entries without an action are inert (no match, no log)", async () => {
    const hooks: PreCommentHookConfig[] = [
      { trigger: { bodyMatches: ".+" } },
    ];
    const result = await evaluatePreCommentHooks({} as any, hooks, makeCtx({ body: "x" }));
    expect(result.blocked).toBe(false);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});

describe("buildAuditBlock", () => {
  it("emits a single-block format with one line per match", () => {
    const ctx = makeCtx({ body: "Done at 916caac" });
    const matches = [
      {
        hookIndex: 0,
        action: "block" as const,
        message: "phantom",
        matchedBy: { agentId: true, statusTransition: true, bodyMatches: true },
        trigger: { agentId: CCO_AGENT_ID, statusTransition: "to_done", bodyMatches: "\\b[0-9a-f]{7,40}\\b" },
      },
    ];
    const block = buildAuditBlock(matches, ctx);
    expect(block).toContain("<!-- pre-comment-hook v1");
    expect(block).toContain("<!-- /pre-comment-hook -->");
    expect(block).toContain("hook[0]");
    expect(block).toContain("action=block");
    expect(block).toContain(`agentId=${CCO_AGENT_ID}`);
    expect(block).toContain("statusTransition=to_done");
    expect(block).toContain("message=phantom");
  });
});
