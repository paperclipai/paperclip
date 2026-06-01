import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveApproval,
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
  const fetch = vi.fn(
    async (_url: string, _init?: unknown) => ({ status: 200, json: async () => ({ ok: true }) }),
  );
  const ctx = {
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
  return { ctx, fetch, store };
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

  it("treats a freeform reply as a revision comment", () => {
    expect(parseThreadCommand("please rethink the rollout")).toEqual({
      kind: "decision",
      decision: "revise",
      reason: "please rethink the rollout",
    });
  });

  it("returns usage for unknown bang command and ignore for empty", () => {
    expect(parseThreadCommand("!frobnicate").kind).toBe("usage");
    expect(parseThreadCommand("   ").kind).toBe("ignore");
  });
});

describe("resolveApproval", () => {
  beforeEach(() => vi.clearAllMocks());

  it("approves: POSTs /approve, sets the lock, and edits the card", async () => {
    const { ctx, fetch, store } = makeCtx();
    const res = await resolveApproval(ctx as any, "xoxb", {
      ...baseParams,
      decision: "approve",
    });
    expect(res.ok).toBe(true);
    // approve POST
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/approvals/${APPROVAL}/approve`,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("slack:U_OMAR"),
      }),
    );
    // status-echo card edit
    expect(fetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.update",
      expect.any(Object),
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

  it("rejects: POSTs /reject", async () => {
    const { ctx, fetch } = makeCtx();
    await resolveApproval(ctx as any, "xoxb", { ...baseParams, decision: "reject" });
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/approvals/${APPROVAL}/reject`,
      expect.any(Object),
    );
  });

  it("revise: POSTs /request-revision with the reason as decisionNote", async () => {
    const { ctx, fetch } = makeCtx();
    await resolveApproval(ctx as any, "xoxb", {
      ...baseParams,
      decision: "revise",
      reason: "add tests",
    });
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/approvals/${APPROVAL}/request-revision`,
      expect.objectContaining({ body: expect.stringContaining("add tests") }),
    );
  });

  it("is idempotent: a second conflicting decision is a no-op", async () => {
    const { ctx, fetch } = makeCtx();
    await resolveApproval(ctx as any, "xoxb", { ...baseParams, decision: "approve" });
    const decideCalls = fetch.mock.calls.filter((c) =>
      String(c[0]).includes("/api/approvals/"),
    ).length;

    const second = await resolveApproval(ctx as any, "xoxb", {
      ...baseParams,
      decision: "reject",
      slackUserId: "U_OTHER",
    });
    expect(second.alreadyResolved).toBe(true);
    // no new approvals API call beyond the first decision
    const after = fetch.mock.calls.filter((c) =>
      String(c[0]).includes("/api/approvals/"),
    ).length;
    expect(after).toBe(decideCalls);
  });

  it("releases the lock and reports when the server returns non-2xx", async () => {
    const { ctx, fetch, store } = makeCtx();
    fetch.mockResolvedValueOnce({ status: 500, json: async () => ({ ok: false }) });
    const res = await resolveApproval(ctx as any, "xoxb", {
      ...baseParams,
      decision: "approve",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("http_500");
    // lock cleared so a corrected retry is possible
    expect(store.has(STATE_KEYS.approvalResolved(APPROVAL))).toBe(false);
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
    });
    expect(r.undone).toBe(true);
    expect(store.has(STATE_KEYS.approvalResolved(APPROVAL))).toBe(false);
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
    });
    expect(r.undone).toBe(false);
  });
});
