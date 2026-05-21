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
  type ExecOnExitVerdict,
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
        resolvedAction: "block" as const,
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

  it("includes exec block details for action=exec matches", () => {
    const ctx = makeCtx({ body: "Done at deadbeef" });
    const matches = [
      {
        hookIndex: 1,
        action: "exec" as const,
        resolvedAction: "pass" as const,
        message: null,
        matchedBy: { agentId: true, statusTransition: true, bodyMatches: true },
        trigger: { agentId: CCO_AGENT_ID, statusTransition: "to_done" },
        exec: {
          status: "exit" as const,
          exitCode: 0,
          signal: null,
          stdout: "real_on_main",
          stderr: "",
          durationMs: 42,
          verdict: "pass+append_audit" as ExecOnExitVerdict,
          verdictSource: "exit:0",
        },
      },
    ];
    const block = buildAuditBlock(matches, ctx);
    expect(block).toContain("action=exec");
    expect(block).toContain("resolvedAction=pass");
    expect(block).toContain("exec status=exit");
    expect(block).toContain("exitCode=0");
    expect(block).toContain("verdict=pass+append_audit");
    expect(block).toContain("verdictSource=exit:0");
    expect(block).toContain("exec stdout:");
    expect(block).toContain("real_on_main");
  });
});

describe("parsePreCommentHooks — action=exec", () => {
  it("parses well-formed exec hook with command/stdin/onExit/timeoutMs", () => {
    const cfg = {
      preCommentHooks: [
        {
          trigger: { agentId: CCO_AGENT_ID, statusTransition: "to_done", bodyMatches: "\\b[0-9a-f]{7,40}\\b" },
          action: "exec",
          command: ["/usr/bin/node", "/abs/cco-hash-verify.mjs", "--json"],
          stdin: "comment.body",
          onExit: { "0": "pass+append_audit", "1": "block", "2": "block+escalate" },
          timeoutMs: 15000,
        },
      ],
    };
    const parsed = parsePreCommentHooks(cfg);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].action).toBe("exec");
    expect(parsed[0].command).toEqual(["/usr/bin/node", "/abs/cco-hash-verify.mjs", "--json"]);
    expect(parsed[0].stdin).toBe("comment.body");
    expect(parsed[0].onExit).toEqual({ "0": "pass+append_audit", "1": "block", "2": "block+escalate" });
    expect(parsed[0].timeoutMs).toBe(15000);
  });

  it("clamps timeoutMs to hard ceiling and drops invalid onExit verdicts", () => {
    const cfg = {
      preCommentHooks: [
        {
          trigger: { agentId: CCO_AGENT_ID },
          action: "exec",
          command: ["/usr/bin/node", "/abs/script.mjs"],
          onExit: { "0": "pass+append_audit", "1": "frobnicate", "2": "block" },
          timeoutMs: 999_999,
        },
      ],
    };
    const parsed = parsePreCommentHooks(cfg);
    expect(parsed[0].timeoutMs).toBeLessThanOrEqual(60_000);
    expect(parsed[0].onExit).toEqual({ "0": "pass+append_audit", "2": "block" });
  });

  it("drops invalid stdin values and empty command arrays", () => {
    const cfg = {
      preCommentHooks: [
        { action: "exec", command: [], stdin: "comment.body" },
        { action: "exec", command: ["/abs/x.mjs"], stdin: "stdout.body" },
      ],
    };
    const parsed = parsePreCommentHooks(cfg);
    expect(parsed[0].command).toBeUndefined();
    expect(parsed[1].command).toEqual(["/abs/x.mjs"]);
    expect(parsed[1].stdin).toBeUndefined();
  });
});

describe("evaluatePreCommentHooks — action=exec", () => {
  beforeEach(() => {
    mockLogActivity.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("denies exec when command[0] is not on allowlist (fail-closed)", async () => {
    const hooks: PreCommentHookConfig[] = [
      {
        trigger: { agentId: CCO_AGENT_ID, statusTransition: "to_done" },
        action: "exec",
        command: ["/usr/bin/node", "/forbidden/script.mjs"],
        onExit: { "0": "pass+append_audit", default: "block" },
        timeoutMs: 5000,
      },
    ];
    const result = await evaluatePreCommentHooks(
      {} as any,
      hooks,
      makeCtx({ body: "Done at deadbeef" }),
      { execAllowlist: new Set(["/allowed/elsewhere.mjs"]) },
    );
    expect(result.blocked).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].action).toBe("exec");
    expect(result.matches[0].resolvedAction).toBe("block");
    expect(result.matches[0].exec?.status).toBe("denied");
    expect(result.matches[0].exec?.verdictSource).toBe("denied");
  });

  it("exec exit 0 maps to pass+append_audit (non-blocking, stdout captured)", async () => {
    const allowed = "/usr/bin/true";
    const hooks: PreCommentHookConfig[] = [
      {
        trigger: { agentId: CCO_AGENT_ID },
        action: "exec",
        command: [allowed],
        onExit: { "0": "pass+append_audit", default: "block" },
        timeoutMs: 5000,
      },
    ];
    const result = await evaluatePreCommentHooks(
      {} as any,
      hooks,
      makeCtx({ body: "ok" }),
      { execAllowlist: new Set([allowed]) },
    );
    expect(result.blocked).toBe(false);
    expect(result.matches[0].exec?.status).toBe("exit");
    expect(result.matches[0].exec?.exitCode).toBe(0);
    expect(result.matches[0].resolvedAction).toBe("pass");
  });

  it("exec non-zero exit maps to block per onExit", async () => {
    const allowed = "/usr/bin/false";
    const hooks: PreCommentHookConfig[] = [
      {
        trigger: { agentId: CCO_AGENT_ID },
        action: "exec",
        command: [allowed],
        onExit: { "0": "pass+append_audit", "1": "block" },
        timeoutMs: 5000,
      },
    ];
    const result = await evaluatePreCommentHooks(
      {} as any,
      hooks,
      makeCtx({ body: "ok" }),
      { execAllowlist: new Set([allowed]) },
    );
    expect(result.blocked).toBe(true);
    expect(result.matches[0].exec?.exitCode).toBe(1);
    expect(result.matches[0].exec?.verdictSource).toBe("exit:1");
    expect(result.matches[0].resolvedAction).toBe("block");
  });

  it("default mapping applies when exit code has no explicit entry", async () => {
    const allowed = "/usr/bin/false";
    const hooks: PreCommentHookConfig[] = [
      {
        trigger: { agentId: CCO_AGENT_ID },
        action: "exec",
        command: [allowed],
        onExit: { "0": "pass+append_audit", default: "block" },
        timeoutMs: 5000,
      },
    ];
    const result = await evaluatePreCommentHooks(
      {} as any,
      hooks,
      makeCtx({ body: "ok" }),
      { execAllowlist: new Set([allowed]) },
    );
    expect(result.matches[0].exec?.verdictSource).toBe("default");
    expect(result.matches[0].resolvedAction).toBe("block");
  });

  it("block+escalate maps to resolvedAction=escalate and contributes to blocked", async () => {
    const allowed = "/usr/bin/false";
    const hooks: PreCommentHookConfig[] = [
      {
        trigger: { agentId: CCO_AGENT_ID },
        action: "exec",
        command: [allowed],
        onExit: { "1": "block+escalate", default: "block" },
        timeoutMs: 5000,
      },
    ];
    const result = await evaluatePreCommentHooks(
      {} as any,
      hooks,
      makeCtx({ body: "ok" }),
      { execAllowlist: new Set([allowed]) },
    );
    expect(result.blocked).toBe(true);
    expect(result.matches[0].resolvedAction).toBe("escalate");
  });

  it("timeout maps to block with verdictSource=timeout", async () => {
    const allowed = "/usr/bin/sleep";
    const hooks: PreCommentHookConfig[] = [
      {
        trigger: { agentId: CCO_AGENT_ID },
        action: "exec",
        command: [allowed, "10"],
        onExit: { "0": "pass+append_audit" },
        timeoutMs: 100,
      },
    ];
    const result = await evaluatePreCommentHooks(
      {} as any,
      hooks,
      makeCtx({ body: "ok" }),
      { execAllowlist: new Set([allowed]) },
    );
    expect(result.blocked).toBe(true);
    expect(result.matches[0].exec?.status).toBe("timeout");
    expect(result.matches[0].exec?.verdictSource).toBe("timeout");
    expect(result.matches[0].resolvedAction).toBe("block");
  });

  it("exec hook does NOT run if trigger does not match", async () => {
    const allowed = "/usr/bin/true";
    const hooks: PreCommentHookConfig[] = [
      {
        trigger: { agentId: "different-agent" },
        action: "exec",
        command: [allowed],
        onExit: { "0": "pass+append_audit" },
        timeoutMs: 5000,
      },
    ];
    const result = await evaluatePreCommentHooks(
      {} as any,
      hooks,
      makeCtx({ body: "Done at deadbeef" }),
      { execAllowlist: new Set([allowed]) },
    );
    expect(result.blocked).toBe(false);
    expect(result.matches).toEqual([]);
  });

  it("exec stdout is captured into audit block on pass+append_audit", async () => {
    // /bin/echo writes its arg to stdout then exits 0.
    const allowed = "/bin/echo";
    const hooks: PreCommentHookConfig[] = [
      {
        trigger: { agentId: CCO_AGENT_ID },
        action: "exec",
        command: [allowed, "real_on_main:deadbeef"],
        onExit: { "0": "pass+append_audit" },
        timeoutMs: 5000,
      },
    ];
    const result = await evaluatePreCommentHooks(
      {} as any,
      hooks,
      makeCtx({ body: "Done at deadbeef" }),
      { execAllowlist: new Set([allowed]) },
    );
    expect(result.matches[0].resolvedAction).toBe("pass");
    expect(result.matches[0].exec?.stdout).toContain("real_on_main:deadbeef");
    const audit = buildAuditBlock(result.matches, makeCtx({ body: "Done at deadbeef" }));
    expect(audit).toContain("real_on_main:deadbeef");
    expect(audit).toContain("verdict=pass+append_audit");
  });
});
