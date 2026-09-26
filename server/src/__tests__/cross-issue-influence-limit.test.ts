import { describe, expect, it } from "vitest";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  CROSS_ISSUE_INFLUENCE_LIMIT,
  crossIssueInfluenceLimitError,
  evaluateCrossIssueInfluenceLimit,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.ts";
import { enrichWakeContextSnapshot } from "../services/heartbeat.ts";

function counterDb(
  initialCount = 0,
  runOverrides: Record<string, unknown> | null = {},
  targetRow: Record<string, unknown> | null = null,
) {
  let observedCount = initialCount;
  const inserted: Array<Record<string, unknown>> = [];
  /** A drizzle result is awaitable and also carries `.for()` / `.limit()`. */
  const rows = (value: unknown[]) => {
    const awaitable = { then: (resolve: (rows: unknown[]) => unknown) => resolve(value) };
    return { ...awaitable, for: () => awaitable, limit: () => awaitable };
  };
  const runRow = runOverrides === null ? [] : [{
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    agentId: "33333333-3333-4333-8333-333333333333",
    responsibleUserId: "user-1",
    contextSnapshot: { issueId: "44444444-4444-4444-8444-444444444444" },
    ...runOverrides,
  }];
  const tx = {
    select: (selection: Record<string, unknown>) => {
      const keys = Object.keys(selection);
      if (keys.includes("count")) {
        return { from: () => ({ where: () => rows([{ count: observedCount }]) }) };
      }
      if (keys.includes("assigneeAgentId")) {
        // The ownership probe the refusal path uses to say whose task it is.
        return {
          from: () => {
            const builder = {
              leftJoin: () => builder,
              where: () => rows(targetRow === null ? [] : [targetRow]),
            };
            return builder;
          },
        };
      }
      return {
        from: () => {
          const builder = {
            where: () => builder,
            for: () => rows(runRow),
          };
          return builder;
        },
      };
    },
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
      details: {
        code: "cross_issue_influence_run_context_required",
        // The run resolved as missing, wrong-agent or wrong-company, so the run
        // header is the remedy for all three and the copy must keep saying so.
        reason: "run_not_found",
      },
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
      details: {
        code: "cross_issue_influence_run_context_required",
        reason: "malformed_run_id",
      },
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
      details: {
        code: "cross_issue_influence_run_context_required",
        reason: "no_context_source_and_target_unbound",
      },
    });
    expect(fake.inserted).toEqual([]);
  });
});

/**
 * The refusal copy has to survive the round trip through the service, not just
 * the copy module: `observeCrossIssueInfluence` is what decides the reason, and
 * it is the only place that knows which condition actually fired.
 */
describe("cross-issue run-context refusal copy", () => {
  const unboundTarget = {
    companyId: "22222222-2222-4222-8222-222222222222",
    runId: "11111111-1111-4111-8111-111111111111",
    agentId: "33333333-3333-4333-8333-333333333333",
    targetIssueId: "55555555-5555-4555-8555-555555555555",
    kind: "comment" as const,
  };

  async function refusal(
    runOverrides: Record<string, unknown>,
    targetRow: Record<string, unknown> | null,
    targetIssueIdentifier?: string | null,
  ) {
    const fake = counterDb(0, runOverrides, targetRow);
    try {
      await observeCrossIssueInfluence(fake.db as never, {
        ...unboundTarget,
        targetIssueIdentifier: targetIssueIdentifier ?? null,
      });
      throw new Error("expected the gate to refuse");
    } catch (err) {
      const http = err as { message?: string; details?: Record<string, unknown> };
      return { error: http.message ?? "", details: http.details ?? {} };
    }
  }

  async function refusalDetails(
    runOverrides: Record<string, unknown>,
    targetRow: Record<string, unknown> | null,
    targetIssueIdentifier?: string | null,
  ) {
    return (await refusal(runOverrides, targetRow, targetIssueIdentifier)).details;
  }

  it("sends an auditor to checkout, not to a header it already sent", async () => {
    // The run is present, belongs to this company and to this agent, and simply
    // holds no task. That is the state the old copy described as "arrived
    // without a valid run", which sent the caller in a circle.
    const details = await refusalDetails(
      { contextSnapshot: {} },
      {
        identifier: "TASK-482",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        assigneeName: "Athena",
      },
    );

    expect(details.reason).toBe("no_context_source_and_target_unbound");
    expect(details.sanctionedPath).toContain("POST /api/issues/{issueId}/checkout");
    expect(details.sanctionedPath).not.toContain("Send the `X-Paperclip-Run-Id`");
    expect(details.targetOwnedByAnotherAgent).toBe(false);
  });

  it("names a step that actually clears the refusal, and the test performs it", async () => {
    // The acceptance criterion for this refusal is that the sanctioned path
    // reaches a 200, so assert on the effect rather than on the prose: refuse,
    // then do exactly what the message says, then write.
    const target = unboundTarget.targetIssueId;
    const details = await refusalDetails(
      { contextSnapshot: {} },
      {
        identifier: "TASK-482",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        assigneeName: "Athena",
      },
    );
    expect(details.reason).toBe("no_context_source_and_target_unbound");

    // `POST /api/agents/{id}/wakeup` with `payload.issueId` folds `issueId` into
    // the new run's `contextSnapshot`, and that is the input this gate reads.
    // A checkout with your own run does not: it writes the issue row, and the
    // wake it might otherwise trigger is suppressed for a self-checkout. So the
    // run-side binding is the step that clears the refusal here.
    //
    // Build the run context through the wake path rather than hand-writing one.
    // A hand-built `{ issueId, taskId }` only proves the gate accepts a context
    // shaped like the wake's output, so if `enrichWakeContextSnapshot` stopped
    // folding the payload, the copy would go on naming a step that no longer
    // clears the refusal and this test would stay green. The arguments below are
    // the ones that route forwards to `heartbeat.wakeup` for an agent caller
    // posting `{ source: "on_demand", payload: { issueId } }`: the actor fields
    // the handler seeds, and the request payload verbatim. That seed carries no
    // `issueId`, so the binding this gate depends on can only come from the fold.
    const routeSeed = {
      triggeredBy: "agent",
      originIdentityContextId: null,
      responsibleUserId: null,
      actorId: "33333333-3333-4333-8333-333333333333",
      forceFreshSession: false,
    };
    expect(routeSeed).not.toHaveProperty("issueId");

    const { contextSnapshot: wokenContextSnapshot } = enrichWakeContextSnapshot({
      contextSnapshot: { ...routeSeed },
      reason: null,
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId: target },
    });
    expect(wokenContextSnapshot.issueId).toBe(target);

    const bound = counterDb(0, { contextSnapshot: wokenContextSnapshot });
    await expect(observeCrossIssueInfluence(bound.db as never, {
      ...unboundTarget,
      targetIssueIdentifier: "TASK-482",
    })).resolves.toBeNull();
    expect(bound.inserted).toEqual([]);

    // The tie: the message has to name that step, or the copy is free to drift
    // away from the gate again. The header advice failed exactly this way.
    expect(details.sanctionedPath).toContain("POST /api/agents/{agentId}/wakeup");
    expect(details.sanctionedPath).toContain("payload");
  });

  it("answers another agent's task in one message, naming both real routes", async () => {
    const { error, details } = await refusal(
      { contextSnapshot: {} },
      {
        identifier: "TASK-482",
        assigneeAgentId: "99999999-9999-4999-8999-999999999999",
        assigneeName: "Hermes",
      },
    );

    expect(details.reason).toBe("no_context_source_and_target_unbound");
    expect(details.targetOwnedByAnotherAgent).toBe(true);
    expect(details.whoCanAct).toContain("Hermes");
    expect(details.sanctionedPath).toContain("child issue");
    expect(details.sanctionedPath).toContain("reassign");
    expect(details.sanctionedPath).not.toContain("POST /api/issues/{issueId}/checkout");
    // The 409 the operator would otherwise meet one step later, with no
    // guidance attached, is named in the same message.
    expect(error).toContain("409");
    expect(error).toContain("Issue checkout conflict");
    expect(error).toContain("TASK-482");
    expect(error).toContain("Hermes");
  });

  it("falls back to the caller's identifier when the ownership probe finds nothing", async () => {
    const details = await refusalDetails({ contextSnapshot: {} }, null, "TASK-482");

    expect(details.reason).toBe("no_context_source_and_target_unbound");
    expect(details.targetOwnedByAnotherAgent).toBe(false);
    expect(details.whoCanAct).toContain("TASK-482");
  });
});
