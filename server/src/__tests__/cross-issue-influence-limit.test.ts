import { describe, expect, it } from "vitest";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  CROSS_ISSUE_INFLUENCE_LIMIT,
  crossIssueInfluenceLimitError,
  evaluateCrossIssueInfluenceLimit,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.ts";

function counterDb(
  initialCount = 0,
  runOverrides: Record<string, unknown> | null = {},
  issueState: { lockedIssueId?: string | null; targetAssigneeAgentId?: string | null } = {},
) {
  let observedCount = initialCount;
  const inserted: Array<Record<string, unknown>> = [];
  const rows = (value: unknown[]) => ({
    then: (resolve: (result: unknown[]) => unknown) => resolve(value),
  });
  const tx = {
    select: (selection: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          const keys = Object.keys(selection);
          if (keys.includes("count")) return rows([{ count: observedCount }]);
          // The run's checkout/execution lock — how a timer wake becomes issue-scoped.
          if (keys.length === 1 && keys[0] === "id") {
            return rows(issueState.lockedIssueId ? [{ id: issueState.lockedIssueId }] : []);
          }
          // The target issue's assignee — the own-work fallback.
          if (keys.includes("assigneeAgentId")) {
            return rows([{ assigneeAgentId: issueState.targetAssigneeAgentId ?? null }]);
          }
          return {
            for: () => rows(runOverrides === null ? [] : [{
              id: "11111111-1111-4111-8111-111111111111",
              companyId: "22222222-2222-4222-8222-222222222222",
              agentId: "33333333-3333-4333-8333-333333333333",
              responsibleUserId: "user-1",
              contextSnapshot: { issueId: "44444444-4444-4444-8444-444444444444" },
              ...runOverrides,
            }]),
          };
        },
      }),
    }),
    insert: () => ({
      values: async (value: Record<string, unknown>) => {
        inserted.push(value);
        if (value.action === "issue.cross_issue_influence_observed") observedCount += 1;
      },
    }),
  };
  return {
    db: {
      transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
    },
    inserted,
    get observedCount() {
      return observedCount;
    },
  };
}

// The shape a timer/board wake actually persists: no issueId, no taskId.
// Measured 2026-09-20: 86 runs in 7 days, every issue write denied (TES-2107).
const TIMER_WAKE_SNAPSHOT = {
  contextSnapshot: { actorId: "local-board", wakeSource: "on_demand", triggeredBy: "board" },
};

describe("cross-issue influence limit rollout", () => {
  it("logs observations without enforcement during the one-week rollout", () => {
    const decision = evaluateCrossIssueInfluenceLimit({
      priorCount: CROSS_ISSUE_INFLUENCE_LIMIT,
      now: new Date(CROSS_ISSUE_INFLUENCE_ENFORCE_AT.getTime() - 1),
    });

    expect(decision).toMatchObject({
      allowed: true,
      mode: "log_only",
      count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
      cap: CROSS_ISSUE_INFLUENCE_LIMIT,
    });
  });

  it("allows the twentieth influence and fails closed on the twenty-first after the flip", () => {
    const now = CROSS_ISSUE_INFLUENCE_ENFORCE_AT;
    expect(evaluateCrossIssueInfluenceLimit({ priorCount: 19, now })).toMatchObject({
      allowed: true,
      mode: "enforce",
      count: 20,
      cap: 20,
    });

    const rejected = evaluateCrossIssueInfluenceLimit({ priorCount: 20, now });
    expect(rejected).toMatchObject({
      allowed: false,
      mode: "enforce",
      count: 21,
      cap: 20,
    });
    const capError = crossIssueInfluenceLimitError(rejected, {
      actorLabel: "Fable",
      issueIdentifier: "TASK-482",
    });
    expect(capError.details).toMatchObject({
      code: "cross_issue_influence_cap_exceeded",
      cap: 20,
      count: 21,
      mode: "enforce",
      enforceAt: CROSS_ISSUE_INFLUENCE_ENFORCE_AT.toISOString(),
    });
    // Plan §6: the 429 names the boundary, who can act, and the way forward.
    expect(capError.error).toContain("20");
    expect(capError.error).toContain("Who can act:");
    expect(capError.error).toContain("Try this:");
    expect(capError.error).toContain("next heartbeat");
    expect(capError.details.boundary).toContain("20");
    expect(capError.details.whoCanAct).toContain("Fable");
  });

  it("uses one durable counter for cross-issue comments, PATCH updates, and interaction resolutions", async () => {
    const fake = counterDb();
    const base = {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      now: new Date(CROSS_ISSUE_INFLUENCE_ENFORCE_AT.getTime() - 1),
    } as const;

    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "comment" }))
      .resolves.toMatchObject({ count: 1, allowed: true });
    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "update" }))
      .resolves.toMatchObject({ count: 2, allowed: true });
    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "interaction_resolution" }))
      .resolves.toMatchObject({ count: 3, allowed: true });

    expect(fake.observedCount).toBe(3);
    expect(fake.inserted.map((row) => (row.details as { kind: string }).kind))
      .toEqual(["comment", "update", "interaction_resolution"]);
  });

  it("counts an interaction resolution against a budget already spent on comments", async () => {
    const fake = counterDb(CROSS_ISSUE_INFLUENCE_LIMIT);

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "interaction_resolution",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({
      allowed: false,
      mode: "enforce",
      count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
    });
    expect(fake.inserted).toEqual([
      expect.objectContaining({ action: "issue.cross_issue_influence_cap_rejected" }),
    ]);
  });

  it("does not count same-issue writes", async () => {
    const fake = counterDb(0, {
      contextSnapshot: { issueId: "55555555-5555-4555-8555-555555555555" },
    });
    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
    })).resolves.toBeNull();
    expect(fake.inserted).toEqual([]);
  });

  it.each([
    ["missing", null],
    ["wrong-agent", { agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    ["wrong-company", { companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
  ] as const)("fails closed for a %s locked run", async (_label, runOverrides) => {
    const fake = counterDb(0, runOverrides);

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_run_context_required" },
    });
    expect(fake.inserted).toEqual([]);
  });

  it("fails closed before querying for a malformed run id", async () => {
    const fake = counterDb();

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "attacker-controlled-run-id",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_run_context_required" },
    });
    expect(fake.inserted).toEqual([]);
  });

  it("fails closed when the persisted run has no source issue", async () => {
    const fake = counterDb(0, { contextSnapshot: {} });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "update",
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_run_context_required" },
    });
    expect(fake.inserted).toEqual([]);
  });
});

/**
 * TES-2107. A timer/board wake persists no source issue, so reading the snapshot
 * alone made the guard throw before it could reach the own-issue passthrough —
 * every agent lost the ability to dispose of its own work from a heartbeat, and
 * 54 issues force-blocked with `unblockDescriptor: null` over 32 days.
 */
describe("timer-wake runs without a snapshot source issue", () => {
  const base = {
    companyId: "22222222-2222-4222-8222-222222222222",
    runId: "11111111-1111-4111-8111-111111111111",
    agentId: "33333333-3333-4333-8333-333333333333",
    targetIssueId: "55555555-5555-4555-8555-555555555555",
  } as const;

  it("lets an agent update its own assigned issue", async () => {
    const fake = counterDb(0, TIMER_WAKE_SNAPSHOT, { targetAssigneeAgentId: base.agentId });

    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "update" }))
      .resolves.toMatchObject({ allowed: true });
  });

  it("lets an agent comment on its own assigned issue", async () => {
    const fake = counterDb(0, TIMER_WAKE_SNAPSHOT, { targetAssigneeAgentId: base.agentId });

    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "comment" }))
      .resolves.toMatchObject({ allowed: true });
  });

  it("still meters own-issue writes against the per-run cap", async () => {
    const fake = counterDb(CROSS_ISSUE_INFLUENCE_LIMIT, TIMER_WAKE_SNAPSHOT, {
      targetAssigneeAgentId: base.agentId,
    });

    // Permission is restored; the rate backstop is not. An agent can own dozens
    // of issues, and a runaway sweep across all of them is what the cap bounds.
    await expect(observeCrossIssueInfluence(fake.db as never, {
      ...base,
      kind: "update",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({
      allowed: false,
      mode: "enforce",
      count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
    });
    expect(fake.inserted).toEqual([
      expect.objectContaining({ action: "issue.cross_issue_influence_cap_rejected" }),
    ]);
  });

  it("charges nothing for the issue the run holds the checkout lock on", async () => {
    const fake = counterDb(0, TIMER_WAKE_SNAPSHOT, { lockedIssueId: base.targetIssueId });

    // A timer wake that checks an issue out is issue-scoped from that point on,
    // even though the snapshot written at wake time cannot say so.
    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "update" }))
      .resolves.toBeNull();
    expect(fake.inserted).toEqual([]);
  });

  it("charges a write to an issue the run did not check out", async () => {
    const fake = counterDb(0, TIMER_WAKE_SNAPSHOT, {
      lockedIssueId: "66666666-6666-4666-8666-666666666666",
    });

    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "comment" }))
      .resolves.toMatchObject({ count: 1, allowed: true });
    expect(fake.inserted).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ sourceOrigin: "checkout" }),
      }),
    ]);
  });

  it("still fails closed on an issue that is neither checked out nor the agent's own", async () => {
    const fake = counterDb(0, TIMER_WAKE_SNAPSHOT, {
      targetAssigneeAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "update" }))
      .rejects.toMatchObject({
        status: 403,
        details: { code: "cross_issue_influence_run_context_required" },
      });
    expect(fake.inserted).toEqual([]);
  });
});
