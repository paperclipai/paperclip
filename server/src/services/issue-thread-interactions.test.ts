import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";

const mockCreateChild = vi.fn();
const mockUpdateIssue = vi.fn();

vi.mock("./issues.js", () => ({
  issueService: () => ({
    createChild: mockCreateChild,
    update: mockUpdateIssue,
  }),
}));

type SelectRow = Record<string, unknown>;

function createSelectChain(rows: SelectRow[], onLock?: (mode: string) => void) {
  const result: any = {
    for(mode: string) {
      onLock?.(mode);
      return result;
    },
    then(callback: (rows: SelectRow[]) => unknown) {
      return Promise.resolve(callback(rows));
    },
  };
  return {
    from() {
      return {
        where() {
          return result;
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

function createCreateFlowDb(args: {
  currentIssueRow: SelectRow | null;
  existingInteractionRow?: SelectRow | null;
  issueStatus?: string;
  failAssignment?: boolean;
  onInsert?: () => void;
}) {
  const touches: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  const locks: string[] = [];

  const db: any = {
    select: vi.fn((columns?: Record<string, unknown>) => {
      // The assignee probe is the only select that asks for the assignee columns;
      // every other select in the create flow (idempotency / source lookups) gets
      // an empty result, so this stays independent of call ordering.
      const wantsAssignee = Boolean(columns && "assigneeAgentId" in columns);
      // The create path reads status and assignee together under one lock; the
      // idempotent-reuse path reads assignee columns on their own.
      if (columns && "status" in columns) {
        events.push("select:issue");
        return createSelectChain(
          [{
            status: args.issueStatus ?? "in_progress",
            assigneeAgentId: null,
            assigneeUserId: null,
            ...(args.currentIssueRow ?? {}),
          }],
          (mode) => locks.push(mode),
        );
      }
      if (wantsAssignee) {
        events.push("select:assignee");
        return createSelectChain(
          args.currentIssueRow ? [args.currentIssueRow] : [],
          (mode) => locks.push(mode),
        );
      }
      // A column-less select is the idempotency lookup.
      return createSelectChain(args.existingInteractionRow ? [args.existingInteractionRow] : []);
    }),
    insert: vi.fn(() => ({
      values(values: Record<string, unknown>) {
        events.push("insert:interaction");
        args.onInsert?.();
        const row = {
          id: "interaction-new",
          createdAt: new Date("2026-04-20T10:00:00.000Z"),
          updatedAt: new Date("2026-04-20T10:00:00.000Z"),
          resolvedByAgentId: null,
          resolvedByUserId: null,
          resolvedAt: null,
          result: null,
          ...values,
        };
        return {
          returning: async () => [row],
        };
      },
    })),
    update: vi.fn(() => ({
      set(values: Record<string, unknown>) {
        return {
          where() {
            touches.push(values);
            if ("assigneeAgentId" in values) {
              events.push("update:assignee");
              if (args.failAssignment) return Promise.reject(new Error("assignment failed"));
            }
            return Promise.resolve(undefined);
          },
        };
      },
    })),
    transaction: async (callback: (tx: any) => Promise<void>) => {
      events.push("tx:begin");
      try {
        return await callback(db);
      } finally {
        events.push("tx:end");
      }
    },
  };

  return { db, touches, events, locks };
}

// Every test re-imports the service module (`vi.resetModules()` below), so the
// first one to run pays the full module-graph import cost and sits close to the
// 5s default on a cold cache.
describe("issueThreadInteractionService", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockUpdateIssue.mockResolvedValue({ id: "issue-1", assigneeAgentId: "agent-1" });
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
      // The issue already has an assignee, so reuse keeps its wake target and this
      // test stays focused on the idempotency behaviour itself.
      select: vi.fn((columns?: Record<string, unknown>) =>
        columns && "assigneeAgentId" in columns
          ? createSelectChain([{ assigneeAgentId: "agent-1", assigneeUserId: null }])
          : createSelectChain([existingRow])),
      insert: vi.fn(),
      update: vi.fn(),
      transaction: async (callback: (tx: any) => Promise<void>) => callback(db),
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

  it("create auto-assigns the creating agent when a wake_assignee interaction targets an ownerless issue", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    const { db, events, locks, touches } = createCreateFlowDb({
      currentIssueRow: { assigneeAgentId: null, assigneeUserId: null },
    });

    const svc = issueThreadInteractionService(db as never);
    const created = await svc.create({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, {
      kind: "ask_user_questions",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        questions: [{
          id: "scope",
          prompt: "Pick one scope",
          selectionMode: "single",
          required: true,
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      },
    }, {
      agentId: "agent-1",
    });

    expect(touches).toContainEqual(expect.objectContaining({ assigneeAgentId: "agent-1" }));
    expect(created.kind).toBe("ask_user_questions");
    // The issue row is read exactly once, under an exclusive lock. FOR SHARE here
    // would let two agents racing to create an interaction on the same ownerless
    // issue both hold it and then deadlock upgrading to write the assignee.
    expect(locks).toEqual(["update"]);
    // The adoption must happen inside the same transaction as the insert, so the
    // interaction and the wake target it depends on both land or neither does.
    expect(events).toEqual(["tx:begin", "select:issue", "insert:interaction", "update:assignee", "tx:end"]);
  });

  it("create leaves a user-assigned issue alone for a wake_assignee interaction", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    const { db, events } = createCreateFlowDb({
      currentIssueRow: { assigneeAgentId: null, assigneeUserId: "user-1" },
    });

    const svc = issueThreadInteractionService(db as never);
    await svc.create({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, {
      kind: "ask_user_questions",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        questions: [{
          id: "scope",
          prompt: "Pick one scope",
          selectionMode: "single",
          required: true,
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      },
    }, {
      agentId: "agent-1",
    });

    // A user assignee is already a live waiting path (this is a pending *user*
    // decision), and an issue may only carry one assignee — adopting here would
    // take the issue away from its human owner.
    expect(events).not.toContain("update:assignee");
  });

  it("create fails rather than persisting an interaction whose auto-assign failed", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    const { db, events } = createCreateFlowDb({
      currentIssueRow: { assigneeAgentId: null, assigneeUserId: null },
      failAssignment: true,
    });

    const svc = issueThreadInteractionService(db as never);

    // The assignment shares the insert's transaction: swallowing the failure here
    // would persist an interaction behind exactly the dead wake path this guards
    // against, so both must roll back and let the caller retry cleanly.
    await expect(svc.create({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, {
      kind: "ask_user_questions",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        questions: [{
          id: "scope",
          prompt: "Pick one scope",
          selectionMode: "single",
          required: true,
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      },
    }, {
      agentId: "agent-1",
    })).rejects.toThrow("assignment failed");

    expect(events).toContain("update:assignee");
  });

  it("create does not override an existing assignee for a wake_assignee interaction", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    const { db, events } = createCreateFlowDb({
      currentIssueRow: { assigneeAgentId: "agent-2", assigneeUserId: null },
    });

    const svc = issueThreadInteractionService(db as never);
    await svc.create({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, {
      kind: "ask_user_questions",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        questions: [{
          id: "scope",
          prompt: "Pick one scope",
          selectionMode: "single",
          required: true,
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      },
    }, {
      agentId: "agent-1",
    });

    expect(events).not.toContain("update:assignee");
  });

  it("create re-establishes the wake target when reusing an idempotent interaction on an ownerless issue", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    // Rows created before this guard existed — or whose issue lost its assignee
    // since — must not be handed back on retry still pointing at a dead wake path.
    const { db, events, locks, touches } = createCreateFlowDb({
      currentIssueRow: { assigneeAgentId: null, assigneeUserId: null },
      existingInteractionRow: {
        id: "interaction-existing",
        companyId: "company-1",
        issueId: "11111111-1111-4111-8111-111111111111",
        kind: "suggest_tasks",
        status: "pending",
        continuationPolicy: "wake_assignee",
        idempotencyKey: "run-1:suggest",
        sourceCommentId: null,
        sourceRunId: null,
        title: null,
        summary: null,
        createdByAgentId: "agent-1",
        createdByUserId: null,
        resolvedByAgentId: null,
        resolvedByUserId: null,
        payload: { version: 1, tasks: [{ clientKey: "task-1", title: "One" }] },
        result: null,
        resolvedAt: null,
        createdAt: new Date("2026-04-20T10:00:00.000Z"),
        updatedAt: new Date("2026-04-20T10:00:00.000Z"),
      },
    });

    const svc = issueThreadInteractionService(db as never);
    const created = await svc.create({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, {
      kind: "suggest_tasks",
      idempotencyKey: "run-1:suggest",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, tasks: [{ clientKey: "task-1", title: "One" }] },
    }, {
      agentId: "agent-1",
    });

    expect(created.id).toBe("interaction-existing");
    expect(db.insert).not.toHaveBeenCalled();
    expect(touches).toContainEqual(expect.objectContaining({ assigneeAgentId: "agent-1" }));
    expect(locks).toContain("update");
    expect(events).toEqual(["tx:begin", "select:assignee", "update:assignee", "tx:end"]);
  });

  it("create does not adopt the issue when reusing an already-resolved interaction", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    // A resolved interaction has spent its one continuation and can never wake
    // anyone again, so repairing its wake target would change ownership of an
    // ownerless issue without buying anything.
    const { db, events } = createCreateFlowDb({
      currentIssueRow: { assigneeAgentId: null, assigneeUserId: null },
      existingInteractionRow: {
        id: "interaction-existing",
        companyId: "company-1",
        issueId: "11111111-1111-4111-8111-111111111111",
        kind: "suggest_tasks",
        status: "accepted",
        continuationPolicy: "wake_assignee",
        idempotencyKey: "run-1:suggest",
        sourceCommentId: null,
        sourceRunId: null,
        title: null,
        summary: null,
        createdByAgentId: "agent-1",
        createdByUserId: null,
        resolvedByAgentId: null,
        resolvedByUserId: "local-board",
        payload: { version: 1, tasks: [{ clientKey: "task-1", title: "One" }] },
        result: { version: 1, outcome: "accepted", createdTasks: [] },
        resolvedAt: new Date("2026-04-20T11:00:00.000Z"),
        createdAt: new Date("2026-04-20T10:00:00.000Z"),
        updatedAt: new Date("2026-04-20T11:00:00.000Z"),
      },
    });

    const svc = issueThreadInteractionService(db as never);
    const created = await svc.create({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, {
      kind: "suggest_tasks",
      idempotencyKey: "run-1:suggest",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, tasks: [{ clientKey: "task-1", title: "One" }] },
    }, {
      agentId: "agent-1",
    });

    expect(created.id).toBe("interaction-existing");
    expect(events).not.toContain("update:assignee");
  });

  it("create does not auto-assign for request_confirmation's default none continuation policy", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    const { db, events, locks, touches } = createCreateFlowDb({
      currentIssueRow: { assigneeAgentId: null, assigneeUserId: null },
    });

    const svc = issueThreadInteractionService(db as never);
    await svc.create({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, {
      kind: "request_confirmation",
      continuationPolicy: "none",
      payload: {
        version: 1,
        prompt: "Approve this plan?",
        allowDeclineReason: true,
      },
    }, {
      agentId: "agent-1",
    });

    expect(events).not.toContain("update:assignee");
    // An interaction that cannot strand a wake path never writes the issue row,
    // so it only needs the terminal-issue gate's shared lock.
    expect(events).toEqual(["tx:begin", "select:issue", "insert:interaction", "tx:end"]);
    expect(locks).toEqual(["share"]);
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
