import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveApproval,
  resolvePaperclipApproval,
  tryUndoResolution,
  emojiToDecision,
  parseThreadCommand,
  UNDO_GRACE_MS,
} from "../approval-actions.js";
import { STATE_KEYS } from "../constants.js";

const BASE = "http://pc.local";
const COMPANY = "company-1";
const APPROVAL = "approval-1";
const CHANNEL = "C_APPROVALS";
const TS = "1717200000.000100";

function makeCtx() {
  const store = new Map<string, unknown>();
  const call = vi.fn(async () => ({
    id: APPROVAL,
    companyId: COMPANY,
    type: "request_board_approval",
    status: "approved",
    requestedByAgentId: null,
    requestedByUserId: null,
    decisionNote: null,
    decidedByUserId: "slack:U_OMAR",
    decidedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    applied: true,
  }));
  const fetch = vi.fn(
    async (
      _url: string,
      _init?: unknown,
    ): Promise<{ status: number; json: () => Promise<Record<string, unknown>> }> => ({
      status: 200,
      json: async () => ({ ok: true }),
    }),
  );
  const ctx = {
    rpc: { call },
    http: { fetch },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    metrics: { write: vi.fn(async () => undefined) },
    state: {
      get: vi.fn(async ({ stateKey }: { stateKey: string }) => store.get(stateKey) ?? null),
      set: vi.fn(async ({ stateKey }: { stateKey: string }, value: unknown) => {
        store.set(stateKey, value);
      }),
      delete: vi.fn(async ({ stateKey }: { stateKey: string }) => {
        store.delete(stateKey);
      }),
    },
  };
  return { ctx, fetch, call, store };
}

const baseParams = {
  companyId: COMPANY,
  approvalId: APPROVAL,
  slackUserId: "U_OMAR",
  channel: CHANNEL,
  ts: TS,
  paperclipBaseUrl: BASE,
};

describe("emojiToDecision", () => {
  it("maps approve/reject emojis and ignores others", () => {
    expect(emojiToDecision("white_check_mark")).toBe("approve");
    expect(emojiToDecision("x")).toBe("reject");
    expect(emojiToDecision("eyes")).toBeNull();
    expect(emojiToDecision("tada")).toBeNull();
  });
});

describe("parseThreadCommand", () => {
  it("parses bang commands", () => {
    expect(parseThreadCommand("!approve")).toEqual({ kind: "decision", decision: "approve", reason: undefined });
    expect(parseThreadCommand("!approve looks good")).toEqual({ kind: "decision", decision: "approve", reason: "looks good" });
    expect(parseThreadCommand("!reject nope")).toEqual({ kind: "decision", decision: "reject", reason: "nope" });
    expect(parseThreadCommand("!revise add tests")).toEqual({ kind: "decision", decision: "revise", reason: "add tests" });
    expect(parseThreadCommand("!status")).toEqual({ kind: "status" });
  });

  it("requires a reason for !revise", () => {
    const r = parseThreadCommand("!revise");
    expect(r.kind).toBe("usage");
  });

  it("ignores freeform replies instead of mutating approvals", () => {
    expect(parseThreadCommand("please rethink the rollout")).toEqual({
      kind: "ignore",
    });
  });

  it("returns usage for unknown bang command and ignore for empty", () => {
    expect(parseThreadCommand("!frobnicate").kind).toBe("usage");
    expect(parseThreadCommand("   ").kind).toBe("ignore");
  });
});

describe("resolveApproval", () => {
  beforeEach(() => vi.clearAllMocks());

  it("approves through approvals.resolve, sets the lock, and edits the card", async () => {
    const { ctx, fetch, call, store } = makeCtx();
    const res = await resolveApproval(ctx as any, "xoxb", {
      ...baseParams,
      decision: "approve",
    });
    expect(res.ok).toBe(true);
    expect(call).toHaveBeenCalledWith(
      "approvals.resolve",
      expect.objectContaining({
        companyId: COMPANY,
        approvalId: APPROVAL,
        decision: "approve",
        decidedByUserId: "slack:U_OMAR",
      }),
    );
    // status-echo card edit
    expect(fetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.update",
      expect.objectContaining({
        body: expect.stringContaining("\"blocks\""),
      }),
    );
    // lock persisted
    expect(store.get(STATE_KEYS.approvalResolved(APPROVAL))).toMatchObject({
      decision: "approve",
      by: "U_OMAR",
    });
    expect(ctx.metrics.write).toHaveBeenCalledWith(
      "slack.approvals.decided",
      1,
      expect.objectContaining({ decision: "approve", source: "slack_interaction" }),
    );
  });

  it("rejects through approvals.resolve", async () => {
    const { ctx, call } = makeCtx();
    await resolveApproval(ctx as any, "xoxb", { ...baseParams, decision: "reject" });
    expect(call).toHaveBeenCalledWith(
      "approvals.resolve",
      expect.objectContaining({ decision: "reject" }),
    );
  });

  it("revise: calls approvals.resolve with the reason as decisionNote", async () => {
    const { ctx, call } = makeCtx();
    await resolveApproval(ctx as any, "xoxb", {
      ...baseParams,
      decision: "revise",
      reason: "add tests",
    });
    expect(call).toHaveBeenCalledWith(
      "approvals.resolve",
      expect.objectContaining({ decision: "revise", decisionNote: "add tests" }),
    );
  });

  it("is idempotent: a second conflicting decision is a no-op", async () => {
    const { ctx, call } = makeCtx();
    await resolveApproval(ctx as any, "xoxb", { ...baseParams, decision: "approve" });
    const decideCalls = call.mock.calls.length;

    const second = await resolveApproval(ctx as any, "xoxb", {
      ...baseParams,
      decision: "reject",
      slackUserId: "U_OTHER",
    });
    expect(second.alreadyResolved).toBe(true);
    // no new approvals RPC call beyond the first decision
    const after = call.mock.calls.length;
    expect(after).toBe(decideCalls);
  });

  it("releases the lock and reports when the host resolver rejects", async () => {
    const { ctx, call, store } = makeCtx();
    call.mockRejectedValueOnce(new Error("resolver unavailable"));
    const res = await resolveApproval(ctx as any, "xoxb", {
      ...baseParams,
      decision: "approve",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("resolve_failed");
    // lock cleared so a corrected retry is possible
    expect(store.has(STATE_KEYS.approvalResolved(APPROVAL))).toBe(false);
  });

  it("releases the lock and leaves the card alone when the server reports applied=false", async () => {
    const { ctx, fetch, call, store } = makeCtx();
    call.mockResolvedValueOnce({
      id: APPROVAL,
      companyId: COMPANY,
      type: "request_board_approval",
      status: "approved",
      requestedByAgentId: null,
      requestedByUserId: null,
      decisionNote: null,
      decidedByUserId: "slack:U_OMAR",
      decidedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      applied: false,
    });

    const res = await resolveApproval(ctx as any, "xoxb", {
      ...baseParams,
      decision: "approve",
    });

    expect(res).toMatchObject({ ok: false, alreadyResolved: true });
    expect(store.has(STATE_KEYS.approvalResolved(APPROVAL))).toBe(false);
    expect(ctx.metrics.write).not.toHaveBeenCalledWith(
      "slack.approvals.decided",
      expect.any(Number),
      expect.any(Object),
    );
    expect(fetch).not.toHaveBeenCalledWith(
      "https://slack.com/api/chat.update",
      expect.any(Object),
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        body: expect.stringContaining("already resolved server-side"),
      }),
    );
  });

  it("deletes the lock when the host approval resolver throws", async () => {
    const { ctx, call, store } = makeCtx();
    call.mockRejectedValueOnce(new Error("resolver down"));

    const res = await resolveApproval(ctx as any, "xoxb", {
      ...baseParams,
      decision: "approve",
    });

    expect(res).toMatchObject({ ok: false, error: "resolve_failed" });
    expect(store.has(STATE_KEYS.approvalResolved(APPROVAL))).toBe(false);
    expect(ctx.state.delete).toHaveBeenCalledWith(
      expect.objectContaining({ stateKey: STATE_KEYS.approvalResolved(APPROVAL) }),
    );
  });

  it("uses approvals.resolve instead of the public board-only approvals API", async () => {
    const { ctx, fetch, call } = makeCtx();
    await resolvePaperclipApproval(ctx as any, {
      companyId: COMPANY,
      approvalId: APPROVAL,
      decision: "approve",
      slackUserId: "U_OMAR",
    });

    expect(call).toHaveBeenCalledWith(
      "approvals.resolve",
      expect.objectContaining({
        companyId: COMPANY,
        approvalId: APPROVAL,
        decision: "approve",
        decidedByUserId: "slack:U_OMAR",
      }),
    );
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/approvals/"),
      expect.any(Object),
    );
  });
});

describe("tryUndoResolution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("undoes within the grace window when same user + decision", async () => {
    const { ctx, store } = makeCtx();
    store.set(STATE_KEYS.approvalResolved(APPROVAL), {
      decision: "approve",
      by: "U_OMAR",
      at: new Date().toISOString(),
    });
    const r = await tryUndoResolution(ctx as any, "xoxb", {
      companyId: COMPANY,
      approvalId: APPROVAL,
      decision: "approve",
      slackUserId: "U_OMAR",
      channel: CHANNEL,
      ts: TS,
      paperclipBaseUrl: BASE,
    });
    expect(r.undone).toBe(true);
    expect(store.has(STATE_KEYS.approvalResolved(APPROVAL))).toBe(false);
    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.update",
      expect.objectContaining({
        body: expect.stringContaining("\"blocks\""),
      }),
    );
    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.update",
      expect.objectContaining({
        body: expect.stringContaining("server-side approval was not reverted"),
      }),
    );
  });

  it("does not undo after the grace window elapses", async () => {
    const { ctx, store } = makeCtx();
    const stale = new Date(Date.now() - (UNDO_GRACE_MS + 5_000)).toISOString();
    store.set(STATE_KEYS.approvalResolved(APPROVAL), {
      decision: "approve",
      by: "U_OMAR",
      at: stale,
    });
    const r = await tryUndoResolution(ctx as any, "xoxb", {
      companyId: COMPANY,
      approvalId: APPROVAL,
      decision: "approve",
      slackUserId: "U_OMAR",
      channel: CHANNEL,
      ts: TS,
      paperclipBaseUrl: BASE,
    });
    expect(r.undone).toBe(false);
    // lock remains
    expect(store.get(STATE_KEYS.approvalResolved(APPROVAL))).toBeTruthy();
  });

  it("ignores undo from a different user", async () => {
    const { ctx, store } = makeCtx();
    store.set(STATE_KEYS.approvalResolved(APPROVAL), {
      decision: "approve",
      by: "U_OMAR",
      at: new Date().toISOString(),
    });
    const r = await tryUndoResolution(ctx as any, "xoxb", {
      companyId: COMPANY,
      approvalId: APPROVAL,
      decision: "approve",
      slackUserId: "U_SOMEONE_ELSE",
      channel: CHANNEL,
      ts: TS,
      paperclipBaseUrl: BASE,
    });
    expect(r.undone).toBe(false);
  });
});
