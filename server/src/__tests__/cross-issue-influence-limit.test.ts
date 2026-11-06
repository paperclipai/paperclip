import { describe, expect, it } from "vitest";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  CROSS_ISSUE_INFLUENCE_LIMIT,
  CROSS_ISSUE_INFLUENCE_SERVICE_KEY_LIMIT,
  CROSS_ISSUE_INFLUENCE_SERVICE_KEY_WINDOW_MS,
  crossIssueInfluenceLimitError,
  evaluateCrossIssueInfluenceLimit,
  observeCrossIssueInfluence,
  observeServiceKeyCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.ts";

function counterDb(
  initialCount = 0,
  runOverrides: Record<string, unknown> | null = {},
  // Oldest in-window observation the service-key count query sees alongside it,
  // which is what the retry hint is derived from.
  oldestObserved: Date | string | null = null,
) {
  let observedCount = initialCount;
  const inserted: Array<Record<string, unknown>> = [];
  const tx = {
    // The service-key path opens with a transaction-scoped advisory lock.
    execute: async () => undefined,
    select: (selection: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          if (Object.keys(selection).includes("count")) {
            return {
              then: (resolve: (rows: unknown[]) => unknown) =>
                resolve([{ count: observedCount, oldest: oldestObserved }]),
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

  it("counts writes from an unscoped run instead of rejecting them", async () => {
    // A timer heartbeat with no checked-out issue has no source issue: every
    // write it makes is cross-issue by definition. The persisted run row is
    // still the attribution anchor, so the write spends the cap rather than
    // failing as run-less.
    const fake = counterDb(0, { contextSnapshot: {} });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "update",
    })).resolves.toMatchObject({ count: 1, allowed: true });
    expect(fake.inserted).toEqual([
      expect.objectContaining({
        action: "issue.cross_issue_influence_observed",
        details: expect.objectContaining({ sourceIssueId: null }),
      }),
    ]);
  });

  it("still caps an unscoped run once its budget is spent", async () => {
    const fake = counterDb(CROSS_ISSUE_INFLUENCE_LIMIT, { contextSnapshot: {} });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
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
});

describe("cross-issue influence limit for run-less service keys", () => {
  const serviceInput = {
    companyId: "22222222-2222-4222-8222-222222222222",
    agentId: "33333333-3333-4333-8333-333333333333",
    serviceKeyId: "66666666-6666-4666-8666-666666666666",
    targetIssueId: "55555555-5555-4555-8555-555555555555",
    targetIssueIdentifier: "STA-8192",
    kind: "comment" as const,
    now: new Date("2026-09-30T08:00:00.000Z"),
  };

  it("allows the last comment inside the window and fails closed on the next", async () => {
    const fake = counterDb(CROSS_ISSUE_INFLUENCE_SERVICE_KEY_LIMIT - 1);

    await expect(
      observeServiceKeyCrossIssueInfluence(fake.db as never, serviceInput),
    ).resolves.toMatchObject({
      allowed: true,
      mode: "enforce",
      count: CROSS_ISSUE_INFLUENCE_SERVICE_KEY_LIMIT,
      cap: CROSS_ISSUE_INFLUENCE_SERVICE_KEY_LIMIT,
    });
    await expect(
      observeServiceKeyCrossIssueInfluence(fake.db as never, serviceInput),
    ).resolves.toMatchObject({
      allowed: false,
      count: CROSS_ISSUE_INFLUENCE_SERVICE_KEY_LIMIT + 1,
      cap: CROSS_ISSUE_INFLUENCE_SERVICE_KEY_LIMIT,
    });
    expect(fake.inserted.map((row) => row.action)).toEqual([
      "issue.cross_issue_influence_observed",
      "issue.cross_issue_influence_cap_rejected",
    ]);
  });

  it("records the attempt against the agent with no run and a bounded window", async () => {
    const fake = counterDb(0);

    await observeServiceKeyCrossIssueInfluence(fake.db as never, serviceInput);

    expect(fake.inserted).toEqual([
      expect.objectContaining({
        actorType: "agent",
        agentId: serviceInput.agentId,
        runId: null,
        entityType: "issue",
        entityId: serviceInput.targetIssueId,
        details: expect.objectContaining({
          actorScope: "service_key",
          serviceKeyId: serviceInput.serviceKeyId,
          sourceIssueId: null,
          targetIssueIdentifier: "STA-8192",
          windowMs: CROSS_ISSUE_INFLUENCE_SERVICE_KEY_WINDOW_MS,
          windowStart: "2026-09-30T07:00:00.000Z",
          cap: CROSS_ISSUE_INFLUENCE_SERVICE_KEY_LIMIT,
        }),
      }),
    ]);
  });

  it("tells a capped service key when the window frees up instead of naming a heartbeat", async () => {
    // Per-run copy ("the budget resets per run", "continue on the next
    // heartbeat") is unusable advice for a caller that has no run: every one of
    // its comments spends the same rolling allowance. The denial has to name the
    // window and the moment the oldest counted write ages out of it.
    const oldest = new Date("2026-09-30T07:12:00.000Z");
    const fake = counterDb(CROSS_ISSUE_INFLUENCE_SERVICE_KEY_LIMIT, {}, oldest);

    const rejected = await observeServiceKeyCrossIssueInfluence(
      fake.db as never,
      serviceInput,
    );
    expect(rejected).toMatchObject({
      allowed: false,
      windowMs: CROSS_ISSUE_INFLUENCE_SERVICE_KEY_WINDOW_MS,
      retryAfter: new Date(
        oldest.getTime() + CROSS_ISSUE_INFLUENCE_SERVICE_KEY_WINDOW_MS,
      ).toISOString(),
    });

    const capError = crossIssueInfluenceLimitError(rejected, {
      actorLabel: "Inbox Router",
      issueIdentifier: "STA-8192",
    });
    expect(capError.details).toMatchObject({
      code: "cross_issue_influence_cap_exceeded",
      cap: CROSS_ISSUE_INFLUENCE_SERVICE_KEY_LIMIT,
      windowMs: CROSS_ISSUE_INFLUENCE_SERVICE_KEY_WINDOW_MS,
      retryAfter: "2026-09-30T08:12:00.000Z",
    });
    expect(capError.details.sanctionedPath).toContain("2026-09-30T08:12:00.000Z");
    expect(capError.details.boundary).toContain("per hour");
    // The advice a run-less caller cannot act on must be gone, not merely joined.
    expect(capError.error).not.toContain("next heartbeat");
    expect(capError.error).not.toContain("resets per run");
    expect(capError.error).toContain("rolling window");

    // A run-budgeted decision still gets the per-run copy — no windowMs, no
    // retry hint, and the heartbeat path intact.
    const runRejected = evaluateCrossIssueInfluenceLimit({
      priorCount: CROSS_ISSUE_INFLUENCE_LIMIT,
      now: serviceInput.now,
    });
    const runError = crossIssueInfluenceLimitError(runRejected);
    expect(runError.error).toContain("next heartbeat");
    expect(runError.details).not.toHaveProperty("windowMs");
    expect(runError.details).not.toHaveProperty("retryAfter");
  });

  it("drops the retry hint rather than guessing when the window has no counted writes", async () => {
    // An empty window (or a driver value that will not parse) must not produce
    // "Invalid Date" in operator-facing copy.
    const fake = counterDb(CROSS_ISSUE_INFLUENCE_SERVICE_KEY_LIMIT, {}, "not-a-date");

    const rejected = await observeServiceKeyCrossIssueInfluence(
      fake.db as never,
      serviceInput,
    );
    expect(rejected.retryAfter).toBeNull();
    const capError = crossIssueInfluenceLimitError(rejected);
    expect(capError.error).not.toContain("Invalid Date");
    expect(capError.details.sanctionedPath).toContain("hour");
  });

  it("charges every attempt because a service key has no source issue", async () => {
    const fake = counterDb(0);

    // The run path returns null (uncharged) for a write to the run's own issue.
    // A run-less key has no own issue, so nothing is free.
    await expect(
      observeServiceKeyCrossIssueInfluence(fake.db as never, serviceInput),
    ).resolves.toMatchObject({ count: 1 });
    await expect(
      observeServiceKeyCrossIssueInfluence(fake.db as never, serviceInput),
    ).resolves.toMatchObject({ count: 2 });
  });
});
