import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveApproval,
  resolvePaperclipApproval,
  requestRevision,
  stagePendingReaction,
  handleReactionRemoved,
  commitApproval,
  commitDuePendingApprovals,
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

const reactionParams = {
  companyId: COMPANY,
  approvalId: APPROVAL,
  slackUserId: "U_OMAR",
  channel: CHANNEL,
  ts: TS,
  paperclipBaseUrl: BASE,
};

const threadParams = {
  companyId: COMPANY,
  approvalId: APPROVAL,
  slackUserId: "U_OMAR",
  channel: CHANNEL,
  ts: TS,
  paperclipBaseUrl: BASE,
};

/** Body string of every chat.update / chat.postMessage call, concatenated. */
function slackText(fetch: ReturnType<typeof vi.fn>): string {
  return fetch.mock.calls.map((c: unknown[]) => JSON.stringify(c[1])).join("\n");
}

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

  it("treats a freeform reply as a revision comment (BLO-8568/BLO-8861)", () => {
    expect(parseThreadCommand("please rethink the rollout")).toEqual({
      kind: "freeform_revision",
      reason: "please rethink the rollout",
    });
  });

  it("returns usage for unknown bang command and ignore for empty", () => {
    expect(parseThreadCommand("!frobnicate").kind).toBe("usage");
    expect(parseThreadCommand("   ").kind).toBe("ignore");
  });
});

describe("stagePendingReaction (two-phase resolve)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stages a pending decision WITHOUT committing to the host", async () => {
    const { ctx, fetch, call, store } = makeCtx();
    const res = await stagePendingReaction(ctx as any, "xoxb", {
      ...reactionParams,
      decision: "approve",
      authorized: true,
    });
    expect(res.staged).toBe(true);
    // No host resolve call during the grace window — approval stays unresolved.
    expect(call).not.toHaveBeenCalled();
    // Pending record + index persisted.
    expect(store.get(STATE_KEYS.approvalPending(APPROVAL))).toMatchObject({
      decision: "approve",
      by: "U_OMAR",
      channel: CHANNEL,
      ts: TS,
    });
    expect(store.get(STATE_KEYS.approvalPendingIndex)).toEqual([APPROVAL]);
    // No committed lock yet.
    expect(store.has(STATE_KEYS.approvalResolved(APPROVAL))).toBe(false);
    // Card edited to a "pending / undo within Ns" state.
    expect(slackText(fetch)).toContain("Pending");
    expect(ctx.metrics.write).toHaveBeenCalledWith(
      "slack.approvals.staged",
      1,
      expect.objectContaining({ source: "slack_interaction" }),
    );
  });

  it("unauthorized reactor: no host call, no state change, posts not-authorized note (AC5)", async () => {
    const { ctx, fetch, call, store } = makeCtx();
    const res = await stagePendingReaction(ctx as any, "xoxb", {
      ...reactionParams,
      slackUserId: "U_RANDO",
      decision: "approve",
      authorized: false,
    });
    expect(res.staged).toBe(false);
    expect(res.unauthorized).toBe(true);
    expect(call).not.toHaveBeenCalled();
    expect(store.has(STATE_KEYS.approvalPending(APPROVAL))).toBe(false);
    expect(slackText(fetch)).toContain("not on the approval allowlist");
    // No card edit (chat.update) was made.
    expect(fetch).not.toHaveBeenCalledWith(
      "https://slack.com/api/chat.update",
      expect.any(Object),
    );
  });

  it("is a no-op when a decision is already committed", async () => {
    const { ctx, call, store } = makeCtx();
    store.set(STATE_KEYS.approvalResolved(APPROVAL), {
      decision: "approve",
      by: "U_OMAR",
      at: new Date().toISOString(),
    });
    const res = await stagePendingReaction(ctx as any, "xoxb", {
      ...reactionParams,
      decision: "reject",
      slackUserId: "U_OTHER",
      authorized: true,
    });
    expect(res.alreadyResolved).toBe(true);
    expect(call).not.toHaveBeenCalled();
    expect(store.has(STATE_KEYS.approvalPending(APPROVAL))).toBe(false);
  });

  it("is a no-op when a decision is already pending (✅-then-❌ race)", async () => {
    const { ctx, call, store } = makeCtx();
    await stagePendingReaction(ctx as any, "xoxb", {
      ...reactionParams,
      decision: "approve",
      authorized: true,
    });
    const res = await stagePendingReaction(ctx as any, "xoxb", {
      ...reactionParams,
      decision: "reject",
      slackUserId: "U_OTHER",
      authorized: true,
    });
    expect(res.alreadyPending).toBe(true);
    expect(call).not.toHaveBeenCalled();
    // Original pending decision is untouched.
    expect(store.get(STATE_KEYS.approvalPending(APPROVAL))).toMatchObject({
      decision: "approve",
      by: "U_OMAR",
    });
  });
});

describe("handleReactionRemoved", () => {
  beforeEach(() => vi.clearAllMocks());

  it("add then remove within grace leaves the approval UNRESOLVED (AC2)", async () => {
    const { ctx, fetch, call, store } = makeCtx();
    await stagePendingReaction(ctx as any, "xoxb", {
      ...reactionParams,
      decision: "approve",
      authorized: true,
    });
    const res = await handleReactionRemoved(ctx as any, "xoxb", {
      ...reactionParams,
      decision: "approve",
    });
    expect(res.undone).toBe(true);
    expect(res.committed).toBe(false);
    // The host resolver was NEVER called across the whole add+remove flow.
    expect(call).not.toHaveBeenCalled();
    // Pending record + index cleared; no committed lock created.
    expect(store.has(STATE_KEYS.approvalPending(APPROVAL))).toBe(false);
    expect(store.get(STATE_KEYS.approvalPendingIndex)).toEqual([]);
    expect(store.has(STATE_KEYS.approvalResolved(APPROVAL))).toBe(false);
    // Honest undo state shown on the card.
    expect(slackText(fetch)).toContain("remains *unresolved*");
    expect(ctx.metrics.write).toHaveBeenCalledWith(
      "slack.approvals.undone",
      1,
      expect.objectContaining({ decision: "approve" }),
    );
  });

  it("removal after the grace window commits the decision + posts too-late note (AC3)", async () => {
    const { ctx, fetch, call, store } = makeCtx();
    const stale = new Date(Date.now() - (UNDO_GRACE_MS + 5_000)).toISOString();
    store.set(STATE_KEYS.approvalPending(APPROVAL), {
      decision: "approve",
      by: "U_OMAR",
      at: stale,
      channel: CHANNEL,
      ts: TS,
    });
    store.set(STATE_KEYS.approvalPendingIndex, [APPROVAL]);
    const res = await handleReactionRemoved(ctx as any, "xoxb", {
      ...reactionParams,
      decision: "approve",
    });
    expect(res.committed).toBe(true);
    expect(res.undone).toBe(false);
    // Committed to the host exactly once.
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      "approvals.resolve",
      expect.objectContaining({ decision: "approve", decidedByUserId: "slack:U_OMAR" }),
    );
    expect(store.get(STATE_KEYS.approvalResolved(APPROVAL))).toMatchObject({ decision: "approve" });
    expect(store.has(STATE_KEYS.approvalPending(APPROVAL))).toBe(false);
    expect(slackText(fetch)).toContain("Too late to undo");
  });

  it("removal of an already-committed decision is a too-late no-op (AC3)", async () => {
    const { ctx, fetch, call, store } = makeCtx();
    store.set(STATE_KEYS.approvalResolved(APPROVAL), {
      decision: "approve",
      by: "U_OMAR",
      at: new Date().toISOString(),
    });
    const res = await handleReactionRemoved(ctx as any, "xoxb", {
      ...reactionParams,
      decision: "approve",
    });
    expect(res.committed).toBe(true);
    expect(res.undone).toBe(false);
    // No new host call — the committed decision is intact.
    expect(call).not.toHaveBeenCalled();
    expect(slackText(fetch)).toContain("remains approved server-side");
  });

  it("ignores a removal from a different user", async () => {
    const { ctx, call, store } = makeCtx();
    await stagePendingReaction(ctx as any, "xoxb", {
      ...reactionParams,
      decision: "approve",
      authorized: true,
    });
    const res = await handleReactionRemoved(ctx as any, "xoxb", {
      ...reactionParams,
      decision: "approve",
      slackUserId: "U_SOMEONE_ELSE",
    });
    expect(res.undone).toBe(false);
    expect(res.committed).toBe(false);
    expect(call).not.toHaveBeenCalled();
    // Original pending decision survives so the cron can still commit it.
    expect(store.get(STATE_KEYS.approvalPending(APPROVAL))).toMatchObject({ by: "U_OMAR" });
  });
});

describe("commitDuePendingApprovals (cron backstop)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("commits a pending decision once its grace window elapsed (AC1)", async () => {
    const { ctx, call, store } = makeCtx();
    const stale = new Date(Date.now() - (UNDO_GRACE_MS + 5_000)).toISOString();
    store.set(STATE_KEYS.approvalPending(APPROVAL), {
      decision: "approve",
      by: "U_OMAR",
      at: stale,
      channel: CHANNEL,
      ts: TS,
    });
    store.set(STATE_KEYS.approvalPendingIndex, [APPROVAL]);

    const res = await commitDuePendingApprovals(ctx as any, "xoxb", {
      companyId: COMPANY,
      paperclipBaseUrl: BASE,
    });
    expect(res.committed).toBe(1);
    expect(call).toHaveBeenCalledWith(
      "approvals.resolve",
      expect.objectContaining({ decision: "approve" }),
    );
    expect(store.get(STATE_KEYS.approvalResolved(APPROVAL))).toMatchObject({ decision: "approve" });
    expect(store.get(STATE_KEYS.approvalPendingIndex)).toEqual([]);
    expect(store.has(STATE_KEYS.approvalPending(APPROVAL))).toBe(false);
  });

  it("leaves a still-fresh pending decision uncommitted", async () => {
    const { ctx, call, store } = makeCtx();
    store.set(STATE_KEYS.approvalPending(APPROVAL), {
      decision: "approve",
      by: "U_OMAR",
      at: new Date().toISOString(),
      channel: CHANNEL,
      ts: TS,
    });
    store.set(STATE_KEYS.approvalPendingIndex, [APPROVAL]);

    const res = await commitDuePendingApprovals(ctx as any, "xoxb", {
      companyId: COMPANY,
      paperclipBaseUrl: BASE,
    });
    expect(res.committed).toBe(0);
    expect(res.pending).toBe(1);
    expect(call).not.toHaveBeenCalled();
    expect(store.has(STATE_KEYS.approvalResolved(APPROVAL))).toBe(false);
  });

  it("prunes a stale index entry whose pending record is gone", async () => {
    const { ctx, call, store } = makeCtx();
    store.set(STATE_KEYS.approvalPendingIndex, [APPROVAL]);
    const res = await commitDuePendingApprovals(ctx as any, "xoxb", {
      companyId: COMPANY,
      paperclipBaseUrl: BASE,
    });
    expect(res.committed).toBe(0);
    expect(call).not.toHaveBeenCalled();
    expect(store.get(STATE_KEYS.approvalPendingIndex)).toEqual([]);
  });
});

describe("commitApproval (terminal commit)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("approves through approvals.resolve, sets the lock, and edits the card", async () => {
    const { ctx, fetch, call, store } = makeCtx();
    const res = await commitApproval(ctx as any, "xoxb", {
      ...reactionParams,
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
    expect(fetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.update",
      expect.objectContaining({ body: expect.stringContaining("\"blocks\"") }),
    );
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

  it("is idempotent: a second conflicting decision is a no-op", async () => {
    const { ctx, call } = makeCtx();
    await commitApproval(ctx as any, "xoxb", { ...reactionParams, decision: "approve" });
    const decideCalls = call.mock.calls.length;
    const second = await commitApproval(ctx as any, "xoxb", {
      ...reactionParams,
      decision: "reject",
      slackUserId: "U_OTHER",
    });
    expect(second.alreadyResolved).toBe(true);
    expect(call.mock.calls.length).toBe(decideCalls);
  });

  it("releases the lock and reports when the host resolver rejects", async () => {
    const { ctx, call, store } = makeCtx();
    call.mockRejectedValueOnce(new Error("resolver unavailable"));
    const res = await commitApproval(ctx as any, "xoxb", {
      ...reactionParams,
      decision: "approve",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("resolve_failed");
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
    const res = await commitApproval(ctx as any, "xoxb", {
      ...reactionParams,
      decision: "approve",
    });
    expect(res).toMatchObject({ ok: false, alreadyResolved: true });
    expect(store.has(STATE_KEYS.approvalResolved(APPROVAL))).toBe(false);
    expect(fetch).not.toHaveBeenCalledWith(
      "https://slack.com/api/chat.update",
      expect.any(Object),
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({ body: expect.stringContaining("already resolved server-side") }),
    );
  });
});

describe("resolveApproval (explicit thread command)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("approve commits immediately (no grace window)", async () => {
    const { ctx, call, store } = makeCtx();
    const res = await resolveApproval(ctx as any, "xoxb", { ...threadParams, decision: "approve" });
    expect(res.ok).toBe(true);
    expect(call).toHaveBeenCalledWith(
      "approvals.resolve",
      expect.objectContaining({ decision: "approve" }),
    );
    expect(store.get(STATE_KEYS.approvalResolved(APPROVAL))).toMatchObject({ decision: "approve" });
  });

  it("is a no-op while a reaction decision is pending in its undo window", async () => {
    const { ctx, call, store } = makeCtx();
    store.set(STATE_KEYS.approvalPending(APPROVAL), {
      decision: "approve",
      by: "U_OMAR",
      at: new Date().toISOString(),
      channel: CHANNEL,
      ts: TS,
    });
    const res = await resolveApproval(ctx as any, "xoxb", {
      ...threadParams,
      decision: "reject",
      slackUserId: "U_OTHER",
    });
    expect(res.alreadyResolved).toBe(true);
    expect(call).not.toHaveBeenCalled();
    expect(store.has(STATE_KEYS.approvalResolved(APPROVAL))).toBe(false);
  });

  it("revise delegates to a non-terminal revision comment (no resolved lock)", async () => {
    const { ctx, call, store } = makeCtx();
    const res = await resolveApproval(ctx as any, "xoxb", {
      ...threadParams,
      decision: "revise",
      reason: "add tests",
    });
    expect(res.ok).toBe(true);
    expect(call).toHaveBeenCalledWith(
      "approvals.resolve",
      expect.objectContaining({ decision: "revise", decisionNote: "add tests" }),
    );
    // Non-terminal: the approval is NOT locked, so it stays open for approve/reject.
    expect(store.has(STATE_KEYS.approvalResolved(APPROVAL))).toBe(false);
  });
});

describe("requestRevision (freeform + !revise → host approval API) (AC4)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends the reply text to the host as a revision comment without locking", async () => {
    const { ctx, fetch, call, store } = makeCtx();
    const res = await requestRevision(ctx as any, "xoxb", {
      ...threadParams,
      reason: "please rethink the rollout",
    });
    expect(res.ok).toBe(true);
    expect(call).toHaveBeenCalledWith(
      "approvals.resolve",
      expect.objectContaining({
        companyId: COMPANY,
        approvalId: APPROVAL,
        decision: "revise",
        decisionNote: "please rethink the rollout",
        decidedByUserId: "slack:U_OMAR",
      }),
    );
    expect(slackText(fetch)).toContain("Revision requested");
    expect(store.has(STATE_KEYS.approvalResolved(APPROVAL))).toBe(false);
    expect(ctx.metrics.write).toHaveBeenCalledWith(
      "slack.approvals.decided",
      1,
      expect.objectContaining({ decision: "request-revision", source: "slack_interaction" }),
    );
  });

  it("is a no-op note once the approval is terminally committed", async () => {
    const { ctx, call, store } = makeCtx();
    store.set(STATE_KEYS.approvalResolved(APPROVAL), {
      decision: "approve",
      by: "U_OMAR",
      at: new Date().toISOString(),
    });
    const res = await requestRevision(ctx as any, "xoxb", {
      ...threadParams,
      reason: "too late",
    });
    expect(res.alreadyResolved).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("uses approvals.resolve, never the public board-only approvals API", async () => {
    const { ctx, fetch, call } = makeCtx();
    await resolvePaperclipApproval(ctx as any, {
      companyId: COMPANY,
      approvalId: APPROVAL,
      decision: "approve",
      slackUserId: "U_OMAR",
    });
    expect(call).toHaveBeenCalledWith(
      "approvals.resolve",
      expect.objectContaining({ companyId: COMPANY, decidedByUserId: "slack:U_OMAR" }),
    );
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/approvals/"),
      expect.any(Object),
    );
  });
});
