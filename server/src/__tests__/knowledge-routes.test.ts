import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { conflict, notFound, unprocessable } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";

type KnowledgeRecord = {
  id: string;
  companyId: string;
  title: string;
  kind: "note" | "asset" | "url";
  summary: string | null;
  body: string | null;
  assetId: string | null;
  sourceUrl: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type IssueRecord = {
  id: string;
  companyId: string;
};

type AttachmentRecord = {
  id: string;
  companyId: string;
  issueId: string;
  knowledgeItemId: string;
  sortOrder: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  knowledgeItem: KnowledgeRecord;
};

type AgentRecord = {
  id: string;
  companyId: string;
  role: string;
};

type TestActor =
  | {
      type: "board";
      userId: string;
      companyIds: string[];
      isInstanceAdmin: boolean;
      source: "session";
      runId?: string;
    }
  | {
      type: "agent";
      agentId: string;
      companyId: string;
      source: "agent_jwt" | "agent_key";
      runId?: string;
    };

function createServiceStub() {
  const issueId = "11111111-1111-4111-8111-111111111111";
  const companyKnowledgeId = "22222222-2222-4222-8222-222222222222";
  const foreignKnowledgeId = "33333333-3333-4333-8333-333333333333";
  const userKnowledgeId = "44444444-4444-4444-8444-444444444444";
  const issues = new Map<string, IssueRecord>([[issueId, { id: issueId, companyId: "cmp-1" }]]);
  const agents = new Map<string, AgentRecord>([
    ["agent-author", { id: "agent-author", companyId: "cmp-1", role: "engineer" }],
    ["agent-editor", { id: "agent-editor", companyId: "cmp-1", role: "engineer" }],
    ["agent-ceo", { id: "agent-ceo", companyId: "cmp-1", role: "ceo" }],
  ]);
  const knowledge = new Map<string, KnowledgeRecord>([
    [
      companyKnowledgeId,
      {
        id: companyKnowledgeId,
        companyId: "cmp-1",
        title: "Existing API notes",
        kind: "note",
        summary: "Current API access instructions",
        body: "Use the existing key rotation procedure.",
        assetId: null,
        sourceUrl: null,
        createdByAgentId: "agent-author",
        createdByUserId: null,
        updatedByAgentId: "agent-author",
        updatedByUserId: null,
        createdAt: new Date("2026-03-07T12:00:00Z"),
        updatedAt: new Date("2026-03-07T12:00:00Z"),
      },
    ],
    [
      foreignKnowledgeId,
      {
        id: foreignKnowledgeId,
        companyId: "cmp-2",
        title: "Other company note",
        kind: "note",
        summary: "Foreign context",
        body: "Should not attach cross-company.",
        assetId: null,
        sourceUrl: null,
        createdByAgentId: null,
        createdByUserId: "user-2",
        updatedByAgentId: null,
        updatedByUserId: "user-2",
        createdAt: new Date("2026-03-07T12:10:00Z"),
        updatedAt: new Date("2026-03-07T12:10:00Z"),
      },
    ],
    [
      userKnowledgeId,
      {
        id: userKnowledgeId,
        companyId: "cmp-1",
        title: "Board-authored note",
        kind: "note",
        summary: "Created by a human session actor",
        body: "This note verifies the board delete path.",
        assetId: null,
        sourceUrl: null,
        createdByAgentId: null,
        createdByUserId: "user-1",
        updatedByAgentId: null,
        updatedByUserId: "user-1",
        createdAt: new Date("2026-03-07T12:15:00Z"),
        updatedAt: new Date("2026-03-07T12:15:00Z"),
      },
    ],
  ]);
  const attachments = new Map<string, AttachmentRecord>();

  return {
    agentService: {
      getById: vi.fn(async (id: string) => agents.get(id) ?? null),
    },
    list: vi.fn(async (companyId: string) =>
      Array.from(knowledge.values()).filter((item) => item.companyId === companyId)),
    create: vi.fn(async (companyId: string, payload: any, actor: { userId?: string | null; agentId?: string | null }) => {
      const id = `know-${knowledge.size + 1}`;
      const record: KnowledgeRecord = {
        id,
        companyId,
        title: payload.title,
        kind: payload.kind,
        summary: payload.summary ?? null,
        body: payload.kind === "note" ? payload.body : null,
        assetId: payload.kind === "asset" ? payload.assetId : null,
        sourceUrl: payload.kind === "url" ? payload.sourceUrl : null,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        updatedByAgentId: actor.agentId ?? null,
        updatedByUserId: actor.userId ?? null,
        createdAt: new Date("2026-03-07T13:00:00Z"),
        updatedAt: new Date("2026-03-07T13:00:00Z"),
      };
      knowledge.set(id, record);
      return record;
    }),
    getById: vi.fn(async (id: string) => knowledge.get(id) ?? null),
    update: vi.fn(async (id: string, payload: any, actor?: { userId?: string | null; agentId?: string | null }) => {
      const existing = knowledge.get(id);
      if (!existing) return null;
      const updated = {
        ...existing,
        ...payload,
        updatedByAgentId: actor?.agentId ?? null,
        updatedByUserId: actor?.userId ?? null,
        updatedAt: new Date("2026-03-07T13:05:00Z"),
      };
      knowledge.set(id, updated);
      return updated;
    }),
    remove: vi.fn(async (id: string) => {
      const existing = knowledge.get(id) ?? null;
      if (!existing) return null;
      knowledge.delete(id);
      for (const [attachmentId, attachment] of attachments.entries()) {
        if (attachment.knowledgeItemId === id) attachments.delete(attachmentId);
      }
      return existing;
    }),
    getIssueById: vi.fn(async (currentIssueId: string) => issues.get(currentIssueId) ?? null),
    listForIssue: vi.fn(async (currentIssueId: string) =>
      Array.from(attachments.values())
        .filter((attachment) => attachment.issueId === currentIssueId)
        .sort((a, b) => a.sortOrder - b.sortOrder)),
    attachToIssue: vi.fn(async (
      currentIssueId: string,
      knowledgeItemId: string,
      actor: { userId?: string | null; agentId?: string | null },
    ) => {
      const issue = issues.get(currentIssueId);
      if (!issue) throw notFound("Issue not found");
      const knowledgeItem = knowledge.get(knowledgeItemId);
      if (!knowledgeItem) throw notFound("Knowledge item not found");
      if (knowledgeItem.companyId !== issue.companyId) {
        throw unprocessable("Knowledge item must belong to same company as issue");
      }
      const duplicate = Array.from(attachments.values()).find(
        (attachment) => attachment.issueId === currentIssueId && attachment.knowledgeItemId === knowledgeItemId,
      );
      if (duplicate) throw conflict("Knowledge item already attached to issue");

      const record: AttachmentRecord = {
        id: `attach-${attachments.size + 1}`,
        companyId: issue.companyId,
        issueId: currentIssueId,
        knowledgeItemId,
        sortOrder: attachments.size,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdAt: new Date("2026-03-07T13:10:00Z"),
        updatedAt: new Date("2026-03-07T13:10:00Z"),
        knowledgeItem,
      };
      attachments.set(record.id, record);
      return record;
    }),
    detachFromIssue: vi.fn(async (currentIssueId: string, knowledgeItemId: string) => {
      for (const [attachmentId, attachment] of attachments.entries()) {
        if (attachment.issueId === currentIssueId && attachment.knowledgeItemId === knowledgeItemId) {
          attachments.delete(attachmentId);
          return attachment;
        }
      }
      return null;
    }),
  };
}

let serviceStub = createServiceStub();
const logActivityMock = vi.fn();

vi.mock("../services/index.js", () => ({
  knowledgeService: () => serviceStub,
  agentService: () => serviceStub.agentService,
  logActivity: logActivityMock,
}));

function boardActor(): TestActor {
  return {
    type: "board",
    userId: "user-1",
    companyIds: ["cmp-1"],
    isInstanceAdmin: false,
    source: "session",
  };
}

function agentActor(agentId: string): TestActor {
  return {
    type: "agent",
    agentId,
    companyId: "cmp-1",
    source: "agent_jwt",
  };
}

async function createApp(actor: TestActor = boardActor()) {
  const { knowledgeRoutes } = await import("../routes/knowledge.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as any;
    next();
  });
  app.use(knowledgeRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("knowledge routes", () => {
  beforeEach(() => {
    serviceStub = createServiceStub();
    logActivityMock.mockReset();
  });

  it("creates note knowledge items for a company", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/companies/cmp-1/knowledge-items")
      .send({
        title: "Stripe access notes",
        kind: "note",
        summary: "How agents should use Stripe",
        body: "Use STRIPE_SECRET_KEY from company secrets.",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      companyId: "cmp-1",
      title: "Stripe access notes",
      kind: "note",
      body: "Use STRIPE_SECRET_KEY from company secrets.",
    });
  });

  it("lists company knowledge items", async () => {
    const app = await createApp();

    const res = await request(app).get("/companies/cmp-1/knowledge-items");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "22222222-2222-4222-8222-222222222222",
          companyId: "cmp-1",
          title: "Existing API notes",
        }),
        expect.objectContaining({
          id: "44444444-4444-4444-8444-444444444444",
          companyId: "cmp-1",
          title: "Board-authored note",
        }),
      ]),
    );
  });

  it("passes the agent actor through updates and records updated authorship", async () => {
    const app = await createApp(agentActor("agent-editor"));

    const res = await request(app)
      .patch("/knowledge-items/22222222-2222-4222-8222-222222222222")
      .send({
        title: "Updated API notes",
        summary: "Revised access instructions",
        body: "Use the rotated secret and document every change.",
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "22222222-2222-4222-8222-222222222222",
      title: "Updated API notes",
      summary: "Revised access instructions",
      body: "Use the rotated secret and document every change.",
      updatedByAgentId: "agent-editor",
      updatedByUserId: null,
    });
    expect(serviceStub.update).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        title: "Updated API notes",
      }),
      { agentId: "agent-editor", userId: null },
    );
    expect(logActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "knowledge_item.updated",
        details: {
          updatedFields: ["body", "summary", "title"],
        },
      }),
    );
  });

  it("rejects deleting another agent's knowledge item for a non-ceo agent", async () => {
    const app = await createApp(agentActor("agent-editor"));

    const res = await request(app)
      .delete("/knowledge-items/22222222-2222-4222-8222-222222222222");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Only the creator, CEO, or board can delete this knowledge item",
    });
  });

  it("allows the creator agent to delete their own knowledge item", async () => {
    const app = await createApp(agentActor("agent-author"));

    const res = await request(app)
      .delete("/knowledge-items/22222222-2222-4222-8222-222222222222");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const listed = await request(app).get("/companies/cmp-1/knowledge-items");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({
        id: "44444444-4444-4444-8444-444444444444",
        companyId: "cmp-1",
        title: "Board-authored note",
      }),
    ]);
  });

  it("allows a board session actor to delete a knowledge item created by a human user", async () => {
    const app = await createApp(boardActor());

    const res = await request(app)
      .delete("/knowledge-items/44444444-4444-4444-8444-444444444444");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const listed = await request(app).get("/companies/cmp-1/knowledge-items");
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({
      id: "22222222-2222-4222-8222-222222222222",
      companyId: "cmp-1",
      title: "Existing API notes",
    });
  });

  it("allows the ceo agent to delete another agent's knowledge item", async () => {
    const app = await createApp(agentActor("agent-ceo"));

    const res = await request(app)
      .delete("/knowledge-items/22222222-2222-4222-8222-222222222222");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("attaches knowledge items to an issue", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/issues/11111111-1111-4111-8111-111111111111/knowledge-items")
      .send({ knowledgeItemId: "22222222-2222-4222-8222-222222222222" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      issueId: "11111111-1111-4111-8111-111111111111",
      knowledgeItemId: "22222222-2222-4222-8222-222222222222",
      companyId: "cmp-1",
      knowledgeItem: {
        id: "22222222-2222-4222-8222-222222222222",
        title: "Existing API notes",
      },
    });
  });

  it("rejects cross-company knowledge attachments", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/issues/11111111-1111-4111-8111-111111111111/knowledge-items")
      .send({ knowledgeItemId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Knowledge item must belong to same company as issue",
    });
  });

  it("rejects duplicate knowledge attachments for the same issue", async () => {
    const app = await createApp();

    const first = await request(app)
      .post("/issues/11111111-1111-4111-8111-111111111111/knowledge-items")
      .send({ knowledgeItemId: "22222222-2222-4222-8222-222222222222" });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/issues/11111111-1111-4111-8111-111111111111/knowledge-items")
      .send({ knowledgeItemId: "22222222-2222-4222-8222-222222222222" });

    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: "Knowledge item already attached to issue",
    });
  });
});
