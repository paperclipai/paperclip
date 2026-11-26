import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  agents, chatConversations, chatEndpoints, issues, toolApplications, toolConnections,
} from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import * as issueServices from "../services/issues.js";
import { errorHandler } from "../middleware/index.js";
import { describeEmbeddedPostgres, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("bounded issue summaries", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-summaries-");
  const oldPrivacy = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  beforeAll(() => { process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce"; });
  afterAll(() => {
    if (oldPrivacy === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = oldPrivacy;
  });

  async function fixture() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Summaries");
    const rows = await ctx.db.insert(issues).values([
      { companyId: company.companyId, title: "First", description: "Do not serialize this".repeat(100), status: "todo" },
      { companyId: company.companyId, title: "Second", status: "done" },
    ]).returning();
    return { ...company, rows };
  }
  function app(actor: Express.Request["actor"]) {
    const result = express();
    result.use(express.json());
    result.use((req, _res, next) => { req.actor = actor; next(); });
    result.use("/api", issueRoutes(ctx.db, {} as never));
    result.use(errorHandler);
    return result;
  }
  const url = (companyId: string) => `/api/companies/${companyId}/issues/summaries`;

  it("returns only summaries in requested order without full-detail reads", async () => {
    const f = await fixture();
    const original = issueServices.issueService;
    const forbiddenRead = vi.fn(() => { throw new Error("Full detail read invoked"); });
    const spy = vi.spyOn(issueServices, "issueService").mockImplementation((...args) => ({
      ...original(...args), getById: forbiddenRead, list: forbiddenRead,
    }));
    try {
      const res = await request(app(f.actor)).get(url(f.companyId)).query({ ids: ` ${f.rows[1]!.id.toUpperCase()},${f.rows[0]!.id},${f.rows[1]!.id} ` }).expect(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.body.map((row: { id: string }) => row.id)).toEqual([f.rows[1]!.id, f.rows[0]!.id]);
      expect(Object.keys(res.body[0]).sort()).toEqual([
        "companyId", "externalConversationState", "id", "identifier", "status", "title", "updatedAt",
      ]);
      expect(res.body[0].externalConversationState).toBeNull();
      expect(forbiddenRead).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it.each(["", "?ids=", "?ids=nope", "?ids=,", "?ids[]=nope", "?ids[x]=nope",
    `?ids=${randomUUID()}&ids[]=nope`, `?ids=${randomUUID()}&ids[x]=nope`,
    `?ids=${randomUUID()}&ids=${randomUUID()}`, `?ids=${Array(6).fill(randomUUID()).join(",")}`,
  ])("rejects invalid query %s", async (query) => {
    const f = await fixture();
    await request(app(f.actor)).get(url(f.companyId) + query).expect(400);
  });

  it("omits hidden, private, foreign and missing IDs without revealing them", async () => {
    const f = await fixture();
    const foreign = await fixture();
    const hidden = f.rows[1]!;
    await ctx.db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, hidden.id));
    const privateId = randomUUID();
    await ctx.db.insert(issues).values({ id: privateId, companyId: f.companyId, title: "Private", visibility: "private", privacyRootIssueId: privateId, responsibleUserId: "someone-else", createdByUserId: "someone-else" });
    const ids = [f.rows[0]!.id, hidden.id, privateId, foreign.rows[0]!.id, randomUUID()];
    const res = await request(app(f.actor)).get(url(f.companyId)).query({ ids: ids.join(",") }).expect(200);
    expect(res.body.map((row: { id: string }) => row.id)).toEqual([f.rows[0]!.id]);
    const empty = await request(app(f.actor)).get(url(f.companyId)).query({ ids: ids.slice(1).join(",") }).expect(200);
    expect(empty.body).toEqual([]);
    await request(app(f.actor)).get(url(foreign.companyId)).query({ ids: foreign.rows[0]!.id }).expect(403);
  });

  it("permits ordinary same-company agents and rejects task-bridge keys", async () => {
    const f = await fixture();
    const [agent] = await ctx.db.insert(agents).values({ companyId: f.companyId, name: "Reader", role: "engineer", adapterType: "process" }).returning();
    const actor: Express.Request["actor"] = { type: "agent", agentId: agent!.id, companyId: f.companyId, source: "agent_key" };
    const res = await request(app(actor)).get(url(f.companyId)).query({ ids: f.rows[0]!.id }).expect(200);
    expect(res.body).toHaveLength(1);
    await request(app({ ...actor, keyScope: { kind: "task_bridge", issueId: f.rows[0]!.id } } as Express.Request["actor"]))
      .get(url(f.companyId)).query({ ids: f.rows[0]!.id }).expect(403);
  });

  it("projects conversation readiness changes without advancing the task version", async () => {
    const f = await fixture();
    const [agent] = await ctx.db.insert(agents).values({ companyId: f.companyId, name: "Chat", role: "general", adapterType: "process" }).returning();
    const issue = f.rows[0]!;
    await ctx.db.update(issues).set({ status: "in_review", assigneeAgentId: agent!.id }).where(eq(issues.id, issue.id));
    const [application] = await ctx.db.insert(toolApplications).values({ companyId: f.companyId, name: "Slack", type: "native" }).returning();
    const connectionId = randomUUID();
    await ctx.db.insert(toolConnections).values({ id: connectionId, companyId: f.companyId, applicationId: application!.id, uid: connectionId, name: "Slack", transport: "chat_sdk", connectionPurpose: "channel" });
    const endpointId = randomUUID();
    await ctx.db.insert(chatEndpoints).values({ id: endpointId, companyId: f.companyId, connectionId, provider: "slack", publicId: endpointId, assignedAgentId: agent!.id, status: "active" });
    const [conversation] = await ctx.db.insert(chatConversations).values({ companyId: f.companyId, endpointId, issueId: issue.id, externalConversationId: "channel", externalThreadId: issue.id, externalLabel: "#summary-test", state: "waiting" }).returning();
    const read = () => request(app(f.actor)).get(url(f.companyId)).query({ ids: issue.id }).expect(200);
    const waiting = (await read()).body[0];
    expect(waiting.externalConversationState).toBe("waiting");
    expect((await issueServices.issueService(ctx.db).getById(issue.id))?.externalConversationState).toBe("waiting");
    await ctx.db.update(chatConversations).set({ state: "active" }).where(eq(chatConversations.id, conversation!.id));
    const active = (await read()).body[0];
    expect(active.externalConversationState).toBe("active");
    expect(active.updatedAt).toBe(waiting.updatedAt);
  });
});
