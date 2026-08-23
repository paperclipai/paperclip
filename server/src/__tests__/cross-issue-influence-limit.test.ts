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
  CrossIssueWriteGrantConfigError,
  assertCrossIssueWriteGrantEnforceAtConfig,
  crossIssueWriteGrantEnforceAt,
  evaluateCrossIssueWriteGrant,
  resolveCrossIssueWriteBasis,
} from "../services/cross-issue-write-basis.ts";
import { crossIssueWriteGrantScopeError } from "@paperclipai/shared";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const TARGET_ISSUE_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_AGENT_ID = "66666666-6666-4666-8666-666666666666";
const MID_ISSUE_ID = "77777777-7777-4777-8777-777777777777";

const resolvedRows = (rows: unknown[]) => ({
  then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
});

/**
 * A reader for `resolveCrossIssueWriteBasis` that answers each ancestor walk
 * from a script, so a reparent racing the locks is reproducible. Lock
 * statements and the recursive walk both arrive through `execute`; only the
 * walk carries `RECURSIVE`. The last scripted walk repeats, which is what lets
 * the resolver's fixpoint converge.
 */
function ancestryRaceReader(walks: ReadonlyArray<ReadonlyArray<string>>) {
  const executed: string[] = [];
  const remaining = walks.map((ids) => ids.map((id) => ({ seed: SOURCE_ISSUE_ID, id })));
  const issueRows = [
    issueRow({ id: SOURCE_ISSUE_ID, parentId: MID_ISSUE_ID }),
    issueRow({ id: TARGET_ISSUE_ID, assigneeAgentId: OTHER_AGENT_ID }),
  ];
  const db = {
    select: (selection: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          const keys = Object.keys(selection);
          if (keys.includes("originFingerprint")) return resolvedRows(issueRows);
          // No `issues:cross-write` grant, so the tree bases decide alone.
          return resolvedRows([]);
        },
      }),
    }),
    execute: async (query: unknown) => {
      if (!JSON.stringify(query).includes("RECURSIVE")) {
        executed.push("lock");
        return [];
      }
      executed.push("walk");
      return remaining.length > 1 ? remaining.shift()! : remaining[0] ?? [];
    },
  };
  return { db, executed };
}

function issueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_ISSUE_ID,
    parentId: null,
    projectId: null,
    // Unassigned by default. That used to be a basis of its own; it is not one
    // any more (FAI-10134 finding 2), so a default row is a *deny* under
    // enforcement unless the test gives it a real relationship.
    assigneeAgentId: null,
    assigneeUserId: null,
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
  // Default fixture: the actor already owns the target, so the counter-focused
  // tests below exercise the cap with an uncontested basis and no shadow row.
  // Basis-focused tests pass `issues` explicitly.
  const issueRows = basisOverrides.issues ?? [
    issueRow({ id: SOURCE_ISSUE_ID }),
    issueRow({ id: TARGET_ISSUE_ID, assigneeAgentId: AGENT_ID }),
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
    // The denial row is written after the locked run row is out of scope, so it
    // has to carry the run's responsible user forward itself. A security denial
    // that loses delegated attribution is worse than no row at all.
    expect(fake.inserted[0]!.responsibleUserId).toBe("user-1");
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

  // FAI-10134 blocking finding 2: "the target happens to be unassigned" is no
  // longer a basis, and it was never checked against `assigneeUserId`, so a
  // board-held ticket was as reachable as an orphan one. Both shapes now deny
  // on every write kind.
  it.each([
    ["comment", "an unassigned", { assigneeAgentId: null, assigneeUserId: null }],
    ["update", "an unassigned", { assigneeAgentId: null, assigneeUserId: null }],
    ["interaction_resolution", "an unassigned", { assigneeAgentId: null, assigneeUserId: null }],
    ["comment", "a human-held", { assigneeAgentId: null, assigneeUserId: "user-9" }],
    ["update", "a human-held", { assigneeAgentId: null, assigneeUserId: "user-9" }],
    ["interaction_resolution", "a human-held", { assigneeAgentId: null, assigneeUserId: "user-9" }],
  ] as const)("refuses a %s write to %s unrelated target", async (kind, _shape, targetOverrides) => {
    const fake = counterDb(0, {}, {
      issues: [issueRow({ id: SOURCE_ISSUE_ID }), issueRow({ id: TARGET_ISSUE_ID, ...targetOverrides })],
    });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      ...base,
      kind,
      now: AFTER,
      enforceGrantAt: ENFORCE_AT,
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_write_grant_required" },
    });
    expect(fake.observedCount).toBe(0);
  });

  it("keeps the human-held assignee in the shadow audit so the cutover dataset can see it", async () => {
    const fake = counterDb(0, {}, {
      issues: [
        issueRow({ id: SOURCE_ISSUE_ID }),
        issueRow({ id: TARGET_ISSUE_ID, assigneeUserId: "user-9" }),
      ],
    });

    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, now: AFTER, enforceGrantAt: null }))
      .resolves.toMatchObject({ allowed: true });
    expect(fake.inserted[0]).toMatchObject({
      action: "issue.cross_issue_write_grant_would_deny",
      details: expect.objectContaining({ targetAssigneeUserId: "user-9" }),
    });
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

  // The other half of finding 2: a correlation is enough to say something on a
  // related ticket and not enough to change its state or resolve its
  // interactions.
  it.each([
    ["update"],
    ["interaction_resolution"],
  ] as const)("refuses a %s on a comment-only basis and says which one it was", async (kind) => {
    const fake = counterDb(0, {}, {
      issues: [
        issueRow({ id: SOURCE_ISSUE_ID, parentId: "parent-1" }),
        issueRow({ id: TARGET_ISSUE_ID, parentId: "parent-1", assigneeAgentId: OTHER_AGENT_ID }),
      ],
    });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      ...base,
      kind,
      now: AFTER,
      enforceGrantAt: ENFORCE_AT,
    })).rejects.toMatchObject({ details: { code: "cross_issue_write_grant_required" } });
    expect(fake.inserted[0]).toMatchObject({
      action: "issue.cross_issue_write_grant_denied",
      details: expect.objectContaining({ basis: null }),
    });
    expect(fake.observedCount).toBe(0);
  });

  // Finding 1 again, on the one input the first fix locked in the wrong order:
  // the ancestor walk read unlocked rows and the lock was taken on what that
  // walk returned, so a reparent committing in between was never seen.
  it.each([
    [
      "denies the tree basis when a reparent lands between the walk and the lock",
      [MID_ISSUE_ID, TARGET_ISSUE_ID],
      [MID_ISSUE_ID],
      null,
    ],
    [
      "keeps the tree basis when the chain is unchanged under the lock",
      [MID_ISSUE_ID, TARGET_ISSUE_ID],
      [MID_ISSUE_ID, TARGET_ISSUE_ID],
      "target_is_ancestor_of_source",
    ],
  ] as const)("%s", async (_name, firstWalk, secondWalk, expected) => {
    const reader = ancestryRaceReader([firstWalk, secondWalk]);

    const authority = await resolveCrossIssueWriteBasis(
      reader.db as never,
      {
        companyId: COMPANY_ID,
        actorAgentId: AGENT_ID,
        sourceIssueId: SOURCE_ISSUE_ID,
        targetIssueId: TARGET_ISSUE_ID,
        operation: "comment",
      },
      { lockAuthorityInputs: true },
    );

    expect(authority.basis).toBe(expected);
    // Proof it is the *post-lock* walk that decided: the resolver walked more
    // than once, and locked the chain before the walk it trusted.
    expect(reader.executed.filter((step) => step === "walk").length).toBeGreaterThan(1);
    expect(reader.executed.indexOf("lock")).toBeLessThan(reader.executed.lastIndexOf("walk"));
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

  // FAI-10134 blocking finding 3: `requireStructuredScope` rejected only
  // null/empty, so any *non-empty* scope the evaluator did not understand fell
  // through the constraint checks and returned an unconstrained allow — the
  // company-wide permit, wearing a scope.
  it.each([
    ["null", null],
    ["empty", {}],
    ["unknown-key-only", { note: "scoped to the sweep" }],
    ["no-op allow rule", { allow: true, description: "cross-team routing" }],
    ["misspelled project key", { projectID: "project-a" }],
    ["empty-string project", { projectId: "" }],
    ["empty project list", { projectIds: [] }],
    ["wildcard agent prefix", { "agent:*": true }],
  ] as const)("refuses an issues:cross-write grant whose scope is %s", async (_label, grantScope) => {
    const fake = counterDb(0, {}, { ...unrelated, grantScope });

    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, now: AFTER, enforceGrantAt: ENFORCE_AT }))
      .rejects.toMatchObject({ details: { code: "cross_issue_write_grant_required" } });
    expect(fake.observedCount).toBe(0);
  });

  it("refuses the same malformed scopes at grant-write time", () => {
    for (const scope of [null, {}, { note: "scoped" }, { allow: true }, { projectId: "" }, { projectIds: [] }]) {
      expect(crossIssueWriteGrantScopeError("issues:cross-write", scope)).toBeTruthy();
    }
    expect(crossIssueWriteGrantScopeError("issues:cross-write", { projectId: "project-a" })).toBeNull();
    expect(crossIssueWriteGrantScopeError("issues:cross-write", { "agent:66666666": true })).toBeNull();
    // Every other permission key keeps its existing, looser scope contract.
    expect(crossIssueWriteGrantScopeError("tasks:assign", null)).toBeNull();
  });

  it("observes when the cutover env var is unset and refuses to start when it is invalid", () => {
    expect(crossIssueWriteGrantEnforceAt({} as NodeJS.ProcessEnv)).toBeNull();
    // An *invalid* value means an operator meant to arm enforcement and typed it
    // wrong. Reading that as observe is a silent fail-open (finding 4).
    expect(() => crossIssueWriteGrantEnforceAt(
      { CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT: "not-a-date" } as NodeJS.ProcessEnv,
    )).toThrow(CrossIssueWriteGrantConfigError);
    expect(() => assertCrossIssueWriteGrantEnforceAtConfig(
      { CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT: "2026-13-45" } as NodeJS.ProcessEnv,
    )).toThrow(/ISO-8601/);
    // Absent and blank stay observe; only a present-but-unparseable value throws.
    expect(() => assertCrossIssueWriteGrantEnforceAtConfig({} as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertCrossIssueWriteGrantEnforceAtConfig(
      { CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT: "   " } as NodeJS.ProcessEnv,
    )).not.toThrow();
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
