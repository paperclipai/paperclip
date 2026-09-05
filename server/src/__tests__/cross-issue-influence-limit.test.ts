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
          return {
            for: () => ({
              then: (resolve: (rows: unknown[]) => unknown) => resolve(runOverrides === null ? [] : [{
                id: "11111111-1111-4111-8111-111111111111",
                companyId: "22222222-2222-4222-8222-222222222222",
                agentId: "33333333-3333-4333-8333-333333333333",
                responsibleUserId: "user-1",
                contextSnapshot: { issueId: "44444444-4444-4444-8444-444444444444" },
                ...runOverrides,
              }]),
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

  it("counts a write as cross-issue instead of failing closed when a validated run has no source issue (RBR-1186)", async () => {
    // A bare heartbeat-timer wake is never checked out against a single issue
    // up front, so its contextSnapshot legitimately has neither issueId nor
    // taskId. That is not a containment failure like a missing/wrong-agent/
    // wrong-company run (see the "fails closed for a %s locked run" cases
    // above, which still hard-reject) -- it is the normal shape of a
    // multi-issue sweep run, and every write it makes falls through to the
    // counting/cap logic below instead of being rejected before the cap is
    // ever evaluated.
    const fake = counterDb(0, { contextSnapshot: {} });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "update",
    })).resolves.toMatchObject({ allowed: true, count: 1 });
    expect(fake.inserted).toEqual([
      expect.objectContaining({
        action: "issue.cross_issue_influence_observed",
        details: expect.objectContaining({ sourceIssueId: null, targetIssueId: "55555555-5555-4555-8555-555555555555" }),
      }),
    ]);
  });

  it("a run with no source issue writing its own assigned issue still counts against the cap, not a same-issue exemption (RBR-1186)", async () => {
    // With no home issue on the run, there is nothing to exempt a same-issue
    // write against -- so a write to the agent's own in-progress issue from a
    // headless heartbeat-timer run is allowed (not hard-rejected like before
    // the fix) but still consumes one unit of the per-run cap, same as any
    // other target.
    const fake = counterDb(CROSS_ISSUE_INFLUENCE_LIMIT, { contextSnapshot: {} });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({ allowed: false, mode: "enforce", count: CROSS_ISSUE_INFLUENCE_LIMIT + 1 });
    expect(fake.inserted).toEqual([
      expect.objectContaining({ action: "issue.cross_issue_influence_cap_rejected" }),
    ]);
  });
});
