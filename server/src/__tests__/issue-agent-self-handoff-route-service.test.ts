import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("agent self-handoff route/service contract", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-agent-self-handoff-route-");
    db = createDb(temporary.connectionString, { maxConnections: 4 });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Agent hand-off", issuePrefix: `H${companyId.slice(0, 6)}` });
    const [owner] = await db.insert(agents).values({ companyId, name: "Owner", role: "engineer", adapterType: "process", status: "active" }).returning();
    const [peer] = await db.insert(agents).values({ companyId, name: "Peer", role: "engineer", adapterType: "process", status: "active" }).returning();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: owner!.id, status: "running", invocationSource: "assignment",
      startedAt: new Date(), contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Hand me off", status: "in_progress", assigneeAgentId: owner!.id,
      checkoutRunId: runId, executionRunId: runId, executionLockedAt: new Date(),
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: owner!.id, companyId, runId, source: "agent_jwt" } as typeof req.actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return { app, issueId, runId, peerId: peer!.id };
  }

  it("keeps the outgoing run, lets it comment, and refuses its later task changes", async () => {
    const { app, issueId, runId, peerId } = await fixture();

    const handoff = await request(app).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: peerId, status: "todo" });
    expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run).toMatchObject({ status: "running" });
    expect(run!.contextSnapshot).toMatchObject({ agentSelfHandoff: { issueId, toAgentId: peerId } });

    const comment = await request(app).patch(`/api/issues/${issueId}`).send({ comment: "Handed to the peer agent." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(200);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toEqual(
      expect.arrayContaining([expect.objectContaining({ body: "Handed to the peer agent." })]),
    );

    for (const late of [{ title: "Late outgoing edit" }, { status: "done" }, { assigneeAgentId: run!.agentId }]) {
      const res = await request(app).patch(`/api/issues/${issueId}`).send(late);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details).toMatchObject({ code: "issue_handed_off" });
    }
    expect(await issueService(db).getById(issueId)).toMatchObject({
      title: "Hand me off", status: "todo", assigneeAgentId: peerId,
    });
  });
});
