import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";

const mockCreateChild = vi.fn();

vi.mock("./issues.js", () => ({
  issueService: () => ({
    createChild: mockCreateChild,
  }),
}));

type SelectRow = Record<string, unknown>;

function createSelectChain(rows: SelectRow[]) {
  return {
    from() {
      return {
        where() {
          return {
            then(callback: (rows: SelectRow[]) => unknown) {
              return Promise.resolve(callback(rows));
            },
          };
        },
      };
    },
  };
}

function createFakeDb(args: {
  interactionRow: Record<string, unknown>;
  parentRows?: SelectRow[];
}) {
  let interactionRow = { ...args.interactionRow };
  const issueTouches: Array<Record<string, unknown>> = [];
  const interactionUpdates: Array<Record<string, unknown>> = [];
  const toolActionRequestUpdates: Array<Record<string, unknown>> = [];
  let selectCallCount = 0;

  const db: any = {
    select: vi.fn(() => {
      selectCallCount += 1;
      return createSelectChain(selectCallCount === 1 ? [interactionRow] : (args.parentRows ?? []));
    }),
    update: vi.fn((table: unknown) => ({
      set(values: Record<string, unknown>) {
        return {
          where() {
            if (getTableName(table as never) === "tool_action_requests") {
              toolActionRequestUpdates.push(values);
              return Promise.resolve(undefined);
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
      select: vi.fn(() => createSelectChain([existingRow])),
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

    expect(result.status).toBe("answered");
    expect(result.result).toEqual({
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
});
