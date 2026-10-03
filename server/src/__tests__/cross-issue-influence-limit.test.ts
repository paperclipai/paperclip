import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { activityLog } from "@paperclipai/db";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  CROSS_ISSUE_INFLUENCE_LIMIT,
  ISSUE_CREATE_RUN_ENFORCE_AT,
  ISSUE_CREATE_RUN_LIMIT,
  crossIssueInfluenceLimitError,
  evaluateCrossIssueInfluenceLimit,
  evaluateIssueCreateLimit,
  evaluateRunWriteLimit,
  issueCreateLimitError,
  observeCrossIssueInfluence,
  observeIssueCreate,
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

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ISSUE_ID = "44444444-4444-4444-8444-444444444444";

/**
 * A fake db whose `activity_log` tally is keyed on the action the query filters by.
 *
 * `counterDb` above returns one count for every `count()` select, which cannot tell the
 * create ledger from the comment ledger — and telling them apart is the whole point of
 * the separate budget. This fake reads the real `where` predicate instead, so a tally
 * that forgot its `action` filter (and therefore folded creates into the shared 20)
 * fails here rather than passing silently.
 */
function issueCreateDb(
  ledger: { create?: number; influence?: number } = {},
  runOverrides: Record<string, unknown> | null = {},
) {
  const counts = { create: ledger.create ?? 0, influence: ledger.influence ?? 0 };
  const inserted: Array<Record<string, unknown>> = [];
  const countedActions: string[] = [];
  const tx = {
    select: (selection: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (condition: SQL) => {
          if (Object.keys(selection).includes("count")) {
            if (table !== activityLog) {
              throw new Error("the per-run tally must count activity_log rows");
            }
            const params = new PgDialect().sqlToQuery(condition).params.map(String);
            const action = params.find((param) => param.startsWith("issue."));
            if (!action) throw new Error("the per-run tally must filter on an action");
            countedActions.push(action);
            const count = action === "issue.issue_create_observed"
              ? counts.create
              : counts.influence;
            return { then: (resolve: (rows: unknown[]) => unknown) => resolve([{ count }]) };
          }
          return {
            for: () => ({
              then: (resolve: (rows: unknown[]) => unknown) => resolve(runOverrides === null ? [] : [{
                id: RUN_ID,
                companyId: COMPANY_ID,
                agentId: AGENT_ID,
                responsibleUserId: "user-1",
                contextSnapshot: { issueId: SOURCE_ISSUE_ID },
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
        if (value.action === "issue.issue_create_observed") counts.create += 1;
        if (value.action === "issue.cross_issue_influence_observed") counts.influence += 1;
      },
    }),
  };
  return { tx, inserted, countedActions };
}

const createInput = {
  companyId: COMPANY_ID,
  runId: RUN_ID,
  agentId: AGENT_ID,
  title: "Stage 3 — implement the gate",
  assigneeAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

describe("per-run issue-create budget", () => {
  it("evaluates any cap and rollout date, not just the module's own", () => {
    const enforceAt = new Date("2027-01-01T00:00:00.000Z");
    expect(evaluateRunWriteLimit({ priorCount: 2, cap: 3, enforceAt, now: enforceAt }))
      .toEqual({ allowed: true, mode: "enforce", count: 3, cap: 3, enforceAt: enforceAt.toISOString() });
    expect(evaluateRunWriteLimit({ priorCount: 3, cap: 3, enforceAt, now: enforceAt }))
      .toEqual({ allowed: false, mode: "enforce", count: 4, cap: 3, enforceAt: enforceAt.toISOString() });
    // The two shipped counters are the same function closed over different constants.
    expect(evaluateCrossIssueInfluenceLimit({ priorCount: 0, now: enforceAt }))
      .toEqual(evaluateRunWriteLimit({
        priorCount: 0,
        cap: CROSS_ISSUE_INFLUENCE_LIMIT,
        enforceAt: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
        now: enforceAt,
      }));
    expect(evaluateIssueCreateLimit({ priorCount: 0, now: enforceAt }))
      .toEqual(evaluateRunWriteLimit({
        priorCount: 0,
        cap: ISSUE_CREATE_RUN_LIMIT,
        enforceAt: ISSUE_CREATE_RUN_ENFORCE_AT,
        now: enforceAt,
      }));
  });

  it("logs creates without refusing any until the create rollout flips", () => {
    // Deliberate: the budget ships in `log_only` so real create volume is measured
    // before anything is refused.
    expect(evaluateIssueCreateLimit({
      priorCount: ISSUE_CREATE_RUN_LIMIT * 10,
      now: new Date(ISSUE_CREATE_RUN_ENFORCE_AT.getTime() - 1),
    })).toMatchObject({
      allowed: true,
      mode: "log_only",
      count: ISSUE_CREATE_RUN_LIMIT * 10 + 1,
      cap: ISSUE_CREATE_RUN_LIMIT,
    });
  });

  it("allows the fortieth create and fails closed on the forty-first after the flip", () => {
    const now = ISSUE_CREATE_RUN_ENFORCE_AT;
    expect(evaluateIssueCreateLimit({ priorCount: ISSUE_CREATE_RUN_LIMIT - 1, now })).toMatchObject({
      allowed: true,
      mode: "enforce",
      count: 40,
      cap: 40,
    });

    const rejected = evaluateIssueCreateLimit({ priorCount: ISSUE_CREATE_RUN_LIMIT, now });
    expect(rejected).toMatchObject({ allowed: false, mode: "enforce", count: 41, cap: 40 });

    const capError = issueCreateLimitError(rejected, { actorLabel: "Senior Engineer" });
    expect(capError.details).toMatchObject({
      code: "issue_create_cap_exceeded",
      cap: 40,
      count: 41,
      mode: "enforce",
      enforceAt: ISSUE_CREATE_RUN_ENFORCE_AT.toISOString(),
    });
    // Same three obligations as every other issue-write denial: boundary, who can
    // act, and the way forward — which for a per-run budget is the next run.
    expect(capError.error).toContain("40");
    expect(capError.error).toContain("Who can act:");
    expect(capError.error).toContain("Try this:");
    expect(capError.error).toContain("next heartbeat");
    expect(capError.details.boundary).toContain("40");
    expect(capError.details.whoCanAct).toContain("Senior Engineer");
    // It is a rate backstop, not a permission wall — the copy must not imply otherwise.
    expect(capError.details.code).not.toBe("cross_issue_influence_cap_exceeded");
  });

  it("charges a create against a ledger the comment counter never reads", async () => {
    // A run that has spent all 20 cross-issue comments is still on create attempt 1.
    const fake = issueCreateDb({ influence: CROSS_ISSUE_INFLUENCE_LIMIT, create: 0 });

    const decision = await observeIssueCreate(fake.tx as never, {
      ...createInput,
      parentIssueId: null,
      now: ISSUE_CREATE_RUN_ENFORCE_AT,
    });

    expect(decision).toMatchObject({ allowed: true, count: 1, cap: ISSUE_CREATE_RUN_LIMIT });
    expect(fake.countedActions).toEqual(["issue.issue_create_observed"]);
    expect(fake.inserted).toHaveLength(1);
    expect(fake.inserted[0]).toMatchObject({ action: "issue.issue_create_observed" });
  });

  it("leaves the comment budget spendable by a run that has spent its create budget", async () => {
    const fake = issueCreateDb({ influence: 0, create: ISSUE_CREATE_RUN_LIMIT });

    const decision = await observeCrossIssueInfluence(
      { transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(fake.tx) } as never,
      {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      agentId: AGENT_ID,
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
      },
    );

    expect(decision).toMatchObject({ allowed: true, count: 1, cap: CROSS_ISSUE_INFLUENCE_LIMIT });
    expect(fake.countedActions).toEqual(["issue.cross_issue_influence_observed"]);
  });

  it("does not count a create whose parent is the run's source issue", async () => {
    // A planning run decomposes its own epic into stages. That
    // is the run's subject, so it is free — like any same-issue write.
    const fake = issueCreateDb({ create: ISSUE_CREATE_RUN_LIMIT });

    const decision = await observeIssueCreate(fake.tx as never, {
      ...createInput,
      parentIssueId: SOURCE_ISSUE_ID,
      now: ISSUE_CREATE_RUN_ENFORCE_AT,
    });

    expect(decision).toBeNull();
    expect(fake.inserted).toEqual([]);
    expect(fake.countedActions).toEqual([]);
  });

  it("matches the run's source issue by human identifier too", async () => {
    const fake = issueCreateDb({}, { contextSnapshot: { issueId: "task-531" } });

    expect(await observeIssueCreate(fake.tx as never, {
      ...createInput,
      parentIssueId: "99999999-9999-4999-8999-999999999999",
      parentIssueIdentifier: "TASK-531",
      now: ISSUE_CREATE_RUN_ENFORCE_AT,
    })).toBeNull();
    expect(fake.inserted).toEqual([]);
  });

  it("charges a parentless create and a foreign-parent create alike", async () => {
    const parentless = issueCreateDb();
    expect(await observeIssueCreate(parentless.tx as never, {
      ...createInput,
      parentIssueId: null,
      now: ISSUE_CREATE_RUN_ENFORCE_AT,
    })).toMatchObject({ allowed: true, count: 1 });

    const foreignParent = issueCreateDb();
    expect(await observeIssueCreate(foreignParent.tx as never, {
      ...createInput,
      parentIssueId: "99999999-9999-4999-8999-999999999999",
      parentIssueIdentifier: "TASK-999",
      now: ISSUE_CREATE_RUN_ENFORCE_AT,
    })).toMatchObject({ allowed: true, count: 1 });
  });

  it("charges every create of an unscoped run, since it has no source issue to parent under", async () => {
    const fake = issueCreateDb({}, { contextSnapshot: {} });

    expect(await observeIssueCreate(fake.tx as never, {
      ...createInput,
      parentIssueId: "99999999-9999-4999-8999-999999999999",
      now: ISSUE_CREATE_RUN_ENFORCE_AT,
    })).toMatchObject({ allowed: true, count: 1 });
    expect(fake.inserted[0]).toMatchObject({ details: expect.objectContaining({ sourceIssueId: null }) });
  });

  it("keys the ledger row on the run, because no issue exists to key it on yet", async () => {
    // The charge happens before the insert, so there is no issue id to name — and
    // `activity_log.entity_id` is NOT NULL. The counter is per-run anyway.
    const fake = issueCreateDb();

    await observeIssueCreate(fake.tx as never, {
      ...createInput,
      parentIssueId: "99999999-9999-4999-8999-999999999999",
      parentIssueIdentifier: "TASK-999",
      now: ISSUE_CREATE_RUN_ENFORCE_AT,
    });

    expect(fake.inserted[0]).toMatchObject({
      companyId: COMPANY_ID,
      actorType: "agent",
      agentId: AGENT_ID,
      runId: RUN_ID,
      action: "issue.issue_create_observed",
      entityType: "heartbeat_run",
      entityId: RUN_ID,
      details: expect.objectContaining({
        parentIssueId: "99999999-9999-4999-8999-999999999999",
        parentIssueIdentifier: "TASK-999",
        title: "Stage 3 — implement the gate",
        assigneeAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sourceIssueId: SOURCE_ISSUE_ID,
        cap: ISSUE_CREATE_RUN_LIMIT,
        count: 1,
        mode: "enforce",
        allowed: true,
      }),
    });
    expect(fake.inserted[0].entityId).not.toBe("99999999-9999-4999-8999-999999999999");
  });

  it("writes nothing at all when it refuses, because the caller's transaction will roll back", async () => {
    // The refusal row cannot be written here: the caller refuses by throwing, which
    // rolls this transaction back and would take the row with it. The durable record
    // is `recordRefusedIssueCreate`, covered against real SQL in the PostgreSQL suite.
    const fake = issueCreateDb({ create: ISSUE_CREATE_RUN_LIMIT });

    const decision = await observeIssueCreate(fake.tx as never, {
      ...createInput,
      parentIssueId: null,
      now: ISSUE_CREATE_RUN_ENFORCE_AT,
    });

    expect(decision).toMatchObject({ allowed: false, count: ISSUE_CREATE_RUN_LIMIT + 1 });
    expect(fake.inserted).toEqual([]);
    // The tally was still read, so the refusal is a real decision and not a shortcut.
    expect(fake.countedActions).toEqual(["issue.issue_create_observed"]);
  });

  it("counts nothing, and refuses nothing, when the run id cannot be resolved", async () => {
    // Deliberately unlike the comment guard, which 403s here. An
    // agent entitled to create must not start failing because its run row is stale or
    // its run header was eaten in transit. An uncountable create is allowed and
    // reported, never refused.
    const malformed = issueCreateDb();
    expect(await observeIssueCreate(malformed.tx as never, {
      ...createInput,
      runId: "attacker-controlled-run-id",
      parentIssueId: null,
      now: ISSUE_CREATE_RUN_ENFORCE_AT,
    })).toBeNull();
    expect(malformed.inserted).toEqual([]);

    const noSuchRun = issueCreateDb({}, null);
    expect(await observeIssueCreate(noSuchRun.tx as never, {
      ...createInput,
      parentIssueId: null,
      now: ISSUE_CREATE_RUN_ENFORCE_AT,
    })).toBeNull();
    expect(noSuchRun.inserted).toEqual([]);
  });
});
