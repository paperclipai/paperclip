import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentThreadMessages,
  agentThreads,
  agents,
  clickupBridges,
  clickupOutboundEvents,
  companies,
  createDb,
  issueComments,
  issues,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { clickupBridgeService, isUserCommentForImport, resolveBridgeSource } from "../services/clickup-bridge.js";

describe("resolveBridgeSource", () => {
  it("resolves issue wake", () => {
    const source = resolveBridgeSource({ paperclipWake: { issue: { id: "iss-1" } } });
    expect(source).toEqual({ sourceType: "issue", sourceId: "iss-1", taskKey: "issue:iss-1" });
  });

  it("resolves agent thread when issue null", () => {
    const source = resolveBridgeSource({ paperclipWake: { issue: null }, agentThreadId: "th-1" });
    expect(source).toEqual({ sourceType: "agent_thread", sourceId: "th-1", taskKey: "agent-thread:th-1" });
  });
});

describe("isUserCommentForImport", () => {
  it("filters bot comments", () => {
    const res = isUserCommentForImport({ id: "c1", comment_text: "x", user: { id: "bot-1" }, date: "100" }, "bot-1");
    expect(res).toBeNull();
  });

  it("accepts non-bot text comments", () => {
    const res = isUserCommentForImport({ id: "c2", comment_text: "hello", user: { id: "u-1" }, date: "200" }, "bot-1");
    expect(res).toEqual({ id: "c2", text: "hello", createdAt: 200 });
  });

  it("accepts numeric ClickUp ids", () => {
    const res = isUserCommentForImport({ id: 42, comment_text: "hello", user: { id: 7 }, date: 200 }, "999");
    expect(res).toEqual({ id: "42", text: "hello", createdAt: 200 });
  });

  it("does not filter agent replies when bridge bot id is absent", () => {
    const res = isUserCommentForImport({ id: "c3", comment_text: "reply", user: { id: -16805283 }, date: "300" }, null, -16805283);
    expect(res).toEqual({ id: "c3", text: "reply", createdAt: 300 });
  });

  it("filters non-agent comments when bridge bot id is absent", () => {
    const res = isUserCommentForImport({ id: "c4", comment_text: "loopback", user: { id: 42 }, date: "400" }, null, -16805283);
    expect(res).toBeNull();
  });

  it("filters non-agent comments when bot id and agent id are both configured", () => {
    const res = isUserCommentForImport({ id: "c5", comment_text: "human reply", user: { id: 42 }, date: "500" }, "bot-1", -16805283);
    expect(res).toBeNull();
  });

  it("accepts configured agent comments when bot id and agent id are both configured", () => {
    const res = isUserCommentForImport({ id: "c6", comment_text: "agent reply", user: { id: -16805283 }, date: "600" }, "bot-1", -16805283);
    expect(res).toEqual({ id: "c6", text: "agent reply", createdAt: 600 });
  });

  it("falls back to rich comment array when comment_text missing", () => {
    const res = isUserCommentForImport({
      id: "c7",
      comment: [
        { text: "reviewed " },
        { type: "tag", user: { username: "Risk" } },
        { text: " and approved" },
      ],
      user: { id: -16805283 },
      date: "700",
    }, "bot-1", -16805283);
    expect(res).toEqual({ id: "c7", text: "reviewed @Risk and approved", createdAt: 700 });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres ClickUp bridge tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("clickupBridgeService.pollInbound", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-clickup-bridge-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/task/task-1/comment")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            comments: [
              {
                id: "clickup-comment-1",
                comment_text: "Imported from ClickUp",
                user: { id: 101 },
                date: 1710000000000,
              },
            ],
          }),
        };
      }
      if (url.endsWith("/comment/clickup-comment-1/reply")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ comments: [] }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete(activityLog);
    await db.delete(agentThreadMessages);
    await db.delete(agentThreads);
    await db.delete(issueComments);
    await db.delete(clickupOutboundEvents);
    await db.delete(clickupBridges);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("logs imported ClickUp issue comments into issue activity", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
      },
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 15,
      identifier: "TES-15",
      title: "ClickUp sync issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(clickupBridges).values({
      companyId,
      agentId,
      sourceType: "issue",
      sourceId: issueId,
      taskKey: "issue:TES-15",
      clickupListId: "list-1",
      clickupTaskId: "task-1",
      status: "waiting_for_agent_reply",
      nextPollAt: new Date(Date.now() - 60_000),
    });

    await clickupBridgeService(db).pollInbound();

    const comments = await db.select().from(issueComments);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe("Imported from ClickUp");

    const [bridge] = await db.select().from(clickupBridges);
    expect(bridge).toEqual(expect.objectContaining({
      status: "waiting_for_agent_reply",
      lastImportedCommentId: "clickup-comment-1",
    }));
    expect(bridge?.nextPollAt).toBeInstanceOf(Date);

    const events = await db.select().from(activityLog);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
      details: expect.objectContaining({
        bodySnippet: "Imported from ClickUp",
        identifier: "TES-15",
        issueTitle: "ClickUp sync issue",
        source: "clickup_bridge",
        clickupCommentId: "clickup-comment-1",
        clickupTaskId: "task-1",
      }),
    }));
  });

  it("imports agent replies when only clickupAgentUserId is configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/task/task-1/comment")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            comments: [
              {
                id: "clickup-comment-agent",
                comment_text: "AI agent reply",
                user: { id: -16805283 },
                date: 1710000000000,
              },
            ],
          }),
        };
      }
      if (url.endsWith("/comment/clickup-comment-agent/reply")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ comments: [] }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }));

    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        clickupAgentUserId: -16805283,
      },
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 16,
      identifier: "TES-16",
      title: "Import AI agent reply",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(clickupBridges).values({
      companyId,
      agentId,
      sourceType: "issue",
      sourceId: issueId,
      taskKey: "issue:TES-16",
      clickupListId: "list-1",
      clickupTaskId: "task-1",
      status: "waiting_for_agent_reply",
      nextPollAt: new Date(Date.now() - 60_000),
    });

    await clickupBridgeService(db).pollInbound();

    const comments = await db.select().from(issueComments);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe("AI agent reply");
  });

  it("deduplicates overlapping top-level comments and reply payload rows within one poll", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/task/task-1/comment")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            comments: [
              {
                id: "clickup-comment-1",
                comment_text: "hello",
                user: { id: 101 },
                date: 1710000000000,
              },
              {
                id: "clickup-comment-2",
                comment_text: "Bizbox Agent Reply",
                user: { id: 102 },
                date: 1710000001000,
              },
            ],
          }),
        };
      }
      if (url.endsWith("/comment/clickup-comment-1/reply")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            comments: [
              {
                id: "clickup-comment-1",
                comment_text: "hello",
                user: { id: 101 },
                date: 1710000000000,
              },
              {
                id: "clickup-comment-2",
                comment_text: "Bizbox Agent Reply",
                user: { id: 102 },
                date: 1710000001000,
              },
            ],
          }),
        };
      }
      if (url.endsWith("/comment/clickup-comment-2/reply")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            comments: [
              {
                id: "clickup-comment-2",
                comment_text: "Bizbox Agent Reply",
                user: { id: 102 },
                date: 1710000001000,
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }));

    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
      },
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 15,
      identifier: "TES-15",
      title: "ClickUp sync issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(clickupBridges).values({
      companyId,
      agentId,
      sourceType: "issue",
      sourceId: issueId,
      taskKey: "issue:TES-15",
      clickupListId: "list-1",
      clickupTaskId: "task-1",
      status: "waiting_for_agent_reply",
      nextPollAt: new Date(Date.now() - 60_000),
    });

    await clickupBridgeService(db).pollInbound();

    const comments = await db.select().from(issueComments);
    expect(comments.map((comment) => comment.body)).toEqual(["hello", "Bizbox Agent Reply"]);

    const events = await db.select().from(activityLog);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.details?.clickupCommentId)).toEqual(["clickup-comment-1", "clickup-comment-2"]);
  });

  it("skips malformed task comment payloads without failing the bridge poll", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/task/task-1/comment")) {
        return {
          ok: true,
          status: 200,
          text: async () => "<html>bad task comments payload</html>",
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }));

    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
      },
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 16,
      identifier: "TES-16",
      title: "Ignore malformed task comments",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(clickupBridges).values({
      companyId,
      agentId,
      sourceType: "issue",
      sourceId: issueId,
      taskKey: "issue:TES-16",
      clickupListId: "list-1",
      clickupTaskId: "task-1",
      status: "waiting_for_agent_reply",
      nextPollAt: new Date(Date.now() - 60_000),
    });

    await clickupBridgeService(db).pollInbound();

    const comments = await db.select().from(issueComments);
    const [bridge] = await db.select().from(clickupBridges);
    expect(comments).toHaveLength(0);
    expect(bridge).toEqual(expect.objectContaining({
      status: "waiting_for_agent_reply",
      consecutivePollFailures: 0,
      lastError: null,
    }));
  });

  it("skips malformed reply payloads without failing the bridge poll", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/task/task-1/comment")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            comments: [
              {
                id: "clickup-comment-1",
                comment_text: "Imported from ClickUp",
                user: { id: 101 },
                date: 1710000000000,
                reply_count: 1,
              },
            ],
          }),
        };
      }
      if (url.endsWith("/comment/clickup-comment-1/reply")) {
        return {
          ok: true,
          status: 200,
          text: async () => "<html>bad reply payload</html>",
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }));

    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
      },
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 16,
      identifier: "TES-16",
      title: "Ignore malformed replies",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(clickupBridges).values({
      companyId,
      agentId,
      sourceType: "issue",
      sourceId: issueId,
      taskKey: "issue:TES-16",
      clickupListId: "list-1",
      clickupTaskId: "task-1",
      status: "waiting_for_agent_reply",
      nextPollAt: new Date(Date.now() - 60_000),
    });

    await clickupBridgeService(db).pollInbound();

    const comments = await db.select().from(issueComments);
    const [bridge] = await db.select().from(clickupBridges);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe("Imported from ClickUp");
    expect(bridge).toEqual(expect.objectContaining({
      status: "waiting_for_agent_reply",
      consecutivePollFailures: 0,
      lastError: null,
    }));
  });

  it("keeps polling after the first imported reply so later ClickUp replies are also imported", async () => {
    const replies = [
      [
        {
          id: "clickup-comment-1",
          comment_text: "First reply",
          user: { id: 101 },
          date: 1710000000000,
        },
      ],
      [
        {
          id: "clickup-comment-1",
          comment_text: "First reply",
          user: { id: 101 },
          date: 1710000000000,
        },
        {
          id: "clickup-comment-2",
          comment_text: "Second reply",
          user: { id: 101 },
          date: 1710000005000,
        },
      ],
    ];

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/task/task-1/comment")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            comments: replies.shift() ?? [],
          }),
        };
      }
      if (url.endsWith("/comment/clickup-comment-1/reply") || url.endsWith("/comment/clickup-comment-2/reply")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ comments: [] }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }));

    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
      },
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 16,
      identifier: "TES-16",
      title: "Import follow-up ClickUp replies",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(clickupBridges).values({
      companyId,
      agentId,
      sourceType: "issue",
      sourceId: issueId,
      taskKey: "issue:TES-16",
      clickupListId: "list-1",
      clickupTaskId: "task-1",
      status: "waiting_for_agent_reply",
      nextPollAt: new Date(Date.now() - 60_000),
    });

    const svc = clickupBridgeService(db);
    await svc.pollInbound();
    await db.update(clickupBridges).set({
      nextPollAt: new Date(Date.now() - 1_000),
      updatedAt: new Date(),
    }).where(eq(clickupBridges.sourceId, issueId));
    await svc.pollInbound();

    const comments = await db.select().from(issueComments);
    expect(comments).toHaveLength(2);
    expect(comments.map((comment) => comment.body)).toEqual(["First reply", "Second reply"]);

    const [bridge] = await db.select().from(clickupBridges);
    expect(bridge).toEqual(expect.objectContaining({
      status: "waiting_for_agent_reply",
      lastImportedCommentId: "clickup-comment-2",
    }));
    expect(bridge?.nextPollAt).toBeInstanceOf(Date);
  });

  it("imports ClickUp replies into active agent threads", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const threadId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
      },
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentThreads).values({
      id: threadId,
      companyId,
      agentId,
      status: "active",
      lastActivityAt: new Date("2026-05-11T10:00:00.000Z"),
    });

    await db.insert(clickupBridges).values({
      companyId,
      agentId,
      sourceType: "agent_thread",
      sourceId: threadId,
      taskKey: `agent-thread:${threadId}`,
      clickupListId: "list-1",
      clickupTaskId: "task-1",
      status: "waiting_for_agent_reply",
      nextPollAt: new Date(Date.now() - 60_000),
    });

    await clickupBridgeService(db).pollInbound();

    const messages = await db.select().from(agentThreadMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({
      threadId,
      companyId,
      role: "assistant",
      authorAgentId: agentId,
      body: "Imported from ClickUp",
    }));
  });

  it("does not duplicate agent-thread imports across overlapping poll cycles", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/task/task-1/comment")) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            comments: [
              {
                id: "clickup-comment-1",
                comment_text: "Imported from ClickUp",
                user: { id: 101 },
                date: 1710000000000,
              },
            ],
          }),
        };
      }
      if (url.endsWith("/comment/clickup-comment-1/reply")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ comments: [] }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }));

    const companyId = randomUUID();
    const agentId = randomUUID();
    const threadId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
      },
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentThreads).values({
      id: threadId,
      companyId,
      agentId,
      status: "active",
      lastActivityAt: new Date("2026-05-11T10:00:00.000Z"),
    });

    await db.insert(clickupBridges).values({
      companyId,
      agentId,
      sourceType: "agent_thread",
      sourceId: threadId,
      taskKey: `agent-thread:${threadId}`,
      clickupListId: "list-1",
      clickupTaskId: "task-1",
      status: "waiting_for_agent_reply",
      nextPollAt: new Date(Date.now() - 60_000),
    });

    const svc = clickupBridgeService(db);
    await Promise.all([svc.pollInbound(), svc.pollInbound()]);

    const messages = await db.select().from(agentThreadMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe("Imported from ClickUp");
  });

  it("closes active bridges on shutdown cleanup", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "ClickUp Bridge",
        role: "engineer",
        status: "running",
        adapterType: "clickup_agent_ref",
        adapterConfig: {
          listId: "list-1",
          authToken: "token-1",
          bridgeBotUserId: "bridge-bot-1",
        },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "Other Bridge",
        role: "engineer",
        status: "running",
        adapterType: "clickup_agent_ref",
        adapterConfig: {
          listId: "list-2",
          authToken: "token-2",
          bridgeBotUserId: "bridge-bot-2",
        },
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const [activeBridge] = await db.insert(clickupBridges).values({
      companyId,
      agentId,
      sourceType: "agent_thread",
      sourceId: randomUUID(),
      taskKey: "agent-thread:one",
      clickupListId: "list-1",
      clickupTaskId: "task-1",
      status: "waiting_for_agent_reply",
      nextPollAt: new Date(),
    }).returning();

    const [pendingBridge] = await db.insert(clickupBridges).values({
      companyId,
      agentId,
      sourceType: "issue",
      sourceId: randomUUID(),
      taskKey: "issue:pending",
      clickupListId: "list-1",
      status: "pending_clickup_task",
      nextPollAt: new Date(),
    }).returning();

    const [otherBridge] = await db.insert(clickupBridges).values({
      companyId: otherCompanyId,
      agentId: otherAgentId,
      sourceType: "issue",
      sourceId: randomUUID(),
      taskKey: "issue:two",
      clickupListId: "list-2",
      clickupTaskId: "task-2",
      status: "waiting_for_agent_reply",
      nextPollAt: new Date(),
    }).returning();

    const closed = await clickupBridgeService(db).closeActiveBridges("shutdown", companyId);
    expect(closed.map((row) => row.id).sort()).toEqual([activeBridge!.id, pendingBridge!.id].sort());

    const bridges = await db.select().from(clickupBridges);
    const targetBridge = bridges.find((bridge) => bridge.id === activeBridge!.id);
    const pendingTargetBridge = bridges.find((bridge) => bridge.id === pendingBridge!.id);
    const untouchedBridge = bridges.find((bridge) => bridge.id === otherBridge!.id);
    expect(targetBridge).toEqual(expect.objectContaining({
      status: "closed",
      nextPollAt: null,
      lastError: "shutdown",
    }));
    expect(pendingTargetBridge).toEqual(expect.objectContaining({
      status: "closed",
      nextPollAt: null,
      lastError: "shutdown",
    }));
    expect(untouchedBridge).toEqual(expect.objectContaining({
      status: "waiting_for_agent_reply",
    }));
  });

  it("does not enqueue duplicate create_task events while initial task creation is pending", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const svc = clickupBridgeService(db);
    await svc.enqueueFromWake({
      companyId,
      agentId,
      context: { paperclipWake: { issue: { id: issueId } } },
      config: { listId: "list-1", authToken: "token-1", bridgeBotUserId: "bridge-bot-1" },
    });
    await svc.enqueueFromWake({
      companyId,
      agentId,
      context: { paperclipWake: { issue: { id: issueId } } },
      config: { listId: "list-1", authToken: "token-1", bridgeBotUserId: "bridge-bot-1" },
    });

    const events = await db.select().from(clickupOutboundEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      kind: "create_task",
      status: "pending",
    }));
  });

  it("refreshes bridge agentId and mode when wake conflicts with existing bridge", async () => {
    const companyId = randomUUID();
    const oldAgentId = randomUUID();
    const newAgentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: oldAgentId,
        companyId,
        name: "Old ClickUp Bridge",
        role: "engineer",
        status: "running",
        adapterType: "clickup_agent_ref",
        adapterConfig: {
          listId: "list-1",
          authToken: "token-1",
          bridgeBotUserId: "bridge-bot-1",
          triggerMode: "api_comment_only",
        },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: newAgentId,
        companyId,
        name: "New ClickUp Bridge",
        role: "engineer",
        status: "running",
        adapterType: "clickup_agent_ref",
        adapterConfig: {
          listId: "list-1",
          authToken: "token-1",
          bridgeBotUserId: "bridge-bot-1",
          triggerMode: "automation_trigger",
        },
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const svc = clickupBridgeService(db);
    await svc.enqueueFromWake({
      companyId,
      agentId: oldAgentId,
      context: { paperclipWake: { issue: { id: issueId } } },
      config: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
        triggerMode: "api_comment_only",
      },
    });

    await svc.enqueueFromWake({
      companyId,
      agentId: newAgentId,
      context: { paperclipWake: { issue: { id: issueId } } },
      config: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
        triggerMode: "automation_trigger",
      },
    });

    const [bridge] = await db.select().from(clickupBridges).where(eq(clickupBridges.companyId, companyId));
    expect(bridge).toEqual(expect.objectContaining({
      agentId: newAgentId,
      mode: "automation_trigger",
    }));
  });

  it("builds a stable structured outbound ClickUp message from the issue context", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
      },
      runtimeConfig: {},
      permissions: {},
    });

    await clickupBridgeService(db).enqueueFromWake({
      companyId,
      agentId,
      context: {
        wakeReason: "assignment",
        wakeText: "Use ClickUp as the execution surface.",
        paperclipContinuationSummary: {
          body: "Continue from the last completed checklist item.",
        },
        prompt: "Focus on restoring context parity.",
        paperclipWake: {
          reason: "issue_assigned",
          comments: [{ body: "Please pick this up next." }],
          issue: {
            id: issueId,
            identifier: "TES-15",
            status: "todo",
            priority: "high",
            title: "Fix adapter cancellation",
            description: "Stop run should also stop ClickUp bridge polling.",
          },
        },
      },
      config: { listId: "list-1", authToken: "token-1", bridgeBotUserId: "bridge-bot-1" },
    });

    const events = await db.select().from(clickupOutboundEvents);
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as { body?: string; taskName?: string } | null | undefined;
    expect(payload?.taskName).toBe("TES-15 - Fix adapter cancellation");
    expect(payload?.body).toContain("Issue: TES-15");
    expect(payload?.body).toContain("Title: Fix adapter cancellation");
    expect(payload?.body).toContain("Status: todo");
    expect(payload?.body).toContain("Priority: high");
    expect(payload?.body).toContain("Issue description:\nStop run should also stop ClickUp bridge polling.");
    expect(payload?.body).toContain("Focus on restoring context parity.");
    expect(payload?.body).toContain("Use ClickUp as the execution surface.");
    expect(payload?.body).toContain("Wake reason: assignment");
    expect(payload?.body).toContain("Recent Bizbox comments:\n- Please pick this up next.");
    expect(payload?.body).toContain("Continuation summary:\nContinue from the last completed checklist item.");
    expect(payload?.body).toContain("Bizbox context JSON:");
  });

  it("writes the same stable context into the ClickUp task description during task creation", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body && typeof init.body === "string"
        ? JSON.parse(init.body)
        : {};
      requests.push({ url, body });
      if (url.endsWith("/list/list-1/task")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: "task-1", url: "https://app.clickup.com/t/task-1" }),
        };
      }
      if (url.endsWith("/task/task-1/comment")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: "comment-1" }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
        includeContextJson: false,
      },
      runtimeConfig: {},
      permissions: {},
    });

    const svc = clickupBridgeService(db);
    await svc.enqueueFromWake({
      companyId,
      agentId,
      context: {
        wakeReason: "assignment",
        paperclipWake: {
          issue: {
            id: issueId,
            identifier: "TES-16",
            title: "Restore ClickUp context",
            description: "Persist the stable task context in ClickUp itself.",
          },
        },
      },
      config: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
        includeContextJson: false,
      },
    });

    await svc.processOutbound();

    expect(requests).toHaveLength(2);
    const createTask = requests[0];
    const firstComment = requests[1];
    expect(createTask?.url).toContain("/list/list-1/task");
    expect(createTask?.body.name).toBe("TES-16 - Restore ClickUp context");
    expect(createTask?.body.description).toContain("Issue: TES-16");
    expect(createTask?.body.description).toContain("Title: Restore ClickUp context");
    expect(createTask?.body.description).toContain("Issue description:\nPersist the stable task context in ClickUp itself.");
    expect(createTask?.body.description).toContain("Wake reason: assignment");
    expect(createTask?.body.description).not.toContain("Bizbox context JSON:");
    expect(firstComment?.url).toContain("/task/task-1/comment");
    expect(firstComment?.body.comment_text).toBe(createTask?.body.description);
  });

  it("marks create-task parse failures terminal to avoid duplicate ClickUp tasks", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/list/list-1/task")) {
        return {
          ok: true,
          status: 200,
          text: async () => "<html>edge cache weirdness</html>",
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }));

    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const svc = clickupBridgeService(db);
    await svc.enqueueFromWake({
      companyId,
      agentId,
      context: {
        paperclipWake: {
          issue: {
            id: issueId,
            identifier: "TES-17",
            title: "Do not duplicate task creation",
          },
        },
      },
      config: { listId: "list-1", authToken: "token-1", bridgeBotUserId: "bridge-bot-1" },
    });

    await svc.processOutbound();

    const [event] = await db.select().from(clickupOutboundEvents);
    const [bridge] = await db.select().from(clickupBridges);
    expect(event).toEqual(expect.objectContaining({
      status: "failed",
      attempts: 5,
      lastError: expect.stringContaining("clickup create task response parse failed:"),
    }));
    expect(bridge).toEqual(expect.objectContaining({
      status: "failed",
      clickupTaskId: null,
      lastError: expect.stringContaining("clickup create task response parse failed:"),
    }));
  });

  it("persists created task id before retrying failed first comment delivery", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body && typeof init.body === "string"
        ? JSON.parse(init.body)
        : {};
      requests.push({ url, body });
      if (url.endsWith("/list/list-1/task")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: "task-1", url: "https://app.clickup.com/t/task-1" }),
        };
      }
      if (url.endsWith("/task/task-1/comment")) {
        return {
          ok: false,
          status: 503,
          text: async () => "temporary failure",
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }));

    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const svc = clickupBridgeService(db);
    await svc.enqueueFromWake({
      companyId,
      agentId,
      context: {
        paperclipWake: {
          issue: {
            id: issueId,
            identifier: "TES-17",
            title: "Keep created task id on first comment retry",
          },
        },
      },
      config: { listId: "list-1", authToken: "token-1", bridgeBotUserId: "bridge-bot-1" },
    });

    await svc.processOutbound();

    const [event] = await db.select().from(clickupOutboundEvents);
    const [bridge] = await db.select().from(clickupBridges);
    expect(event).toEqual(expect.objectContaining({
      status: "pending",
      attempts: 1,
      lastError: "clickup first comment failed: 503",
    }));
    expect(bridge).toEqual(expect.objectContaining({
      clickupTaskId: "task-1",
      clickupTaskUrl: "https://app.clickup.com/t/task-1",
      status: "pending_clickup_task",
      lastError: "clickup first comment failed: 503",
    }));
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.clickup.com/api/v2/list/list-1/task",
      "https://api.clickup.com/api/v2/task/task-1/comment",
    ]);
  });

  it("requeues transient outbound failures as pending with a retry timestamp", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ClickUp unavailable");
    }));

    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const svc = clickupBridgeService(db);
    await svc.enqueueFromWake({
      companyId,
      agentId,
      context: {
        paperclipWake: {
          issue: {
            id: issueId,
            identifier: "TES-17",
            title: "Retry outbound delivery",
          },
        },
      },
      config: { listId: "list-1", authToken: "token-1", bridgeBotUserId: "bridge-bot-1" },
    });

    await svc.processOutbound();

    const [event] = await db.select().from(clickupOutboundEvents);
    expect(event).toEqual(expect.objectContaining({
      status: "pending",
      attempts: 1,
      lastError: "ClickUp unavailable",
    }));
    expect(event?.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("keeps outbound batch running when one bridge agent config is invalid", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body && typeof init.body === "string"
        ? JSON.parse(init.body)
        : {};
      requests.push({ url, body });
      if (url.endsWith("/list/list-1/task")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: "task-1", url: "https://app.clickup.com/t/task-1" }),
        };
      }
      if (url.endsWith("/task/task-1/comment")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: "comment-1" }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }));

    const companyId = randomUUID();
    const badAgentId = randomUUID();
    const goodAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: badAgentId,
        companyId,
        name: "Broken ClickUp Bridge",
        role: "engineer",
        status: "running",
        adapterType: "clickup_agent_ref",
        adapterConfig: {
          listId: "list-1",
        },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: goodAgentId,
        companyId,
        name: "Healthy ClickUp Bridge",
        role: "engineer",
        status: "running",
        adapterType: "clickup_agent_ref",
        adapterConfig: {
          listId: "list-1",
          authToken: "token-1",
          bridgeBotUserId: "bridge-bot-1",
        },
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const [badBridge] = await db.insert(clickupBridges).values({
      companyId,
      agentId: badAgentId,
      sourceType: "issue",
      sourceId: randomUUID(),
      taskKey: "issue:bad",
      clickupListId: "list-1",
      status: "pending_clickup_task",
      nextPollAt: new Date(),
    }).returning();

    const [goodBridge] = await db.insert(clickupBridges).values({
      companyId,
      agentId: goodAgentId,
      sourceType: "issue",
      sourceId: randomUUID(),
      taskKey: "issue:good",
      clickupListId: "list-1",
      status: "pending_clickup_task",
      nextPollAt: new Date(),
    }).returning();

    await db.insert(clickupOutboundEvents).values([
      {
        bridgeId: badBridge!.id,
        kind: "create_task",
        status: "pending",
        payload: { body: "broken body", taskName: "Broken task" },
      },
      {
        bridgeId: goodBridge!.id,
        kind: "create_task",
        status: "pending",
        payload: { body: "healthy body", taskName: "Healthy task" },
      },
    ]);

    await clickupBridgeService(db).processOutbound(10);

    const events = await db.select().from(clickupOutboundEvents);
    const brokenEvent = events.find((event) => event.bridgeId === badBridge!.id);
    const healthyEvent = events.find((event) => event.bridgeId === goodBridge!.id);
    expect(brokenEvent).toEqual(expect.objectContaining({
      status: "pending",
      attempts: 1,
      lastError: "clickup_agent_ref requires listId and authToken",
    }));
    expect(healthyEvent).toEqual(expect.objectContaining({
      status: "succeeded",
      attempts: 1,
    }));
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body.name).toBe("Healthy task");

    const refreshedGoodBridge = await db.select().from(clickupBridges).then((rows) => rows.find((row) => row.id === goodBridge!.id) ?? null);
    expect(refreshedGoodBridge).toEqual(expect.objectContaining({
      status: "waiting_for_agent_reply",
      clickupTaskId: "task-1",
    }));
  });

  it("does not retry append_comment when automation trigger status update times out", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body && typeof init.body === "string"
        ? JSON.parse(init.body)
        : {};
      requests.push({ url, body });
      if (url.endsWith("/task/task-1/comment")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: "comment-1" }),
        };
      }
      if (url.endsWith("/task/task-1")) {
        throw new Error("AbortError");
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Automation ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
        triggerMode: "automation_trigger",
        statusToTriggerAgent: "ai_intake",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const [bridge] = await db.insert(clickupBridges).values({
      companyId,
      agentId,
      sourceType: "issue",
      sourceId: randomUUID(),
      taskKey: "issue:automation",
      clickupListId: "list-1",
      clickupTaskId: "task-1",
      status: "agent_replied",
      mode: "automation_trigger",
      importedCommentIds: [],
    }).returning();

    await db.insert(clickupOutboundEvents).values({
      bridgeId: bridge!.id,
      kind: "append_comment",
      status: "pending",
      payload: { body: "hello", taskName: "Automation task" },
    });

    await clickupBridgeService(db).processOutbound();

    const event = await db.select().from(clickupOutboundEvents).then((rows) => rows[0] ?? null);
    const refreshedBridge = await db.select().from(clickupBridges).then((rows) => rows[0] ?? null);
    expect(event).toEqual(expect.objectContaining({
      status: "succeeded",
      attempts: 1,
    }));
    expect(refreshedBridge).toEqual(expect.objectContaining({
      status: "waiting_for_agent_reply",
      importedCommentIds: ["comment-1"],
    }));
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.clickup.com/api/v2/task/task-1/comment",
      "https://api.clickup.com/api/v2/task/task-1",
    ]);
  });

  it("creates automation trigger tasks with status tags and assignee", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body && typeof init.body === "string"
        ? JSON.parse(init.body)
        : {};
      requests.push({ url, body });
      if (url.endsWith("/list/list-1/task")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: "task-1", url: "https://app.clickup.com/t/task-1" }),
        };
      }
      if (url.endsWith("/task/task-1/comment")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: "comment-1" }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Automation ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
        clickupAgentUserId: -16805283,
        triggerMode: "automation_trigger",
        automationStatus: "ai_intake",
        automationTags: ["bizbox", "triage"],
      },
      runtimeConfig: {},
      permissions: {},
    });

    const [bridge] = await db.insert(clickupBridges).values({
      companyId,
      agentId,
      sourceType: "issue",
      sourceId: randomUUID(),
      taskKey: "issue:automation-create",
      clickupListId: "list-1",
      status: "pending_clickup_task",
      mode: "automation_trigger",
      nextPollAt: new Date(),
    }).returning();

    await db.insert(clickupOutboundEvents).values({
      bridgeId: bridge!.id,
      kind: "create_task",
      status: "pending",
      payload: { body: "hello", taskName: "Automation task" },
    });

    await clickupBridgeService(db).processOutbound();

    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toEqual(expect.objectContaining({
      name: "Automation task",
      description: "hello",
      status: "ai_intake",
      tags: ["bizbox", "triage"],
      assignees: [-16805283],
      notify_all: false,
    }));
  });

  it("requeues stale processing events before selecting new outbound work", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body && typeof init.body === "string"
        ? JSON.parse(init.body)
        : {};
      requests.push({ url, body });
      if (url.endsWith("/list/list-1/task")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: "task-1", url: "https://app.clickup.com/t/task-1" }),
        };
      }
      if (url.endsWith("/task/task-1/comment")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: "comment-1" }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const [bridge] = await db.insert(clickupBridges).values({
      companyId,
      agentId,
      sourceType: "issue",
      sourceId: issueId,
      taskKey: "issue:stale",
      clickupListId: "list-1",
      status: "pending_clickup_task",
      nextPollAt: new Date(),
    }).returning();

    await db.insert(clickupOutboundEvents).values({
      bridgeId: bridge!.id,
      kind: "create_task",
      status: "processing",
      payload: { body: "recovered body", taskName: "Recovered task" },
      updatedAt: new Date(Date.now() - 3 * 60 * 1000),
    });

    await clickupBridgeService(db).processOutbound();

    const event = await db.select().from(clickupOutboundEvents).then((rows) => rows[0] ?? null);
    expect(event).toEqual(expect.objectContaining({
      status: "succeeded",
      attempts: 1,
    }));
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body.name).toBe("Recovered task");
  });

  it("keeps deliberately closed bridges closed when outbound retries exhaust", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Closed ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const [closedBridge] = await db.insert(clickupBridges).values({
      companyId,
      agentId,
      sourceType: "issue",
      sourceId: randomUUID(),
      taskKey: "issue:closed",
      clickupListId: "list-1",
      status: "closed",
      nextPollAt: null,
    }).returning();

    await db.insert(clickupOutboundEvents).values({
      bridgeId: closedBridge!.id,
      kind: "append_comment",
      status: "pending",
      attempts: 4,
      payload: { body: "stale body", taskName: "Closed task" },
    });

    await clickupBridgeService(db).processOutbound();

    const bridge = await db.select().from(clickupBridges).then((rows) => rows.find((row) => row.id === closedBridge!.id) ?? null);
    const event = await db.select().from(clickupOutboundEvents).then((rows) => rows.find((row) => row.bridgeId === closedBridge!.id) ?? null);
    expect(bridge).toEqual(expect.objectContaining({
      status: "closed",
      lastError: "clickup bridge not runnable: closed",
    }));
    expect(event).toEqual(expect.objectContaining({
      status: "failed",
      attempts: 5,
      lastError: "clickup bridge not runnable: closed",
    }));
  });

  it("does not let exhausted failed events crowd out runnable outbound work", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body && typeof init.body === "string"
        ? JSON.parse(init.body)
        : {};
      requests.push({ url, body });
      if (url.endsWith("/list/list-1/task")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: "task-1", url: "https://app.clickup.com/t/task-1" }),
        };
      }
      if (url.endsWith("/task/task-1/comment")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: "comment-1" }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClickUp Bridge",
      role: "engineer",
      status: "running",
      adapterType: "clickup_agent_ref",
      adapterConfig: {
        listId: "list-1",
        authToken: "token-1",
        bridgeBotUserId: "bridge-bot-1",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const [blockedBridge] = await db.insert(clickupBridges).values({
      companyId,
      agentId,
      sourceType: "issue",
      sourceId: randomUUID(),
      taskKey: "issue:blocked",
      clickupListId: "list-1",
      status: "pending_clickup_task",
      nextPollAt: new Date(),
    }).returning();

    await db.insert(clickupOutboundEvents).values({
      bridgeId: blockedBridge!.id,
      kind: "create_task",
      status: "failed",
      attempts: 5,
      payload: { body: "old failed event", taskName: "Blocked task" },
      nextAttemptAt: new Date(Date.now() - 60_000),
      lastError: "permanent failure",
    });

    const svc = clickupBridgeService(db);
    await svc.enqueueFromWake({
      companyId,
      agentId,
      context: {
        paperclipWake: {
          issue: {
            id: issueId,
            identifier: "TES-18",
            title: "Deliver fresh outbound work",
          },
        },
      },
      config: { listId: "list-1", authToken: "token-1", bridgeBotUserId: "bridge-bot-1" },
    });

    await svc.processOutbound(1);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.body.name).toBe("TES-18 - Deliver fresh outbound work");

    const events = await db.select().from(clickupOutboundEvents);
    const exhausted = events.find((event) => event.bridgeId === blockedBridge!.id);
    const processed = events.find((event) => event.bridgeId !== blockedBridge!.id);
    expect(exhausted).toEqual(expect.objectContaining({
      status: "failed",
      attempts: 5,
      lastError: "permanent failure",
    }));
    expect(processed).toEqual(expect.objectContaining({
      status: "succeeded",
      attempts: 1,
    }));
  });
});
