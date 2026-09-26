import { describe, expect, it } from "vitest";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  CROSS_ISSUE_INFLUENCE_LIMIT,
  crossIssueInfluenceLimitError,
  evaluateCrossIssueInfluenceLimit,
  observeCrossIssueInfluence,
  runOwnsIssueBinding,
} from "../services/cross-issue-influence-limit.ts";

const RUN = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";

function counterDb(
  initialCount = 0,
  runOverrides: Record<string, unknown> | null = {},
  checkedOutIssues: Array<{ id: string; checkoutRunId?: string | null; executionRunId?: string | null }> = [],
) {
  let observedCount = initialCount;
  const inserted: Array<Record<string, unknown>> = [];
  const tx = {
    select: (selection: Record<string, unknown>) => ({
      from: () => {
        // Only the heartbeat-run select is a row lock; the checkout-source
        // select and the counter read are plain queries.
        const selectsRun = Object.keys(selection).includes("contextSnapshot");
        const bound = selectsRun
          ? (runOverrides === null ? [] : [{
              id: "11111111-1111-4111-8111-111111111111",
              companyId: "22222222-2222-4222-8222-222222222222",
              agentId: "33333333-3333-4333-8333-333333333333",
              responsibleUserId: "user-1",
              contextSnapshot: { issueId: "44444444-4444-4444-8444-444444444444" },
              ...runOverrides,
            }])
          : checkedOutIssues.filter(
              (issue) => issue.checkoutRunId === RUN || issue.executionRunId === RUN,
            );
        return {
          where: () => {
            if (Object.keys(selection).includes("count")) {
              return {
                then: (resolve: (rows: unknown[]) => unknown) => resolve([{ count: observedCount }]),
              };
            }
            return {
              for: () => ({ then: (resolve: (rows: unknown[]) => unknown) => resolve(bound) }),
              limit: () => ({ then: (resolve: (rows: unknown[]) => unknown) => resolve(bound) }),
            };
          },
        };
      },
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

describe("runOwnsIssueBinding", () => {
  const ISSUE = "22222222-2222-4222-8222-222222222222";
  const OTHER_RUN = "33333333-3333-4333-8333-333333333333";

  it("owns the binding when the run holds the checkout", () => {
    expect(runOwnsIssueBinding({ id: ISSUE, checkoutRunId: RUN, executionRunId: RUN }, RUN, ISSUE)).toBe(true);
  });

  it("owns the binding when only the execution run is bound", () => {
    expect(runOwnsIssueBinding({ id: ISSUE, checkoutRunId: null, executionRunId: RUN }, RUN, ISSUE)).toBe(true);
  });

  it("does not own the binding when a different run holds it", () => {
    // The binding is server-written, so a mismatch means this run never checked
    // out. Attribution must not be borrowed from whoever holds the lock.
    expect(
      runOwnsIssueBinding({ id: ISSUE, checkoutRunId: OTHER_RUN, executionRunId: OTHER_RUN }, RUN, ISSUE),
    ).toBe(false);
  });

  it("does not own the binding when the issue is not the one being written", () => {
    expect(runOwnsIssueBinding({ id: ISSUE, checkoutRunId: RUN }, RUN, "44444444-4444-4444-8444-444444444444")).toBe(false);
  });
});

// TES-101: checkout binds a run to one task, and the guard's own 403 tells the
// agent that checking a task out is the way to get a write channel. Before this
// the guard asked the *target* issue whether the run was bound to it, so a run
// that had checked out task X was refused for writing to task Y — the recovery
// step cost a checkout and changed nothing, and no agent could clear the status
// of an issue it did not wake on.
describe("a checkout gives a run a cross-issue write channel", () => {
  const CHECKED_OUT = "aaaa1111-1111-4111-8111-111111111111";
  const TARGET = "bbbb2222-2222-4222-8222-222222222222";
  const AGENT = "33333333-3333-4333-8333-333333333333";
  const CALL = {
    companyId: COMPANY,
    runId: RUN,
    agentId: AGENT,
    targetIssueId: TARGET,
    kind: "update",
    now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  } as const;

  // Acceptance 1: the cap that must keep working.
  it("refuses a run that has checked out nothing", async () => {
    const fake = counterDb(0, { contextSnapshot: {} });

    await expect(observeCrossIssueInfluence(fake.db as never, CALL)).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_run_context_required" },
    });
    expect(fake.inserted).toEqual([]);
  });

  // Acceptance 2: unchanged.
  it("does not count a run writing to the task it is bound to", async () => {
    const fake = counterDb(0, { contextSnapshot: {} }, [
      { id: CHECKED_OUT, checkoutRunId: RUN, executionRunId: RUN },
    ]);

    await expect(observeCrossIssueInfluence(fake.db as never, { ...CALL, targetIssueId: CHECKED_OUT }))
      .resolves.toBeNull();
    expect(fake.inserted).toEqual([]);
  });

  // Acceptance 3: this is the case that failed.
  it("admits a run bound to one task writing to another, and attributes it to the source task", async () => {
    const fake = counterDb(0, { contextSnapshot: {} }, [
      { id: CHECKED_OUT, checkoutRunId: RUN, executionRunId: RUN },
    ]);

    await expect(observeCrossIssueInfluence(fake.db as never, CALL))
      .resolves.toMatchObject({ allowed: true, count: 1, cap: CROSS_ISSUE_INFLUENCE_LIMIT });
    // The counter needs a real source: the task the run checked out, not the
    // issue being written.
    expect(fake.inserted).toEqual([
      expect.objectContaining({
        action: "issue.cross_issue_influence_observed",
        details: expect.objectContaining({ sourceIssueId: CHECKED_OUT, targetIssueId: TARGET }),
      }),
    ]);
  });

  it("still counts that write against the cap, so the run stays bounded", async () => {
    const fake = counterDb(CROSS_ISSUE_INFLUENCE_LIMIT, { contextSnapshot: {} }, [
      { id: CHECKED_OUT, checkoutRunId: RUN, executionRunId: RUN },
    ]);

    await expect(observeCrossIssueInfluence(fake.db as never, CALL)).resolves.toMatchObject({
      allowed: false,
      mode: "enforce",
      count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
    });
  });

  it("still refuses a checkout-less run that only happens to hold the target", async () => {
    const fake = counterDb(0, { contextSnapshot: {} }, [
      { id: CHECKED_OUT, checkoutRunId: "cccccccc-3333-4333-8333-333333333333", executionRunId: null },
    ]);

    await expect(observeCrossIssueInfluence(fake.db as never, CALL)).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_run_context_required" },
    });
  });

  it("prefers the run's own checkout over a stale snapshot issue", async () => {
    const fake = counterDb(0, { contextSnapshot: { issueId: TARGET } }, [
      { id: CHECKED_OUT, checkoutRunId: RUN, executionRunId: null },
    ]);

    await expect(observeCrossIssueInfluence(fake.db as never, CALL)).resolves.toMatchObject({ allowed: true });
    expect(fake.inserted).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ sourceIssueId: CHECKED_OUT }),
      }),
    ]);
  });
});
