import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";

type IssueStub = {
  id: string;
  companyId: string;
  title: string;
  identifier: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

type TxState = {
  persistedIssueIds: string[];
  attachedKnowledgeIds: string[];
  activityActions: string[];
};

const callOrder: string[] = [];
const issueStub: IssueStub = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "cmp-1",
  title: "Create with knowledge",
  identifier: "CMP-1",
  status: "backlog",
  assigneeAgentId: "22222222-2222-4222-8222-222222222222",
  assigneeUserId: null,
};

let failOnKnowledgeItemId: string | null = null;
const state: TxState = {
  persistedIssueIds: [],
  attachedKnowledgeIds: [],
  activityActions: [],
};

function createTxDbStub() {
  return {
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    transaction: vi.fn(async <T>(callback: (tx: TxState) => Promise<T>) => {
      const draft: TxState = {
        persistedIssueIds: [...state.persistedIssueIds],
        attachedKnowledgeIds: [...state.attachedKnowledgeIds],
        activityActions: [...state.activityActions],
      };

      try {
        const result = await callback(draft);
        state.persistedIssueIds = draft.persistedIssueIds;
        state.attachedKnowledgeIds = draft.attachedKnowledgeIds;
        state.activityActions = draft.activityActions;
        return result;
      } catch (error) {
        throw error;
      }
    }),
  };
}

const issueServiceStub = {
  create: vi.fn(async (_companyId: string, data: Record<string, unknown>) => {
    callOrder.push("create");
    state.persistedIssueIds.push(issueStub.id);
    return {
      ...issueStub,
      title: String(data.title ?? issueStub.title),
      status: String(data.status ?? issueStub.status),
      assigneeAgentId: (data.assigneeAgentId as string | null | undefined) ?? null,
      assigneeUserId: (data.assigneeUserId as string | null | undefined) ?? null,
    };
  }),
  createInTx: vi.fn(async (tx: TxState, _companyId: string, data: Record<string, unknown>) => {
    callOrder.push("create");
    tx.persistedIssueIds.push(issueStub.id);
    return {
      ...issueStub,
      title: String(data.title ?? issueStub.title),
      status: String(data.status ?? issueStub.status),
      assigneeAgentId: (data.assigneeAgentId as string | null | undefined) ?? null,
      assigneeUserId: (data.assigneeUserId as string | null | undefined) ?? null,
    };
  }),
};

const knowledgeServiceStub = {
  getById: vi.fn(async (knowledgeItemId: string) => ({
    id: knowledgeItemId,
    companyId: "cmp-1",
  })),
  attachToIssue: vi.fn(async (issueId: string, knowledgeItemId: string) => {
    callOrder.push(`attach:${knowledgeItemId}`);
    if (knowledgeItemId === failOnKnowledgeItemId) {
      throw new Error("attach failed");
    }
    state.attachedKnowledgeIds.push(knowledgeItemId);
    return {
      id: `attach-${knowledgeItemId}`,
      issueId,
      knowledgeItemId,
    };
  }),
  attachToIssueInTx: vi.fn(async (
    tx: TxState,
    issueId: string,
    knowledgeItemId: string,
  ) => {
    callOrder.push(`attach:${knowledgeItemId}`);
    if (knowledgeItemId === failOnKnowledgeItemId) {
      throw new Error("attach failed");
    }
    tx.attachedKnowledgeIds.push(knowledgeItemId);
    return {
      id: `attach-${knowledgeItemId}`,
      issueId,
      knowledgeItemId,
    };
  }),
};

const heartbeatServiceStub = {
  wakeup: vi.fn(async () => {
    callOrder.push("wakeup");
    return null;
  }),
};

const noopAsync = vi.fn(async () => null);
const logActivityMock = vi.fn(async (db: TxState | { transaction?: unknown }, input: { action: string }) => {
  const target = typeof (db as TxState).activityActions !== "undefined" ? (db as TxState) : state;
  target.activityActions.push(input.action);
  return undefined;
});

vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: noopAsync, hasPermission: noopAsync }),
  agentService: () => ({ getById: noopAsync }),
  goalService: () => ({}),
  heartbeatService: () => heartbeatServiceStub,
  issueApprovalService: () => ({}),
  issueService: () => issueServiceStub,
  knowledgeService: () => knowledgeServiceStub,
  logActivity: logActivityMock,
  projectService: () => ({}),
}));

async function createApp() {
  const { issueRoutes } = await import("../routes/issues.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: ["cmp-1"],
    } as any;
    next();
  });
  app.use(issueRoutes(createTxDbStub() as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue create knowledge routing", () => {
  beforeEach(() => {
    callOrder.length = 0;
    failOnKnowledgeItemId = null;
    state.persistedIssueIds = [];
    state.attachedKnowledgeIds = [];
    state.activityActions = [];
    issueServiceStub.create.mockClear();
    issueServiceStub.createInTx.mockClear();
    knowledgeServiceStub.getById.mockClear();
    knowledgeServiceStub.attachToIssue.mockClear();
    knowledgeServiceStub.attachToIssueInTx.mockClear();
    heartbeatServiceStub.wakeup.mockClear();
    logActivityMock.mockClear();
  });

  it("attaches knowledge on the server before waking the assignee", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/companies/cmp-1/issues")
      .send({
        title: "Create with knowledge",
        status: "todo",
        assigneeAgentId: "22222222-2222-4222-8222-222222222222",
        knowledgeItemIds: [
          "33333333-3333-4333-8333-333333333333",
          "44444444-4444-4444-8444-444444444444",
        ],
      });

    expect(res.status).toBe(201);
    expect(issueServiceStub.createInTx).toHaveBeenCalledTimes(1);
    expect(knowledgeServiceStub.attachToIssueInTx).toHaveBeenCalledTimes(2);
    expect(knowledgeServiceStub.attachToIssueInTx).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      issueStub.id,
      "33333333-3333-4333-8333-333333333333",
      expect.objectContaining({ userId: "local-board" }),
    );
    expect(knowledgeServiceStub.attachToIssueInTx).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      issueStub.id,
      "44444444-4444-4444-8444-444444444444",
      expect.objectContaining({ userId: "local-board" }),
    );
    expect(state.persistedIssueIds).toEqual([issueStub.id]);
    expect(state.attachedKnowledgeIds).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ]);
    expect(state.activityActions).toEqual(["issue.created", "issue.knowledge_attached", "issue.knowledge_attached"]);
    expect(callOrder).toEqual([
      "create",
      "attach:33333333-3333-4333-8333-333333333333",
      "attach:44444444-4444-4444-8444-444444444444",
      "wakeup",
    ]);
  });

  it("rolls back the issue when a knowledge attachment fails", async () => {
    failOnKnowledgeItemId = "44444444-4444-4444-8444-444444444444";
    const app = await createApp();

    const res = await request(app)
      .post("/companies/cmp-1/issues")
      .send({
        title: "Create with failing knowledge",
        status: "todo",
        assigneeAgentId: "22222222-2222-4222-8222-222222222222",
        knowledgeItemIds: [
          "33333333-3333-4333-8333-333333333333",
          "44444444-4444-4444-8444-444444444444",
        ],
      });

    expect(res.status).toBe(500);
    expect(state.persistedIssueIds).toEqual([]);
    expect(state.attachedKnowledgeIds).toEqual([]);
    expect(state.activityActions).toEqual([]);
    expect(heartbeatServiceStub.wakeup).not.toHaveBeenCalled();
  });
});
