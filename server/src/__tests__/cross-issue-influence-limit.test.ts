import { describe, expect, it } from "vitest";
import { activityLog, issues } from "@paperclipai/db";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  CROSS_ISSUE_INFLUENCE_LIMIT,
  crossIssueInfluenceLimitError,
  crossIssueInfluenceRunContextError,
  evaluateCrossIssueInfluenceLimit,
  observeCrossIssueInfluence,
  runIdHeaderWasSent,
} from "../services/cross-issue-influence-limit.ts";

function counterDb(
  initialCount = 0,
  runOverrides: Record<string, unknown> | null = {},
  targetIssue: { assigneeAgentId: string | null; checkoutRunId: string | null } | null = null,
  // How many issues this run holds a checkout on. Only a *sole* checkout is uncharged,
  // so the default is the single-subject case.
  heldCheckouts = 1,
) {
  let observedCount = initialCount;
  const inserted: Array<Record<string, unknown>> = [];
  const tx = {
    select: (selection: Record<string, unknown>) => ({
      // Two different selects now count rows — the influence counter over
      // `activity_log` and the held-checkout tally over `issues` — so the fake has to
      // dispatch on the table, not just on the selected keys. Keying on `count` alone
      // served the checkout tally the influence count and hid the cap entirely.
      from: (table: unknown) => ({
        where: () => {
          if (Object.keys(selection).includes("count")) {
            const rows = table === issues
              ? [{ count: heldCheckouts }]
              : [{ count: observedCount }];
            if (table !== issues && table !== activityLog) {
              throw new Error("unexpected count() select in fake db");
            }
            return { then: (resolve: (rows: unknown[]) => unknown) => resolve(rows) };
          }
          // The target-issue ownership lookup is the only select that reads the
          // issues table, and unlike the run row it is not locked `for update`.
          if (Object.keys(selection).includes("assigneeAgentId")) {
            return {
              then: (resolve: (rows: unknown[]) => unknown) =>
                resolve(targetIssue === null ? [] : [targetIssue]),
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

  // An unscoped (`on_demand`) run carries no `contextSnapshot.issueId`. It used to be
  // refused on every target, including issues it owns, which denied it strictly less
  // than the cap already grants a scoped run — #13078. These four cases pin the
  // narrowed rule: ownership the server can prove is admitted, everything else still
  // fails closed.
  const unscopedRun = { contextSnapshot: {} };
  const unscopedBase = {
    companyId: "22222222-2222-4222-8222-222222222222",
    runId: "11111111-1111-4111-8111-111111111111",
    agentId: "33333333-3333-4333-8333-333333333333",
    targetIssueId: "55555555-5555-4555-8555-555555555555",
  } as const;

  it("lets an unscoped run write to an issue assigned to itself, and charges it", async () => {
    const fake = counterDb(0, unscopedRun, {
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      checkoutRunId: null,
    });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      ...unscopedBase,
      kind: "update",
      now: new Date(CROSS_ISSUE_INFLUENCE_ENFORCE_AT.getTime() - 1),
    })).resolves.toMatchObject({ count: 1, allowed: true });
    // Assignment proves permission, not scope. The write is admitted — the whole point
    // of #13078 — but it is accounted for, so one run cannot fan out across every
    // issue its agent holds without ever reaching the cap.
    expect(fake.inserted).toEqual([
      expect.objectContaining({
        action: "issue.cross_issue_influence_observed",
        details: expect.objectContaining({ sourceIssueId: null, unscopedOwnership: "assignment" }),
      }),
    ]);
  });

  it("refuses an unscoped run's assignment-only write once the cap is spent", async () => {
    const fake = counterDb(CROSS_ISSUE_INFLUENCE_LIMIT, unscopedRun, {
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      checkoutRunId: null,
    });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      ...unscopedBase,
      kind: "comment",
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

  it("lets an unscoped run write to its sole checkout uncharged", async () => {
    // Assigned to somebody else, but this run claimed it through `POST /checkout`,
    // so the server already persisted that this run owns it. One checkout, so it is
    // unambiguously this run's subject issue.
    const fake = counterDb(0, unscopedRun, {
      assigneeAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      checkoutRunId: "11111111-1111-4111-8111-111111111111",
    }, 1);

    await expect(observeCrossIssueInfluence(fake.db as never, {
      ...unscopedBase,
      kind: "comment",
    })).resolves.toBeNull();
    expect(fake.inserted).toEqual([]);
  });

  it("charges a checkout write once the run holds more than one checkout", async () => {
    // `POST /issues/:id/checkout` writes one row at a time and never releases the run's
    // other checkouts, so a run can hold several. Treating each as "the subject issue"
    // would restore the uncounted fan-out that charging assignment closed: the run would
    // simply check out 21 issues instead of relying on being assigned to them.
    const fake = counterDb(0, unscopedRun, {
      assigneeAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      checkoutRunId: "11111111-1111-4111-8111-111111111111",
    }, 2);

    await expect(observeCrossIssueInfluence(fake.db as never, {
      ...unscopedBase,
      kind: "comment",
      now: new Date(CROSS_ISSUE_INFLUENCE_ENFORCE_AT.getTime() - 1),
    })).resolves.toMatchObject({ count: 1, allowed: true });
    expect(fake.inserted).toEqual([
      expect.objectContaining({
        action: "issue.cross_issue_influence_observed",
        details: expect.objectContaining({ unscopedOwnership: "shared_checkout" }),
      }),
    ]);
  });

  it("refuses a multi-checkout run's write once the cap is spent", async () => {
    const fake = counterDb(CROSS_ISSUE_INFLUENCE_LIMIT, unscopedRun, {
      assigneeAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      checkoutRunId: "11111111-1111-4111-8111-111111111111",
    }, 21);

    await expect(observeCrossIssueInfluence(fake.db as never, {
      ...unscopedBase,
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({
      allowed: false,
      count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
    });
    expect(fake.inserted).toEqual([
      expect.objectContaining({ action: "issue.cross_issue_influence_cap_rejected" }),
    ]);
  });

  it.each([
    ["another agent's issue", {
      assigneeAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      checkoutRunId: "99999999-9999-4999-8999-999999999999",
    }],
    ["an unassigned issue", { assigneeAgentId: null, checkoutRunId: null }],
    ["a target that does not exist", null],
  ] as const)(
    "still fails closed when an unscoped run reaches %s",
    async (_label, targetIssue) => {
      const fake = counterDb(0, unscopedRun, targetIssue);

      await expect(observeCrossIssueInfluence(fake.db as never, {
        ...unscopedBase,
        kind: "update",
      })).rejects.toMatchObject({
        status: 403,
        details: { code: "cross_issue_influence_run_context_required" },
      });
      expect(fake.inserted).toEqual([]);
    },
  );

  it("does not consult issue ownership at all once the run has a source issue", async () => {
    // A scoped run's cross-issue writes stay charged even when the target happens to
    // be assigned to it, so the rate backstop keeps its meaning. If the ownership
    // lookup leaked onto this path, the write would come back uncharged (null).
    const fake = counterDb(0, {}, {
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      checkoutRunId: "11111111-1111-4111-8111-111111111111",
    });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      ...unscopedBase,
      kind: "comment",
      now: new Date(CROSS_ISSUE_INFLUENCE_ENFORCE_AT.getTime() - 1),
    })).resolves.toMatchObject({ count: 1, allowed: true });
    expect(fake.inserted).toHaveLength(1);
  });
});

describe("run-context denial distinguishes an absent header from an unresolved one", () => {
  function fakeRequest(headers: Record<string, string>) {
    return { header: (name: string) => headers[name.toLowerCase()] };
  }

  function pathOf(error: ReturnType<typeof crossIssueInfluenceRunContextError>) {
    return (error.details as { sanctionedPath: string }).sanctionedPath;
  }

  it("reads presence of the run header, never its value", () => {
    expect(runIdHeaderWasSent(fakeRequest({}))).toBe(false);
    expect(runIdHeaderWasSent(fakeRequest({
      "x-paperclip-run-id": "11111111-1111-4111-8111-111111111111",
    }))).toBe(true);
    // A header forwarded but blanked in transit still arrived; that is not "never sent".
    expect(runIdHeaderWasSent(fakeRequest({ "x-paperclip-run-id": "" }))).toBe(true);
  });

  it("looks the header up under the name Express normalizes to", () => {
    const looked: string[] = [];
    runIdHeaderWasSent({
      header: (name: string) => {
        looked.push(name);
        return undefined;
      },
    });
    expect(looked).toEqual(["x-paperclip-run-id"]);
  });

  it("tells a caller that sent nothing to send the header", () => {
    const error = crossIssueInfluenceRunContextError({ runHeaderPresent: false });

    expect(error.status).toBe(403);
    expect((error.details as { code: string }).code)
      .toBe("cross_issue_influence_run_context_required");
    expect(pathOf(error)).toContain("Send the `X-Paperclip-Run-Id` header");
  });

  it("never tells a caller whose header arrived to resend it", () => {
    // Holds on both "header arrived" branches: the server saw the header, so re-sending
    // it is the one thing that provably cannot help. Which advice replaces it differs —
    // ownership when a run resolved, the run id itself when none did — and the two
    // tests below pin that split.
    for (const options of [
      { runHeaderPresent: true },
      { runHeaderPresent: true, runResolved: true },
      { runHeaderPresent: true, runResolved: false },
    ]) {
      const error = crossIssueInfluenceRunContextError(options);

      expect(error.status).toBe(403);
      expect((error.details as { code: string }).code)
        .toBe("cross_issue_influence_run_context_required");
      expect(pathOf(error)).not.toContain("Send the `X-Paperclip-Run-Id` header");
      expect(pathOf(error)).toContain("cannot help");
    }
  });

  it("hedges when the request is not in hand, so no branch is asserted wrongly", () => {
    expect(pathOf(crossIssueInfluenceRunContextError()))
      .toBe(pathOf(crossIssueInfluenceRunContextError({ runHeaderPresent: undefined })));
    // The hedge names both, unlike either decided branch.
    expect(pathOf(crossIssueInfluenceRunContextError()))
      .toContain("If the request had no run id");
  });

  it("does not blame ownership when the run id resolved to no run", () => {
    // Review finding: `runHeaderPresent: true` was also serving malformed and stale run
    // ids. In those cases the server never established a run, so it never reached the
    // ownership check — asserting the target "is not one this run owns" sends the caller
    // to audit a permission that was never consulted.
    const error = crossIssueInfluenceRunContextError({
      runHeaderPresent: true,
      runResolved: false,
    });

    expect(error.status).toBe(403);
    expect((error.details as { code: string }).code)
      .toBe("cross_issue_influence_run_context_required");
    // Points at the run id, which is the thing that actually failed...
    expect(pathOf(error)).toContain("resolved to no run of yours");
    expect(pathOf(error)).toContain("sandbox-bridge header allowlist");
    // ...and never at ownership, which it cannot speak to.
    expect(pathOf(error)).not.toContain("assigned to you or checked out by this run");
    expect(error.message).not.toContain("is not one this run owns");
  });

  it("blames ownership only once a run actually resolved", () => {
    const resolved = crossIssueInfluenceRunContextError({
      runHeaderPresent: true,
      runResolved: true,
    });

    expect(pathOf(resolved)).toContain("assigned to you or checked out by this run");
    expect(pathOf(resolved)).not.toContain("resolved to no run of yours");
    // The two "header arrived" failures must not read the same, or the split bought
    // nothing and a caller still cannot tell which one it is in.
    expect(pathOf(resolved)).not.toBe(pathOf(crossIssueInfluenceRunContextError({
      runHeaderPresent: true,
      runResolved: false,
    })));
  });

  it("keeps the code and boundary identical across every branch", () => {
    // Callers and tests match on `code`; only the human-facing copy may differ.
    const branches = [
      {},
      { runHeaderPresent: false },
      { runHeaderPresent: true },
      { runHeaderPresent: true, runResolved: true },
      { runHeaderPresent: true, runResolved: false },
    ].map((options) =>
      crossIssueInfluenceRunContextError(options).details as {
        code: string;
        boundary: string;
        sanctionedPath: string;
      },
    );
    for (const branch of branches) {
      expect(branch.code).toBe("cross_issue_influence_run_context_required");
      expect(branch.boundary).toBe(branches[0].boundary);
    }
    // Four distinct paths: hedge, header-missing, run-unresolved, and ownership — with
    // bare `runHeaderPresent: true` reading as the ownership case it always meant.
    expect(new Set(branches.map((branch) => branch.sanctionedPath)).size).toBe(4);
  });

  it("reports a run id that failed to resolve as arrived, since the caller supplied one", async () => {
    // Every path into `observeCrossIssueInfluence` already proved `req.actor.runId`
    // truthy, so a refusal inside it is never "you did not send the header".
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
        sanctionedPath: expect.stringContaining("sandbox-bridge header allowlist"),
      },
    });
  });

  it("reports an unscoped run that does not own the target as arrived too", async () => {
    const fake = counterDb(0, { contextSnapshot: {} }, {
      assigneeAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      checkoutRunId: null,
    });

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
        // #13078's ownership guidance must survive the new branch.
        sanctionedPath: expect.stringContaining("assigned to you or checked out by this run"),
      },
    });
  });
});
