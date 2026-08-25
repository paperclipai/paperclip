import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";

const mockCreateChild = vi.fn();

vi.mock("./issues.js", () => ({
  issueService: () => ({
    createChild: mockCreateChild,
  }),
}));

type SelectRow = Record<string, unknown>;

/** Collect the bound string parameters of a drizzle WHERE predicate. */
function guardStringParams(predicate: unknown): string[] {
  const seen: string[] = [];
  const visited = new Set<unknown>();
  const walk = (node: any) => {
    if (!node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node.value === "string") seen.push(node.value);
    for (const key of Object.keys(node)) walk(node[key]);
  };
  walk(predicate);
  return seen;
}

/**
 * Routes reads by table rather than by call order: the resolution paths take
 * several locked re-reads of both `issues` and `issue_thread_interactions`, and
 * a positional fake silently hands one table's row to the other's caller.
 */
function createSelectChain(rowsFor: (table: unknown) => SelectRow[]) {
  return {
    from(table: unknown) {
      return {
        where() {
          const rows = rowsFor(table);
          // Row locks, ordering and limits are no-ops against the fake; callers
          // that use them still have to be able to chain, so each hands the same
          // thenable back.
          const thenable = {
            for() {
              return thenable;
            },
            orderBy() {
              return thenable;
            },
            limit() {
              return thenable;
            },
            then(callback: (rows: SelectRow[]) => unknown) {
              return Promise.resolve(callback(rows));
            },
          };
          return thenable;
        },
      };
    },
  };
}

function createFakeDb(args: {
  interactionRow: Record<string, unknown>;
  parentRows?: SelectRow[];
  issueRow?: SelectRow | null;
  // Rows the compare-and-swap handoff update reports as matched. An empty array
  // is the lost race: another request changed the issue between the eligibility
  // probe and the write, so the guarded WHERE matches nothing.
  handoffUpdateRows?: SelectRow[];
}) {
  let interactionRow = { ...args.interactionRow };
  const issueTouches: Array<Record<string, unknown>> = [];
  const interactionUpdates: Array<Record<string, unknown>> = [];
  const toolActionRequestUpdates: Array<Record<string, unknown>> = [];
  const handoffUpdates: Array<Record<string, unknown>> = [];
  const handoffGuards: unknown[] = [];
  // Defaults to an agent-owned issue so the creator-agent handoff stays out of the
  // way unless a test opts into a user-assigned one.
  const issueRow = args.issueRow === undefined
    ? {
        id: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        status: "in_progress",
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
      }
    : args.issueRow;

  const db: any = {
    select: vi.fn(() => createSelectChain((table) => {
      switch (getTableName(table as never)) {
        case "issues":
          return issueRow ? [issueRow] : [];
        case "issue_thread_interactions":
          return [interactionRow];
        default:
          return args.parentRows ?? [];
      }
    })),
    update: vi.fn((table: unknown) => ({
      set(values: Record<string, unknown>) {
        return {
          where(guard?: unknown) {
            if (getTableName(table as never) === "tool_action_requests") {
              toolActionRequestUpdates.push(values);
              return Promise.resolve(undefined);
            }
            // Checked before the interaction branch: the handoff write also carries
            // `status`, so ordering by the assignee columns is what tells them apart.
            if ("assigneeAgentId" in values) {
              handoffUpdates.push(values);
              handoffGuards.push(guard);
              return {
                returning: async () => args.handoffUpdateRows ?? [{
                  id: issueRow?.id,
                  status: values.status,
                  assigneeAgentId: values.assigneeAgentId,
                  assigneeUserId: values.assigneeUserId,
                }],
              };
            }
            if ("status" in values || "result" in values || "resolvedAt" in values) {
              interactionUpdates.push(values);
              interactionRow = { ...interactionRow, ...values };
              return {
                returning: async () => [interactionRow],
              };
            }
            if ("updatedAt" in values) {
              issueTouches.push(values);
              return Promise.resolve(undefined);
            }
            throw new Error(`Unexpected update target: ${String(table)}`);
          },
        };
      },
    })),
    insert: vi.fn(),
    transaction: async (callback: (tx: typeof db) => Promise<void>) => callback(db),
  };

  return {
    db,
    getInteractionRow: () => interactionRow,
    issueTouches,
    interactionUpdates,
    toolActionRequestUpdates,
    handoffUpdates,
    handoffGuards,
  };
}

describe("issueThreadInteractionService", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it.each([
    ["ask_user_questions", undefined, {}, "anyone", "anyone", "inherited", "requested"],
    ["suggest_tasks", undefined, {}, "anyone", "anyone", "inherited", "requested"],
    ["request_confirmation", "board_or_agents", {}, "anyone", "anyone", "explicit", "requested"],
    ["request_confirmation", "board_only", {}, "human_only", "human_only", "explicit", "requested"],
    ["request_checkbox_confirmation", undefined, { request_checkbox_confirmation: { defaultPolicy: "not_creator" } }, "not_creator", "not_creator", "inherited", "requested"],
    ["request_item_verdicts", "anyone", { request_item_verdicts: { cap: "not_creator" } }, "anyone", "not_creator", "explicit", "company_cap"],
  ] as const)(
    "resolves %s requested/default/cap policy snapshots",
    async (kind, requested, governance, expectedRequested, expectedEffective, expectedProvenance, expectedSource) => {
      const { resolveInteractionPolicy } = await import("./issue-thread-interactions.js");
      expect(resolveInteractionPolicy({
        kind,
        requested,
        governance,
        hasToolAction: false,
      })).toEqual({
        requestedResolverPolicy: expectedRequested,
        effectiveResolverPolicy: expectedEffective,
        resolverPolicyProvenance: expectedProvenance,
        effectiveResolverPolicySource: expectedSource,
      });
    },
  );

  it("always clamps tool-action confirmations to human-only", async () => {
    const { resolveInteractionPolicy } = await import("./issue-thread-interactions.js");
    expect(resolveInteractionPolicy({
      kind: "request_confirmation",
      requested: "board_or_agents",
      governance: { request_confirmation: { defaultPolicy: "board_or_agents", cap: "board_or_agents" } },
      hasToolAction: true,
    })).toEqual({
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "governed_action",
    });
  });

  it("create reuses an existing interaction for the same idempotency key", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    const existingRow = {
      id: "interaction-1",
      companyId: "company-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      kind: "suggest_tasks",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone",
      resolverPolicyProvenance: "inherited",
      effectiveResolverPolicySource: "requested",
      idempotencyKey: "run-1:suggest",
      sourceCommentId: null,
      sourceRunId: "22222222-2222-4222-8222-222222222222",
      title: "Break the work down",
      summary: "Created from the current agent run.",
      createdByAgentId: "agent-1",
      createdByUserId: null,
      resolvedByAgentId: null,
      resolvedByUserId: null,
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
      result: null,
      resolvedAt: null,
      createdAt: new Date("2026-04-20T10:00:00.000Z"),
      updatedAt: new Date("2026-04-20T10:00:00.000Z"),
    };

    const db: any = {
      select: vi.fn(() => createSelectChain(() => [existingRow])),
      insert: vi.fn(),
      update: vi.fn(),
    };

    const svc = issueThreadInteractionService(db as never);
    const created = await svc.create({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, {
      kind: "suggest_tasks",
      idempotencyKey: "run-1:suggest",
      sourceRunId: "22222222-2222-4222-8222-222222222222",
      title: "Break the work down",
      summary: "Created from the current agent run.",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
    }, {
      agentId: "agent-1",
    });

    expect(created.id).toBe("interaction-1");
    expect(created.idempotencyKey).toBe("run-1:suggest");
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("answerQuestions normalizes duplicate option ids and persists answered results", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    const interactionRow = {
      id: "interaction-2",
      companyId: "company-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      sourceCommentId: null,
      sourceRunId: null,
      title: null,
      summary: null,
      createdByAgentId: null,
      createdByUserId: "local-board",
      resolvedByAgentId: null,
      resolvedByUserId: null,
      payload: {
        version: 1,
        questions: [
          {
            id: "scope",
            prompt: "Pick one scope",
            selectionMode: "single",
            required: true,
            options: [
              { id: "phase-1", label: "Phase 1" },
              { id: "phase-2", label: "Phase 2" },
            ],
          },
          {
            id: "extras",
            prompt: "Pick extras",
            selectionMode: "multi",
            options: [
              { id: "tests", label: "Tests" },
              { id: "docs", label: "Docs" },
            ],
          },
        ],
      },
      result: null,
      resolvedAt: null,
      createdAt: new Date("2026-04-20T10:00:00.000Z"),
      updatedAt: new Date("2026-04-20T10:00:00.000Z"),
    };
    const state = createFakeDb({ interactionRow });
    const svc = issueThreadInteractionService(state.db as never);

    const result = await svc.answerQuestions({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, "interaction-2", {
      answers: [
        { questionId: "scope", optionIds: ["phase-1"] },
        { questionId: "extras", optionIds: ["docs", "tests", "docs"] },
      ],
      summaryMarkdown: "Phase 1 with tests and docs.",
    }, {
      userId: "local-board",
    });

    expect(result.continuationIssue).toBeNull();
    expect(result.interaction.status).toBe("answered");
    expect(result.interaction.result).toEqual({
      version: 1,
      answers: [
        { questionId: "scope", optionIds: ["phase-1"] },
        { questionId: "extras", optionIds: ["docs", "tests"] },
      ],
      summaryMarkdown: "Phase 1 with tests and docs.",
    });
    expect(state.interactionUpdates).toHaveLength(1);
    expect(state.issueTouches).toHaveLength(1);
  });

  it("withdraws a pending interaction with attribution and rejects repeats", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const interactionRow = {
      id: "interaction-withdraw", companyId: "company-1", issueId: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee",
      sourceCommentId: null, sourceRunId: null, title: null, summary: null,
      createdByAgentId: "agent-1", createdByUserId: null, resolvedByAgentId: null, resolvedByUserId: null,
      payload: { version: 1, prompt: "Proceed?" }, result: null, resolvedAt: null,
      createdAt: new Date("2026-07-25T10:00:00.000Z"), updatedAt: new Date("2026-07-25T10:00:00.000Z"),
    };
    const state = createFakeDb({ interactionRow });
    const svc = issueThreadInteractionService(state.db as never);
    const withdrawn = await svc.withdrawInteraction({ id: interactionRow.issueId, companyId: "company-1" }, interactionRow.id, { reason: "Replanning" }, { agentId: "agent-1" });
    expect(withdrawn.status).toBe("cancelled");
    expect(withdrawn.result).toEqual({ version: 1, outcome: "withdrawn", reason: "Replanning" });
    expect(withdrawn.resolvedByAgentId).toBe("agent-1");
    expect(state.toolActionRequestUpdates).toHaveLength(1);
    expect(state.toolActionRequestUpdates[0]).toMatchObject({ status: "cancelled", resolvedByAgentId: "agent-1" });
    const resolvedState = createFakeDb({ interactionRow: { ...interactionRow, status: "accepted" } });
    const resolvedSvc = issueThreadInteractionService(resolvedState.db as never);
    await expect(resolvedSvc.withdrawInteraction(
      { id: interactionRow.issueId, companyId: "company-1" },
      interactionRow.id,
      {},
      { agentId: "agent-1" },
    )).rejects.toMatchObject({ status: 409 });
  });

  it("refuses withdrawal when the linked tool action is already executing", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const interactionRow = {
      id: "interaction-executing", companyId: "company-1", issueId: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee",
      sourceCommentId: null, sourceRunId: null, title: null, summary: null,
      createdByAgentId: "agent-1", createdByUserId: null, resolvedByAgentId: null, resolvedByUserId: null,
      payload: { version: 1, prompt: "Proceed?" }, result: null, resolvedAt: null,
      createdAt: new Date("2026-07-25T10:00:00.000Z"), updatedAt: new Date("2026-07-25T10:00:00.000Z"),
    };
    const state = createFakeDb({ interactionRow, parentRows: [{ id: "action-request-1" }] });
    const svc = issueThreadInteractionService(state.db as never);
    await expect(svc.withdrawInteraction(
      { id: interactionRow.issueId, companyId: "company-1" },
      interactionRow.id,
      {},
      { agentId: "agent-1" },
    )).rejects.toMatchObject({ status: 409 });
    expect(state.interactionUpdates).toHaveLength(0);
  });

  it("expires pending interactions when the issue is terminal", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const interactionRow = {
      id: "interaction-close", companyId: "company-1", issueId: "11111111-1111-4111-8111-111111111111",
      kind: "ask_user_questions", status: "pending", continuationPolicy: "wake_assignee",
      sourceCommentId: null, sourceRunId: null, title: null, summary: null,
      createdByAgentId: "agent-1", createdByUserId: null, resolvedByAgentId: null, resolvedByUserId: null,
      payload: { version: 1, questions: [{ id: "q", prompt: "Q?", selectionMode: "single", options: [{ id: "a", label: "A" }] }] },
      result: null, resolvedAt: null, createdAt: new Date("2026-07-25T10:00:00.000Z"), updatedAt: new Date("2026-07-25T10:00:00.000Z"),
    };
    const state = createFakeDb({ interactionRow });
    const svc = issueThreadInteractionService(state.db as never);
    const expired = await svc.expirePendingInteractionsForTerminalIssue({ id: interactionRow.issueId, companyId: "company-1", status: "done" });
    expect(expired).toHaveLength(1);
    expect(expired[0]?.status).toBe("expired");
    expect(expired[0]?.result).toMatchObject({ version: 1, outcome: "issue_closed", answers: [] });
    expect(state.toolActionRequestUpdates).toHaveLength(0);
  });

  it("expires the linked tool action request when a terminal issue closes a confirmation card", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const interactionRow = {
      id: "interaction-tool", companyId: "company-1", issueId: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee",
      sourceCommentId: null, sourceRunId: null, title: null, summary: null,
      createdByAgentId: "agent-1", createdByUserId: null, resolvedByAgentId: null, resolvedByUserId: null,
      payload: {
        version: 1,
        prompt: "Run the parked tool call?",
        toolAction: {
          version: 1,
          actionRequestId: "33333333-3333-4333-8333-333333333333",
          invocationId: "44444444-4444-4444-8444-444444444444",
          toolName: "deploy",
          toolDisplayName: "Deploy",
          connectionId: null,
          applicationId: null,
          appDisplayName: null,
          risk: "write",
          previewMarkdown: "Deploy the current build.",
          argumentsSummaryJson: "{}",
          argumentsHash: "hash-1",
          expiresAt: "2026-07-25T11:00:00.000Z",
        },
      },
      result: null, resolvedAt: null, createdAt: new Date("2026-07-25T10:00:00.000Z"), updatedAt: new Date("2026-07-25T10:00:00.000Z"),
    };
    const state = createFakeDb({ interactionRow });
    const svc = issueThreadInteractionService(state.db as never);
    const expired = await svc.expirePendingInteractionsForTerminalIssue(
      { id: interactionRow.issueId, companyId: "company-1", status: "cancelled" },
      { userId: "local-board" },
    );
    expect(expired).toHaveLength(1);
    expect(expired[0]?.result).toMatchObject({ version: 1, outcome: "issue_closed" });
    expect(state.toolActionRequestUpdates).toHaveLength(1);
    expect(state.toolActionRequestUpdates[0]).toMatchObject({ status: "expired", resolvedByUserId: "local-board" });
  });

  // The eligibility probe is an unlocked read, so the issue can change between it
  // and the handoff write. The write is therefore a compare-and-swap; these cover
  // both outcomes of that race, which the embedded-Postgres suite cannot schedule
  // deterministically.
  describe("creator handoff compare-and-swap", () => {
    const issueId = "11111111-1111-4111-8111-111111111111";

    function handoffInteractionRow() {
      return {
        id: "interaction-3",
        companyId: "company-1",
        issueId,
        kind: "ask_user_questions",
        status: "pending",
        continuationPolicy: "wake_assignee",
        sourceCommentId: null,
        sourceRunId: null,
        title: null,
        summary: null,
        createdByAgentId: "agent-asking",
        createdByUserId: null,
        resolvedByAgentId: null,
        resolvedByUserId: null,
        payload: {
          version: 1,
          questions: [{
            id: "scope",
            prompt: "Pick one scope",
            selectionMode: "single",
            options: [
              { id: "phase-1", label: "Phase 1" },
              { id: "phase-2", label: "Phase 2" },
            ],
          }],
        },
        result: null,
        resolvedAt: null,
        createdAt: new Date("2026-04-20T10:00:00.000Z"),
        updatedAt: new Date("2026-04-20T10:00:00.000Z"),
      };
    }

    // A user-assigned, non-terminal issue: the probe says the handoff qualifies.
    const eligibleIssueRow = {
      id: issueId,
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
    };

    async function answer(state: ReturnType<typeof createFakeDb>) {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
      return issueThreadInteractionService(state.db as never).answerQuestions({
        id: issueId,
        companyId: "company-1",
      }, "interaction-3", {
        answers: [{ questionId: "scope", optionIds: ["phase-1"] }],
      }, {
        userId: "local-board",
      });
    }

    it("hands the issue back when the guarded update still matches", async () => {
      const state = createFakeDb({
        interactionRow: handoffInteractionRow(),
        issueRow: eligibleIssueRow,
      });

      const result = await answer(state);

      expect(result.continuationIssue).toEqual({
        id: issueId,
        assigneeAgentId: "agent-asking",
        assigneeUserId: null,
        status: "todo",
      });
      // The guard re-asserts every mutable precondition rather than updating by id.
      expect(state.handoffUpdates).toHaveLength(1);
      expect(state.handoffUpdates[0]).toMatchObject({
        status: "todo",
        assigneeAgentId: "agent-asking",
        assigneeUserId: null,
      });
      // Handoff won, so no separate touch is needed.
      expect(state.issueTouches).toHaveLength(0);
    });

    it("skips the handoff and falls back to touching the issue when it loses the race", async () => {
      const state = createFakeDb({
        interactionRow: handoffInteractionRow(),
        issueRow: eligibleIssueRow,
        // Someone reassigned the issue or closed it after the probe read it.
        handoffUpdateRows: [],
      });

      const result = await answer(state);

      // The answer still lands — only the handoff is skipped, which is the safe
      // direction: a stale write could have reopened a terminal issue.
      expect(result.interaction.status).toBe("answered");
      expect(result.continuationIssue).toBeNull();
      expect(state.handoffUpdates).toHaveLength(1);
      expect(state.issueTouches).toHaveLength(1);
    });

    it("pins the guard to the exact user assignee it judged, not merely 'some user'", async () => {
      const state = createFakeDb({
        interactionRow: handoffInteractionRow(),
        issueRow: eligibleIssueRow,
      });

      await answer(state);

      // A user-A-to-user-B reassignment leaves "an agent is absent" and "a user is
      // assigned" both true, so a guard that only checked `assigneeUserId IS NOT NULL`
      // would still fire and clear user B — taking the issue from a human who was
      // never asked anything. The guard must carry the judged id itself.
      expect(state.handoffGuards).toHaveLength(1);
      expect(guardStringParams(state.handoffGuards[0])).toContain(eligibleIssueRow.assigneeUserId);
    });

    // `request_confirmation` defaults to `continuationPolicy: "none"`
    // (`packages/mcp-server/src/tools.ts`), and a `none` resolution never queues a
    // continuation wakeup. Handing the issue over anyway takes it off the person
    // holding it and parks it on an agent nobody will wake — the exact dead path
    // this handoff exists to prevent, just moved one step later.
    it("leaves the issue with the user when the policy would never wake anyone", async () => {
      const state = createFakeDb({
        interactionRow: {
          ...handoffInteractionRow(),
          kind: "request_confirmation",
          continuationPolicy: "none",
          payload: { version: 1, prompt: "Ship it?" },
        },
        issueRow: eligibleIssueRow,
      });

      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
      const result = await issueThreadInteractionService(state.db as never).acceptInteraction({
        id: issueId,
        companyId: "company-1",
        projectId: null,
        goalId: null,
      }, "interaction-3", {}, { userId: "local-board" });

      expect(result.continuationIssue).toBeNull();
      expect(state.handoffUpdates).toHaveLength(0);
      expect(state.issueTouches).toHaveLength(1);
    });
  });
});
