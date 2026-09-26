import { describe, expect, it } from "vitest";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  CROSS_ISSUE_INFLUENCE_LIMIT,
  crossIssueInfluenceLimitError,
  evaluateCrossIssueInfluenceLimit,
  observeCrossIssueInfluence,
  resolveIssueBoundSourceIssueId,
} from "../services/cross-issue-influence-limit.ts";

function counterDb(
  initialCount = 0,
  runOverrides: Record<string, unknown> | null = {},
  issueBinding: Record<string, unknown> | null = null,
) {
  let observedCount = initialCount;
  const inserted: Array<Record<string, unknown>> = [];
  const tx = {
    select: (selection: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          if (Object.keys(selection).includes("count")) {
            return {
              then: (resolve: (rows: unknown[]) => unknown) => resolve([{ count: observedCount }]),
            };
          }
          // The guard takes two row locks: first the heartbeat run, then the
          // target issue's server-written run binding. Only the first selects
          // carry the run columns.
          const selectsRun = Object.keys(selection).includes("contextSnapshot");
          return {
            for: () => ({
              then: (resolve: (rows: unknown[]) => unknown) => {
                if (selectsRun) {
                  return resolve(runOverrides === null ? [] : [{
                    id: "11111111-1111-4111-8111-111111111111",
                    companyId: "22222222-2222-4222-8222-222222222222",
                    agentId: "33333333-3333-4333-8333-333333333333",
                    responsibleUserId: "user-1",
                    contextSnapshot: { issueId: "44444444-4444-4444-8444-444444444444" },
                    ...runOverrides,
                  }]);
                }
                return resolve(issueBinding === null ? [{ checkoutRunId: null, executionRunId: null }] : [issueBinding]);
              },
            }),
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

describe("resolveIssueBoundSourceIssueId", () => {
  const RUN = "11111111-1111-4111-8111-111111111111";
  const ISSUE = "22222222-2222-4222-8222-222222222222";
  const OTHER_RUN = "33333333-3333-4333-8333-333333333333";
  const RUN_CALL = {
    companyId: "22222222-2222-4222-8222-222222222222",
    runId: RUN,
    agentId: "33333333-3333-4333-8333-333333333333",
    targetIssueId: ISSUE,
    kind: "comment",
  } as const;

  it("attributes the write when the run holds the checkout", () => {
    expect(resolveIssueBoundSourceIssueId({ checkoutRunId: RUN, executionRunId: RUN }, RUN, ISSUE)).toBe(ISSUE);
  });

  it("attributes the write when only the checkout is bound", () => {
    expect(resolveIssueBoundSourceIssueId({ checkoutRunId: RUN, executionRunId: null }, RUN, ISSUE)).toBe(ISSUE);
  });

  it("attributes the write when only the execution run is bound", () => {
    expect(resolveIssueBoundSourceIssueId({ checkoutRunId: null, executionRunId: RUN }, RUN, ISSUE)).toBe(ISSUE);
  });

  it("refuses when a different run owns the issue", () => {
    // The binding is server-written, so a mismatch means this run never checked
    // out. Attribution must not be borrowed from whoever holds the lock.
    expect(
      resolveIssueBoundSourceIssueId({ checkoutRunId: OTHER_RUN, executionRunId: OTHER_RUN }, RUN, ISSUE),
    ).toBeNull();
  });

  it("refuses when the issue has no run binding at all", () => {
    expect(resolveIssueBoundSourceIssueId(null, RUN, ISSUE)).toBeNull();
    expect(resolveIssueBoundSourceIssueId({ checkoutRunId: null, executionRunId: null }, RUN, ISSUE)).toBeNull();
  });

  // TES-43: a timer run is dispatched with no source issue, so the snapshot
  // carries nothing. Before this fallback the guard refused every comment and
  // status write for the whole fleet even after the run's own checkout was
  // accepted — the checkout path is the one that has to be exercised.
  it("admits a checkout-bound run whose snapshot names no issue", async () => {
    const fake = counterDb(0, { contextSnapshot: {} }, { checkoutRunId: RUN, executionRunId: RUN });

    await expect(observeCrossIssueInfluence(fake.db as never, RUN_CALL)).resolves.toBeNull();
    expect(fake.inserted).toEqual([]);
  });

  it("still refuses a snapshot-less run that never checked the issue out", async () => {
    const fake = counterDb(0, { contextSnapshot: {} }, { checkoutRunId: OTHER_RUN, executionRunId: OTHER_RUN });

    await expect(observeCrossIssueInfluence(fake.db as never, RUN_CALL)).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_run_context_required" },
    });
    expect(fake.inserted).toEqual([]);
  });
});
