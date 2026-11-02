/**
 * Attention delegates: allowlist eligibility, occurrence-scoped capped holds, opt-in config, the decision
 * lookup (only candidate issues, via the activity_log entity index) and the delegate-decision route guards.
 * A pg-proxy drizzle client captures SQL and returns canned rows, so no database is needed.
 */
import express from "express";
import request from "supertest";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { AttentionItem } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  activeDelegateDecision,
  applyDelegateDecisions,
  attentionDelegationEnabled,
  blockerDelegation,
  findDelegatableAttentionItem,
  isAttentionDelegate,
  isDelegatableRecovery,
  isHumanOrSensitiveUnblock,
  stalledBlockerOccurrences,
} from "../services/attention-delegates.js";

const CID = "11111111-1111-4111-8111-111111111111";
const AG = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const ISSUE = "44444444-4444-4444-8444-444444444444";
const DAY = 24 * 60 * 60 * 1000;
const ENV = "PAPERCLIP_ATTENTION_DELEGATES";

function proxyDb(answer: (sql: string, params: unknown[]) => unknown[][] = () => []) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows: answer(sql, params) };
  }) as unknown as Db;
  return { db, queries };
}

describe("attention delegates", () => {
  beforeEach(() => { process.env[ENV] = JSON.stringify({ [CID]: [AG] }); });
  afterEach(() => { delete process.env[ENV]; vi.restoreAllMocks(); });

  it("allowlists board-owned recovery kinds and rejects sensitive or user-owned recovery", () => {
    const r = (o: Record<string, unknown> = {}) => ({ ownerType: "board", kind: "stranded_assigned_issue", cause: "execution_review_participant_recovery", ...o }) as never;
    expect(isDelegatableRecovery(r())).toBe(true);
    for (const kind of ["missing_disposition", "deliberate_wait_without_target", "active_run_watchdog", "issue_graph_liveness"]) {
      expect(isDelegatableRecovery(r({ kind }))).toBe(true);
    }
    expect(isDelegatableRecovery(r({ kind: "configuration_validation", cause: "configuration_incomplete" }))).toBe(false);
    expect(isDelegatableRecovery(r({ kind: "workspace_validation" }))).toBe(false);
    expect(isDelegatableRecovery(r({ cause: "secret_binding_missing" }))).toBe(false);
    expect(isDelegatableRecovery(r({ cause: "budget_exhausted" }))).toBe(false);
    expect(isDelegatableRecovery(r({ ownerType: "user" }))).toBe(false);
    expect(isDelegatableRecovery(r({ ownerType: "agent" }))).toBe(false);
  });

  it("keeps human-owned and grant/spend/access blockers with humans", () => {
    expect(isHumanOrSensitiveUnblock({ owner: { agentId: AG }, action: "Finish the schema review" })).toBe(false);
    expect(isHumanOrSensitiveUnblock({ owner: "board", action: "Pick a layout" })).toBe(true);
    expect(isHumanOrSensitiveUnblock({ owner: { userId: "u" }, action: "Answer" })).toBe(true);
    expect(isHumanOrSensitiveUnblock({ owner: { agentId: AG }, action: "Grant repo access" })).toBe(true);
    expect(isHumanOrSensitiveUnblock({ owner: { agentId: AG }, action: "Approve spend on GPU hours" })).toBe(true);
    const occ = { latest: Date.parse("2026-11-01T00:00:00Z"), blockedIssueIds: ["a"], descriptors: [null] };
    expect(blockerDelegation(ISSUE, occ, null)?.occurrenceStartedAt).toBe("2026-11-01T00:00:00.000Z");
    expect(blockerDelegation(ISSUE, occ, { owner: "board", action: "x" })).toBeNull();
    expect(blockerDelegation(ISSUE, { ...occ, descriptors: [{ owner: { userId: "u" }, action: "y" }] }, null)).toBeNull();
  });

  it("identifies a blocker occurrence by its blocked set and latest transition", () => {
    const blocked = (id: string, at: string, o: Record<string, unknown> = {}) => ({
      id, updatedAt: new Date("2026-11-02"), blockedTransitionAt: new Date(at),
      blockerAttention: { state: "needs_attention", blockingTreeLive: false, terminalBlockerIssueId: ISSUE, ...o },
    });
    const occ = stalledBlockerOccurrences([
      blocked("a", "2026-11-01T05:00:00Z"),
      blocked("b", "2026-11-01T03:00:00Z"),
      blocked("c", "2026-10-01T00:00:00Z", { blockingTreeLive: true }),
      blocked("d", "2026-10-01T00:00:00Z", { state: "covered" }),
    ]);
    expect(new Date(occ.get(ISSUE)!.latest).toISOString()).toBe("2026-11-01T05:00:00.000Z");
    expect(occ.get(ISSUE)!.blockedIssueIds).toEqual(["a", "b"]);
    const before = blockerDelegation(ISSUE, occ.get(ISSUE), null)!;
    // A newly blocked sibling, even one blocked earlier than the latest transition, is a new occurrence.
    const withSibling = stalledBlockerOccurrences([blocked("a", "2026-11-01T05:00:00Z"), blocked("b", "2026-11-01T03:00:00Z"), blocked("e", "2026-11-01T01:00:00Z")]);
    expect(blockerDelegation(ISSUE, withSibling.get(ISSUE), null)!.occurrenceKey).not.toBe(before.occurrenceKey);
    // Same blocked set re-blocked later (tree went live and stalled again): new occurrence.
    const reblocked = stalledBlockerOccurrences([blocked("a", "2026-11-03T05:00:00Z"), blocked("b", "2026-11-01T03:00:00Z")]);
    expect(blockerDelegation(ISSUE, reblocked.get(ISSUE), null)!.occurrenceKey).not.toBe(before.occurrenceKey);
    // Order of the list does not matter.
    const reordered = stalledBlockerOccurrences([blocked("b", "2026-11-01T03:00:00Z"), blocked("a", "2026-11-01T05:00:00Z")]);
    expect(blockerDelegation(ISSUE, reordered.get(ISSUE), null)!.occurrenceKey).toBe(before.occurrenceKey);
  });

  it("applies a decision only to the current occurrence within a mandatory 7-day hold", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    const occ = { occurrenceStartedAt: "2026-11-01T00:00:00.000Z", occurrenceKey: "k1" };
    const d = (o: Record<string, unknown> = {}) => ({ verb: "nudge", reason: "r", occurrenceKey: "k1", decidedByType: "agent", decidedById: AG,
      decidedAt: "2026-11-02T10:00:00.000Z", holdUntil: "2026-11-04T00:00:00.000Z", ...o }) as never;
    expect(activeDelegateDecision(d(), occ, now)).not.toBeNull();
    expect(activeDelegateDecision(d({ holdUntil: null }), occ, now)).toBeNull();
    expect(activeDelegateDecision(d({ holdUntil: "2026-11-02T11:00:00.000Z" }), occ, now)).toBeNull();
    expect(activeDelegateDecision(d({ decidedAt: "2026-10-25T00:00:00.000Z", holdUntil: "2027-01-01T00:00:00.000Z" }),
      { occurrenceStartedAt: "2026-10-20T00:00:00.000Z", occurrenceKey: "k1" }, now)).toBeNull();
    expect(activeDelegateDecision(d(), { occurrenceStartedAt: "2026-11-02T11:00:00.000Z", occurrenceKey: "k1" }, now)).toBeNull();
    expect(activeDelegateDecision(d(), { ...occ, occurrenceKey: "k2" }, now)).toBeNull();
    expect(activeDelegateDecision(d({ occurrenceKey: null }), occ, now)).toBeNull();
    expect(activeDelegateDecision(d(), occ, now, Date.parse("2026-11-02T09:00:00Z"))).not.toBeNull();
    expect(activeDelegateDecision(d(), occ, now, Date.parse("2026-11-02T11:00:00Z"))).toBeNull();
    expect(activeDelegateDecision(d({ verb: "escalate_owner" }), occ, now)).toBeNull();
    expect(activeDelegateDecision(d({ verb: "reopen" }), occ, now)).toBeNull();
  });

  it("is off when unset and warns once per malformed value", () => {
    delete process.env[ENV];
    expect(attentionDelegationEnabled(CID)).toBe(false);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    process.env[ENV] = "{not json";
    expect(attentionDelegationEnabled(CID)).toBe(false);
    expect(attentionDelegationEnabled(CID)).toBe(false);
    process.env[ENV] = JSON.stringify({ [CID]: [AG, 7] });
    expect(isAttentionDelegate(CID, AG)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    process.env[ENV] = JSON.stringify({ [CID]: [AG] });
    expect(isAttentionDelegate(CID, AG)).toBe(true);
    expect(isAttentionDelegate(CID, OTHER)).toBe(false);
  });

  it("fetches decisions only for candidate issues through the entity index and hides decided occurrences", async () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    const decided = "2026-11-02T10:00:00.000Z";
    let liveRun: unknown[][] = [];
    const { db, queries } = proxyDb((sql) => /"heartbeat_runs"/.test(sql) ? liveRun : [
      ["agent", AG, AG, { itemKey: `attention:blocker:${ISSUE}`, verb: "nudge", reason: "woke the owner", holdUntil: "2026-11-04T00:00:00Z", occurrenceKey: "kb" }, decided],
      ["agent", OTHER, OTHER, { itemKey: "attention:recovery:x", verb: "park", reason: "not a delegate", holdUntil: "2026-11-04T00:00:00Z", occurrenceKey: "kr" }, decided],
    ]);
    const items = [
      { dismissalKey: `attention:blocker:${ISSUE}`, sourceKind: "blocker_attention" },
      { dismissalKey: "attention:recovery:x", sourceKind: "recovery_action" },
      { dismissalKey: "attention:approval:z", sourceKind: "approval" },
    ] as AttentionItem[];
    const eligible = new Map([
      [`attention:blocker:${ISSUE}`, { sourceKind: "blocker_attention" as const, issueId: ISSUE, occurrenceStartedAt: "2026-11-01T00:00:00.000Z", occurrenceKey: "kb", liveCheckIssueIds: [ISSUE, "b1"] }],
      ["attention:recovery:x", { sourceKind: "recovery_action" as const, issueId: "55555555-5555-4555-8555-555555555555", occurrenceStartedAt: "2026-11-01T00:00:00.000Z", occurrenceKey: "kr" }],
    ]);
    const hidden = [...items];
    await applyDelegateDecisions(db, CID, hidden, eligible, now, false);
    expect(hidden.map((i) => i.dismissalKey)).toEqual(["attention:recovery:x", "attention:approval:z"]);
    expect(hidden.some((i) => "delegateDecision" in i)).toBe(false);
    expect(queries).toHaveLength(2);
    expect(queries[0].sql).toMatch(/"activity_log"\."entity_type" = \$1/);
    expect(queries[0].sql).toMatch(/"activity_log"\."entity_id" in \(\$2, \$3\)/);
    expect(queries[1].sql).toMatch(/"heartbeat_runs"\."issue_id" in \(\$2, \$3\)/);
    // A run in the tree after the decision means the tree went live: the item shows again.
    liveRun = [["b1", "2026-11-02T11:00:00.000Z"]];
    const afterLive = [...items];
    await applyDelegateDecisions(db, CID, afterLive, eligible, now, false);
    expect(afterLive.map((i) => i.dismissalKey)).toContain(`attention:blocker:${ISSUE}`);
    liveRun = [];
    const shown = [...items];
    await applyDelegateDecisions(db, CID, shown, eligible, now, true);
    expect(shown[0].delegateDecision?.verb).toBe("nudge");
    const { db: db2, queries: q2 } = proxyDb();
    await applyDelegateDecisions(db2, CID, [...items], new Map(), now, false);
    expect(q2).toHaveLength(0);
  });

  it("resolves recovery keys to the live action, its occurrence and eligibility", async () => {
    const row = (o: Record<string, unknown> = {}) => Object.values({
      id: "r1", companyId: CID, sourceIssueId: ISSUE, recoveryIssueId: null, kind: "stranded_assigned_issue", status: "active",
      ownerType: "board", ownerAgentId: null, ownerUserId: null, previousOwnerAgentId: null, returnOwnerAgentId: null,
      cause: "c1", fingerprint: "f:1", evidence: {}, nextAction: "n", wakePolicy: null, monitorPolicy: null, attemptCount: 1,
      maxAttempts: null, timeoutAt: null, lastAttemptAt: null, outcome: null, resolutionNote: null, resolvedAt: null,
      createdAt: "2026-11-02T01:00:00.000Z", updatedAt: "2026-11-02T01:00:00.000Z", ...o,
    });
    const key = `attention:recovery:stranded_assigned_issue:${ISSUE}:c1:f:1`;
    let current = [row()];
    const { db } = proxyDb(() => current);
    expect(await findDelegatableAttentionItem(db, CID, key, null)).toMatchObject({ sourceKind: "recovery_action", occurrenceStartedAt: "2026-11-02T01:00:00.000Z", occurrenceKey: "recovery:r1:2026-11-02T01:00:00.000Z" });
    current = [row({ status: "escalated", evidence: { recoveryBudget: { exhaustedAt: "2026-11-02T05:00:00.000Z" } } })];
    expect(await findDelegatableAttentionItem(db, CID, key, null)).toMatchObject({ occurrenceStartedAt: "2026-11-02T05:00:00.000Z" });
    current = [row({ ownerType: "user", ownerUserId: "u1" })];
    expect(await findDelegatableAttentionItem(db, CID, key, null)).toHaveProperty("ineligible");
    current = [row({ fingerprint: "other" })];
    expect(await findDelegatableAttentionItem(db, CID, key, null)).toBeNull();
    expect(await findDelegatableAttentionItem(db, CID, `attention:blocked-owner:${ISSUE}:t`, null)).toBeNull();
  });
});

describe("POST /companies/:companyId/attention/delegate-decisions guards", () => {
  const delegate = { type: "agent", agentId: AG, companyId: CID, runId: "66666666-6666-4666-8666-666666666666", source: "agent_key" };
  const body = () => ({
    itemKey: `attention:recovery:stranded_assigned_issue:${ISSUE}:c1:f1`,
    verb: "nudge",
    reason: "woke the owner agent to unblock",
    holdUntil: new Date(Date.now() + 2 * DAY).toISOString(),
  });
  function app(actor: Record<string, unknown>) {
    const { db, queries } = proxyDb();
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { (req as unknown as { actor: unknown }).actor = { companyIds: [CID], ...actor }; next(); });
    a.use("/api", issueRoutes(db, { wakeup: async () => null } as never));
    a.use(errorHandler);
    return { a, writes: () => queries.filter((q) => /^insert/i.test(q.sql)) };
  }
  const path = `/api/companies/${CID}/attention/delegate-decisions`;
  beforeEach(() => { process.env[ENV] = JSON.stringify({ [CID]: [AG] }); });
  afterEach(() => { delete process.env[ENV]; });

  it("returns 404 and writes nothing when delegation is disabled", async () => {
    delete process.env[ENV];
    const { a, writes } = app(delegate);
    expect((await request(a).post(path).send(body())).status).toBe(404);
    expect(writes()).toHaveLength(0);
  });

  it("rejects non-delegates, agents without a run, and malformed or uncapped holds", async () => {
    const cases: [Record<string, unknown>, Record<string, unknown>, number][] = [
      [{ ...delegate, agentId: OTHER }, body(), 403],
      [{ ...delegate, runId: undefined }, body(), 401],
      [delegate, { ...body(), holdUntil: undefined }, 400],
      [delegate, { ...body(), holdUntil: new Date(Date.now() + 8 * DAY).toISOString() }, 400],
      [delegate, { ...body(), itemKey: `attention:blocked-owner:${ISSUE}:t` }, 400],
      [delegate, { ...body(), itemKey: "attention:approval:x" }, 400],
      [delegate, { ...body(), reason: "short" }, 400],
    ];
    for (const [actor, payload, status] of cases) {
      const { a, writes } = app(actor);
      expect((await request(a).post(path).send(payload)).status).toBe(status);
      expect(writes()).toHaveLength(0);
    }
  });

  it("returns 404 when no live item has the key", async () => {
    const { a, writes } = app(delegate);
    expect((await request(a).post(path).send(body())).status).toBe(404);
    expect(writes()).toHaveLength(0);
  });
});
