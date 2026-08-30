import { describe, expect, it } from "vitest";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  CROSS_ISSUE_INFLUENCE_LIMIT,
  crossIssueInfluenceLimitError,
  evaluateCrossIssueInfluenceLimit,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.ts";

/** One row of the fake `issues` table, holding only the binding columns the fallback reads. */
type IssueBindingRow = {
  companyId: string;
  id: string;
  checkoutRunId: string | null;
  executionRunId: string | null;
};

/**
 * Collects the bound parameter values out of a drizzle condition.
 *
 * `and(eq(a, x), or(eq(b, y), eq(c, y)))` flattens to a chunk list holding
 * literal SQL fragments (whose value is a `string[]`) alongside bound
 * parameters (whose value is the scalar). Dropping the arrays leaves the
 * values the guard actually filtered on.
 */
function boundParams(condition: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.queryChunks)) {
      for (const chunk of record.queryChunks) walk(chunk);
      return;
    }
    if ("value" in record && !Array.isArray(record.value)) out.push(record.value);
  };
  walk(condition);
  return out;
}

function counterDb(
  initialCount = 0,
  runOverrides: Record<string, unknown> | null = {},
  /**
   * Rows the fake `issues` table holds. The binding lookup matches these on
   * company id and the run's checkout/execution columns, so a binding is only
   * reachable when the guard constrains its query to this company and this
   * run. A lookup that dropped either predicate finds no row here.
   */
  issueRows: IssueBindingRow[] = [],
) {
  let observedCount = initialCount;
  const inserted: Array<Record<string, unknown>> = [];
  const tx = {
    select: (selection: Record<string, unknown>) => ({
      from: () => ({
        where: (condition?: unknown) => {
          if (Object.keys(selection).includes("count")) {
            // Activity-log count query.
            return {
              then: (resolve: (rows: unknown[]) => unknown) => resolve([{ count: observedCount }]),
            };
          }
          if (Object.keys(selection).length === 1 && "id" in selection) {
            // Issues binding query (select {id} from issues where ...).
            const params = boundParams(condition);
            const matched = issueRows.filter((row) => {
              const values = new Set<unknown>([row.companyId, row.id, row.checkoutRunId, row.executionRunId]);
              // Model the equality filter itself: a row survives when every
              // bound value matches one of its columns. A predicate the guard
              // never sent is therefore never applied, so dropping one widens
              // the result set here exactly as it would in PostgreSQL.
              return params.length > 0 && params.every((param) => values.has(param));
            });
            return {
              then: (resolve: (rows: unknown[]) => unknown) =>
                resolve(matched.map((row) => ({ id: row.id }))),
            };
          }
          // Heartbeat-runs row query (uses .for("update")).
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

  it("fails closed when the persisted run has no source issue and no issue binding", async () => {
    // Timer run: empty contextSnapshot, no checkout or execution binding.
    const fake = counterDb(0, { contextSnapshot: {} }, []);

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

  it("adopts a single checkout binding as the source issue for a timer run", async () => {
    // Timer run: empty contextSnapshot (no issueId), but holds the checkout on one issue.
    const fake = counterDb(0, { contextSnapshot: {} }, [{
      companyId: "22222222-2222-4222-8222-222222222222",
      id: "55555555-5555-4555-8555-555555555555",
      checkoutRunId: "11111111-1111-4111-8111-111111111111",
      executionRunId: null,
    }]);

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
    })).resolves.toBeNull();
    // A same-issue write short-circuits and must not count against the cap.
    expect(fake.inserted).toEqual([]);
  });

  it("counts a cross-issue write from a timer run's single binding against the cap", async () => {
    const fake = counterDb(0, { contextSnapshot: {} }, [{
      companyId: "22222222-2222-4222-8222-222222222222",
      id: "44444444-4444-4444-8444-444444444444",
      checkoutRunId: null,
      executionRunId: "11111111-1111-4111-8111-111111111111",
    }]);

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({ allowed: true, count: 1, mode: "enforce" });
    // The bound issue is recorded as the source of the observation.
    expect(fake.inserted).toHaveLength(1);
    expect((fake.inserted[0].details as { sourceIssueId: string }).sourceIssueId)
      .toBe("44444444-4444-4444-8444-444444444444");
  });

  it("fails closed when a timer run holds two issue bindings", async () => {
    // Two issues are bound to this run: the binding is ambiguous, so no
    // source issue can be derived and the guard must refuse.
    const fake = counterDb(0, { contextSnapshot: {} }, [
      {
        companyId: "22222222-2222-4222-8222-222222222222",
        id: "44444444-4444-4444-8444-444444444444",
        checkoutRunId: "11111111-1111-4111-8111-111111111111",
        executionRunId: null,
      },
      {
        companyId: "22222222-2222-4222-8222-222222222222",
        id: "55555555-5555-4555-8555-555555555555",
        checkoutRunId: null,
        executionRunId: "11111111-1111-4111-8111-111111111111",
      },
    ]);

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

  it("ignores issue bindings held by another company", async () => {
    // The binding lookup is company-scoped: a checkout in a different
    // company must not hand this run a source issue.
    const fake = counterDb(0, { contextSnapshot: {} }, [{
      companyId: "99999999-9999-4999-8999-999999999999",
      id: "55555555-5555-4555-8555-555555555555",
      checkoutRunId: "11111111-1111-4111-8111-111111111111",
      executionRunId: null,
    }]);

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
});
