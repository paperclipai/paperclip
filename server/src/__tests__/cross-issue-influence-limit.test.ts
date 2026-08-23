import { describe, expect, it } from "vitest";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  CROSS_ISSUE_INFLUENCE_LIMIT,
  crossIssueInfluenceLimitError,
  crossIssueWriteGrantError,
  evaluateCrossIssueInfluenceLimit,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.ts";
import {
  crossIssueWriteGrantEnforceAt,
  evaluateCrossIssueWriteGrant,
} from "../services/cross-issue-write-basis.ts";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const TARGET_ISSUE_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_AGENT_ID = "66666666-6666-4666-8666-666666666666";

function issueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_ISSUE_ID,
    parentId: null,
    projectId: null,
    // Unassigned by default: the `target_has_no_agent_assignee` basis, which is
    // the single most common shape in the observed traffic (26%).
    assigneeAgentId: null,
    createdByAgentId: null,
    originKind: "manual",
    originId: null,
    originFingerprint: "default",
    ...overrides,
  };
}

function counterDb(
  initialCount = 0,
  runOverrides: Record<string, unknown> | null = {},
  basisOverrides: {
    issues?: Array<Record<string, unknown>>;
    ancestors?: Array<{ seed: string; id: string }>;
    grantScope?: Record<string, unknown> | null;
  } = {},
) {
  let observedCount = initialCount;
  const inserted: Array<Record<string, unknown>> = [];
  const issueRows = basisOverrides.issues ?? [
    issueRow({ id: SOURCE_ISSUE_ID }),
    issueRow({ id: TARGET_ISSUE_ID }),
  ];
  const resolved = (rows: unknown[]) => ({
    then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
  });
  const tx = {
    select: (selection: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          const keys = Object.keys(selection);
          if (keys.includes("count")) return resolved([{ count: observedCount }]);
          // Issue facts for the basis resolver.
          if (keys.includes("originFingerprint")) return resolved(issueRows);
          // The `issues:cross-write` grant lookup; undefined means "no row".
          if (keys.length === 1 && keys[0] === "scope") {
            return resolved(
              basisOverrides.grantScope === undefined ? [] : [{ scope: basisOverrides.grantScope }],
            );
          }
          return {
            for: () => resolved(runOverrides === null ? [] : [{
              id: RUN_ID,
              companyId: COMPANY_ID,
              agentId: AGENT_ID,
              responsibleUserId: "user-1",
              contextSnapshot: { issueId: SOURCE_ISSUE_ID },
              ...runOverrides,
            }]),
          };
        },
      }),
    }),
    execute: async () => basisOverrides.ancestors ?? [],
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
      insert: tx.insert,
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

describe("cross-issue write grant (FAI-10132)", () => {
  const base = {
    companyId: COMPANY_ID,
    runId: RUN_ID,
    agentId: AGENT_ID,
    targetIssueId: TARGET_ISSUE_ID,
    kind: "comment",
  } as const;
  const ENFORCE_AT = new Date("2026-09-01T00:00:00.000Z");
  const AFTER = new Date(ENFORCE_AT.getTime() + 1);
  /** Target held by another agent, no tree/creator/origin relationship. */
  const unrelated = {
    issues: [
      issueRow({ id: SOURCE_ISSUE_ID }),
      issueRow({ id: TARGET_ISSUE_ID, assigneeAgentId: OTHER_AGENT_ID, projectId: "project-a" }),
    ],
  };

  it("denies a write with no basis once enforcement is armed, and never spends cap budget on it", async () => {
    const fake = counterDb(0, {}, unrelated);

    await expect(observeCrossIssueInfluence(fake.db as never, {
      ...base,
      targetIssueIdentifier: "TASK-482",
      now: AFTER,
      enforceGrantAt: ENFORCE_AT,
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_write_grant_required" },
    });

    // The refusal is audited, and the per-run counter is untouched: "not
    // permitted" must never read as "out of budget".
    expect(fake.inserted).toEqual([
      expect.objectContaining({
        action: "issue.cross_issue_write_grant_denied",
        details: expect.objectContaining({ basis: null, grantMode: "enforce" }),
      }),
    ]);
    expect(fake.observedCount).toBe(0);
  });

  it("allows the same write in the shadow phase but records what enforcement would have refused", async () => {
    const fake = counterDb(0, {}, unrelated);

    await expect(observeCrossIssueInfluence(fake.db as never, {
      ...base,
      now: AFTER,
      enforceGrantAt: null,
    })).resolves.toMatchObject({ allowed: true, count: 1 });

    expect(fake.inserted.map((row) => row.action)).toEqual([
      "issue.cross_issue_write_grant_would_deny",
      "issue.cross_issue_influence_observed",
    ]);
  });

  it.each([
    ["the actor owns the target", { assigneeAgentId: AGENT_ID }, "actor_is_target_assignee"],
    ["the target has no agent assignee", { assigneeAgentId: null }, "target_has_no_agent_assignee"],
    ["the actor created the target", { assigneeAgentId: OTHER_AGENT_ID, createdByAgentId: AGENT_ID }, "actor_created_target"],
  ] as const)("allows and names the basis when %s", async (_label, targetOverrides, basis) => {
    const fake = counterDb(0, {}, {
      issues: [issueRow({ id: SOURCE_ISSUE_ID }), issueRow({ id: TARGET_ISSUE_ID, ...targetOverrides })],
    });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      ...base,
      now: AFTER,
      enforceGrantAt: ENFORCE_AT,
    })).resolves.toMatchObject({ allowed: true });
    expect(fake.inserted).toEqual([
      expect.objectContaining({
        action: "issue.cross_issue_influence_observed",
        details: expect.objectContaining({ basis }),
      }),
    ]);
  });

  it.each([
    ["the target is an ancestor of the run issue", [{ seed: SOURCE_ISSUE_ID, id: TARGET_ISSUE_ID }], "target_is_ancestor_of_source"],
    ["the target is a descendant of the run issue", [{ seed: TARGET_ISSUE_ID, id: SOURCE_ISSUE_ID }], "target_is_descendant_of_source"],
  ] as const)("allows a write when %s", async (_label, ancestors, basis) => {
    const fake = counterDb(0, {}, { ...unrelated, ancestors: [...ancestors] });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      ...base,
      now: AFTER,
      enforceGrantAt: ENFORCE_AT,
    })).resolves.toMatchObject({ allowed: true });
    expect((fake.inserted[0]!.details as { basis: string }).basis).toBe(basis);
  });

  it("allows the sibling and same-routine-origin shapes the monitor traffic relies on", async () => {
    const sibling = counterDb(0, {}, {
      issues: [
        issueRow({ id: SOURCE_ISSUE_ID, parentId: "parent-1" }),
        issueRow({ id: TARGET_ISSUE_ID, parentId: "parent-1", assigneeAgentId: OTHER_AGENT_ID }),
      ],
    });
    await expect(observeCrossIssueInfluence(sibling.db as never, { ...base, now: AFTER, enforceGrantAt: ENFORCE_AT }))
      .resolves.toMatchObject({ allowed: true });
    expect((sibling.inserted[0]!.details as { basis: string }).basis).toBe("target_shares_parent_with_source");

    const routine = counterDb(0, {}, {
      issues: [
        issueRow({ id: SOURCE_ISSUE_ID, originKind: "routine_execution", originId: "r-1", originFingerprint: "fp-1" }),
        issueRow({
          id: TARGET_ISSUE_ID,
          assigneeAgentId: OTHER_AGENT_ID,
          originKind: "routine_execution",
          originId: "r-1",
          originFingerprint: "fp-1",
        }),
      ],
    });
    await expect(observeCrossIssueInfluence(routine.db as never, { ...base, now: AFTER, enforceGrantAt: ENFORCE_AT }))
      .resolves.toMatchObject({ allowed: true });
    expect((routine.inserted[0]!.details as { basis: string }).basis).toBe("same_routine_origin");
  });

  it("honours a scoped issues:cross-write grant and refuses an unscoped one", async () => {
    const scoped = counterDb(0, {}, { ...unrelated, grantScope: { projectId: "project-a" } });
    await expect(observeCrossIssueInfluence(scoped.db as never, { ...base, now: AFTER, enforceGrantAt: ENFORCE_AT }))
      .resolves.toMatchObject({ allowed: true });
    expect((scoped.inserted[0]!.details as { basis: string }).basis).toBe("explicit_permission_grant");

    // An empty scope would be exactly the company-wide permit this issue
    // removes, so it must confer nothing.
    const unscoped = counterDb(0, {}, { ...unrelated, grantScope: {} });
    await expect(observeCrossIssueInfluence(unscoped.db as never, { ...base, now: AFTER, enforceGrantAt: ENFORCE_AT }))
      .rejects.toMatchObject({ details: { code: "cross_issue_write_grant_required" } });

    // A grant scoped to a different project must not cover this target either.
    const wrongProject = counterDb(0, {}, { ...unrelated, grantScope: { projectId: "project-b" } });
    await expect(observeCrossIssueInfluence(wrongProject.db as never, { ...base, now: AFTER, enforceGrantAt: ENFORCE_AT }))
      .rejects.toMatchObject({ details: { code: "cross_issue_write_grant_required" } });
  });

  it("stays in observe mode when the cutover env var is unset or unparseable", () => {
    expect(crossIssueWriteGrantEnforceAt({} as NodeJS.ProcessEnv)).toBeNull();
    expect(crossIssueWriteGrantEnforceAt(
      { CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT: "not-a-date" } as NodeJS.ProcessEnv,
    )).toBeNull();
    expect(crossIssueWriteGrantEnforceAt(
      { CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT: "2026-09-01T00:00:00.000Z" } as NodeJS.ProcessEnv,
    )?.toISOString()).toBe("2026-09-01T00:00:00.000Z");

    // Unset means observe forever: an unresolved basis is still allowed.
    expect(evaluateCrossIssueWriteGrant({ authority: { basis: null }, enforceAt: null }))
      .toMatchObject({ allowed: true, mode: "observe", basis: null, enforceAt: null });
    // Armed but not yet reached is still observe.
    expect(evaluateCrossIssueWriteGrant({
      authority: { basis: null },
      enforceAt: ENFORCE_AT,
      now: new Date(ENFORCE_AT.getTime() - 1),
    })).toMatchObject({ allowed: true, mode: "observe" });
  });

  it("tells a refused agent the boundary, who can act, and the way forward", () => {
    const error = crossIssueWriteGrantError({ issueIdentifier: "TASK-482" });
    expect(error.status).toBe(403);
    expect(error.details).toMatchObject({ code: "cross_issue_write_grant_required" });
    expect(error.message).toContain("TASK-482");
    expect(error.message).toContain("Who can act:");
    expect(error.message).toContain("Try this:");
    // Retrying next heartbeat is the cap's remedy, not this one's.
    expect(error.message).toContain("issues:cross-write");
  });
});
