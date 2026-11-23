import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { activityLog, agentSetupProgress, companies, companyMemberships, createDb } from "@paperclipai/db";
import { AGENT_SETUP_PROGRESS_LIMITS, type AgentSetupProgressHandoff, type LiveEvent } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentSetupProgressAgentRoutes, agentSetupProgressBoardRoutes } from "../routes/agent-setup-progress.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { errorHandler } from "../middleware/error-handler.js";

const userId = "setup-progress-user";

describe("agent setup progress", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://acme.paperclip.app");
    fixture = await startEmbeddedPostgresTestDatabase("agent-setup-progress-");
    db = createDb(fixture.connectionString);
  }, 120_000);
  afterAll(async () => {
    await fixture?.cleanup();
    vi.unstubAllEnvs();
  });

  async function company() {
    const [row] = await db.insert(companies).values({ name: `Setup ${randomUUID()}`, issuePrefix: `S${randomUUID().slice(0, 5)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: row!.id, principalType: "user", principalId: userId, status: "active", membershipRole: "admin" });
    return row!;
  }

  /** The real app splits these: the agent's routes need no sign-in, the board's do. */
  function app(boardCompanyIds: string[]) {
    const server = express();
    server.use(express.json());
    server.use(agentSetupProgressAgentRoutes(db));
    const api = express.Router();
    api.use((req, _res, next) => {
      req.actor = { type: "board", userId, source: "session", companyIds: boardCompanyIds, isInstanceAdmin: false } as Express.Request["actor"];
      next();
    });
    api.use(agentSetupProgressBoardRoutes(db));
    server.use("/api", api);
    server.use(errorHandler);
    return server;
  }

  const path = (url: string) => new URL(url).pathname;

  it("lets the agent set and tick off its checklist with the prompt's token, live, then finish", async () => {
    const org = await company();
    const server = app([org.id]);
    const created = await request(server).post(`/api/companies/${org.id}/agent-setup-progress`)
      .send({ purpose: "aws_connection", subjectId: "conn-1" }).expect(201);
    const handoff = created.body as AgentSetupProgressHandoff;
    expect(handoff.progress).toMatchObject({ status: "waiting", items: [], purpose: "aws_connection", subjectId: "conn-1" });
    expect(handoff.urls.checklist).toBe(`https://acme.paperclip.app/api/agent-setup-progress/${handoff.progress.id}/checklist`);
    expect(handoff.urls.item).toContain("/items/{key}");
    expect(handoff.token).toMatch(/^pcsp_/);
    // Only the token's hash is stored.
    const [stored] = await db.select().from(agentSetupProgress).where(eq(agentSetupProgress.id, handoff.progress.id));
    expect(stored!.tokenHash).not.toContain(handoff.token);

    const events: LiveEvent[] = [];
    const stop = subscribeCompanyLiveEvents(org.id, (event) => events.push(event));
    const auth = { Authorization: `Bearer ${handoff.token}` };
    await request(server).put(path(handoff.urls.checklist)).set(auth).send({ items: [
      { key: "check-account", title: "Check the AWS account" },
      { key: "deploy-stack", title: "Create the role" },
    ] }).expect(200);
    const item = (key: string) => path(handoff.urls.item.replace("{key}", key));
    await request(server).post(item("check-account")).set(auth).send({ status: "done", detail: "Account 123456789012" }).expect(200);
    const working = await request(server).post(item("deploy-stack")).set(auth).send({ status: "in_progress" }).expect(200);
    expect(working.body).toMatchObject({ status: "in_progress", items: [
      { key: "check-account", status: "done", detail: "Account 123456789012" },
      { key: "deploy-stack", status: "in_progress", detail: null },
    ] });
    // Every step ticked off is still in progress: only the finish carries the summary, and the page keeps refreshing until it.
    const ticked = await request(server).post(item("deploy-stack")).set(auth).send({ status: "done" }).expect(200);
    expect(ticked.body.status).toBe("in_progress");
    const finished = await request(server).post(path(handoff.urls.finish)).set(auth)
      .send({ status: "done", summary: "Role ARN: arn:aws:iam::123456789012:role/paperclip-conn-1" }).expect(200);
    // Finishing done ticks off what is left.
    expect(finished.body).toMatchObject({ status: "done", summary: "Role ARN: arn:aws:iam::123456789012:role/paperclip-conn-1",
      items: [{ status: "done" }, { status: "done" }] });
    stop();
    const progressEvents = events.filter((event) => event.type === "agent_setup_progress.updated");
    expect(progressEvents).toHaveLength(5);
    expect(progressEvents.every((event) => event.payload.progressId === handoff.progress.id)).toBe(true);

    const read = await request(server).get(`/api/agent-setup-progress/${handoff.progress.id}`).expect(200);
    expect(read.body.status).toBe("done");
    const actions = (await db.select().from(activityLog).where(eq(activityLog.entityId, handoff.progress.id))).map((row) => row.action).sort();
    // Every change is on the activity history, and no entry holds the token.
    expect(actions).toEqual([
      "agent_setup_progress.created", "agent_setup_progress.finished",
      "agent_setup_progress.item_updated", "agent_setup_progress.item_updated", "agent_setup_progress.item_updated",
      "agent_setup_progress.started",
    ]);
    const history = await db.select().from(activityLog).where(eq(activityLog.entityId, handoff.progress.id));
    expect(JSON.stringify(history)).not.toContain(handoff.token);
  });

  it("refuses a missing or wrong token, an unknown item, an expired checklist and too many updates", async () => {
    const org = await company();
    const server = app([org.id]);
    const handoff = (await request(server).post(`/api/companies/${org.id}/agent-setup-progress`).send({ purpose: "aws_connection" }).expect(201)).body as AgentSetupProgressHandoff;
    const checklist = path(handoff.urls.checklist);
    const items = { items: [{ key: "step-1", title: "Step one" }] };
    await request(server).put(checklist).send(items).expect(401);
    await request(server).put(checklist).set({ Authorization: "Bearer pcsp_wrong" }).send(items).expect(401);
    // A real token for another checklist opens nothing else.
    const other = (await request(server).post(`/api/companies/${org.id}/agent-setup-progress`).send({ purpose: "aws_connection" }).expect(201)).body as AgentSetupProgressHandoff;
    await request(server).put(checklist).set({ Authorization: `Bearer ${other.token}` }).send(items).expect(401);

    const auth = { Authorization: `Bearer ${handoff.token}` };
    await request(server).put(checklist).set(auth).send({ items: [{ key: "Bad Key", title: "x" }] }).expect(400);
    await request(server).put(checklist).set(auth).send(items).expect(200);
    await request(server).post(path(handoff.urls.item.replace("{key}", "nope"))).set(auth).send({ status: "done" }).expect(404);

    await db.update(agentSetupProgress).set({ updateCount: AGENT_SETUP_PROGRESS_LIMITS.maxUpdates }).where(eq(agentSetupProgress.id, handoff.progress.id));
    await request(server).put(checklist).set(auth).send(items).expect(429);
    await db.update(agentSetupProgress).set({ updateCount: 0, expiresAt: new Date(Date.now() - 1000) }).where(eq(agentSetupProgress.id, handoff.progress.id));
    await request(server).put(checklist).set(auth).send(items).expect(410);
  });

  it("keeps checklists inside their company", async () => {
    const org = await company();
    const outsider = await company();
    const handoff = (await request(app([org.id])).post(`/api/companies/${org.id}/agent-setup-progress`).send({ purpose: "aws_connection" }).expect(201)).body as AgentSetupProgressHandoff;
    // Another company's checklist answers exactly like a missing one.
    const hidden = await request(app([outsider.id])).get(`/api/agent-setup-progress/${handoff.progress.id}`).expect(404);
    const missing = await request(app([outsider.id])).get(`/api/agent-setup-progress/${randomUUID()}`).expect(404);
    expect(hidden.body).toEqual(missing.body);
    await request(app([outsider.id])).post(`/api/companies/${org.id}/agent-setup-progress`).send({ purpose: "aws_connection" }).expect(403);
  });
});
