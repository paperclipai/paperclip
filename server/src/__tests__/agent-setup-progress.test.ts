import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { activityLog, agentSetupProgress, companies, companyMemberships, createDb, principalPermissionGrants, toolApplications, toolConnections } from "@paperclipai/db";
import { AGENT_SETUP_PROGRESS_LIMITS, type AgentSetupProgressHandoff, type LiveEvent } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentSetupProgressAgentRoutes, agentSetupProgressBoardRoutes } from "../routes/agent-setup-progress.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { agentSetupProgressService } from "../services/agent-setup-progress.js";
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
    const [application] = await db.insert(toolApplications).values({ companyId: row!.id, name: "AWS", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: row!.id, applicationId: application!.id, name: "AWS", uid: `aws-${randomUUID()}`, transport: "mcp_remote", createdByUserId: userId,
    }).returning();
    return { ...row!, connectionId: connection!.id, applicationId: application!.id };
  }

  /** The real app splits these: the agent's routes need no sign-in, the board's do. */
  function app(boardCompanyIds: string[], actorUserId = userId) {
    const server = express();
    server.use(express.json());
    server.use(agentSetupProgressAgentRoutes(db));
    const api = express.Router();
    api.use((req, _res, next) => {
      req.actor = { type: "board", userId: actorUserId, source: "session", companyIds: boardCompanyIds, isInstanceAdmin: false } as Express.Request["actor"];
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
      .send({ purpose: "aws_connection", subjectId: org.connectionId }).expect(201);
    const handoff = created.body as AgentSetupProgressHandoff;
    expect(handoff.progress).toMatchObject({ status: "waiting", items: [], purpose: "aws_connection", subjectId: org.connectionId });
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
    // A detail is kept when omitted and cleared with null, so a retry can drop an earlier error.
    const keptDetail = await request(server).post(item("check-account")).set(auth).send({ status: "done" }).expect(200);
    expect(keptDetail.body.items[0].detail).toBe("Account 123456789012");
    await request(server).post(item("deploy-stack")).set(auth).send({ status: "failed", detail: "Access denied" }).expect(200);
    const cleared = await request(server).post(item("deploy-stack")).set(auth).send({ status: "in_progress", detail: null }).expect(200);
    expect(cleared.body.items[1].detail).toBeNull();
    const ticked = await request(server).post(item("deploy-stack")).set(auth).send({ status: "done" }).expect(200);
    expect(ticked.body.status).toBe("in_progress");
    const finished = await request(server).post(path(handoff.urls.finish)).set(auth)
      .send({ status: "done", summary: "Role ARN: arn:aws:iam::123456789012:role/paperclip-conn-1" }).expect(200);
    // Finishing done ticks off what is left.
    expect(finished.body).toMatchObject({ status: "done", summary: "Role ARN: arn:aws:iam::123456789012:role/paperclip-conn-1",
      items: [{ status: "done" }, { status: "done" }] });
    stop();
    const progressEvents = events.filter((event) => event.type === "agent_setup_progress.updated");
    expect(progressEvents).toHaveLength(8);
    expect(progressEvents.every((event) => event.payload.progressId === handoff.progress.id)).toBe(true);

    const read = await request(server).get(`/api/agent-setup-progress/${handoff.progress.id}`).expect(200);
    expect(read.body.status).toBe("done");
    const actions = (await db.select().from(activityLog).where(eq(activityLog.entityId, handoff.progress.id))).map((row) => row.action).sort();
    // Every change is on the activity history, and no entry holds the token.
    expect(actions).toEqual([
      "agent_setup_progress.created", "agent_setup_progress.finished",
      "agent_setup_progress.item_updated", "agent_setup_progress.item_updated", "agent_setup_progress.item_updated",
      "agent_setup_progress.item_updated", "agent_setup_progress.item_updated", "agent_setup_progress.item_updated",
      "agent_setup_progress.started",
    ]);
    const history = await db.select().from(activityLog).where(eq(activityLog.entityId, handoff.progress.id));
    expect(JSON.stringify(history)).not.toContain(handoff.token);
  });

  it("refuses a missing or wrong token, an unknown item, an expired checklist and too many updates", async () => {
    const org = await company();
    const server = app([org.id]);
    const handoff = (await request(server).post(`/api/companies/${org.id}/agent-setup-progress`).send({ purpose: "aws_connection", subjectId: org.connectionId }).expect(201)).body as AgentSetupProgressHandoff;
    const checklist = path(handoff.urls.checklist);
    const items = { items: [{ key: "step-1", title: "Step one" }] };
    await request(server).put(checklist).send(items).expect(401);
    await request(server).put(checklist).set({ Authorization: "Bearer pcsp_wrong" }).send(items).expect(401);
    // A real token for another checklist opens nothing else.
    const other = (await request(server).post(`/api/companies/${org.id}/agent-setup-progress`).send({ purpose: "aws_connection", subjectId: org.connectionId }).expect(201)).body as AgentSetupProgressHandoff;
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

  it("finishes as failed, keeps finished final, never loses a concurrent update, and cleans up old checklists", async () => {
    const org = await company();
    const server = app([org.id]);
    const create = async () => (await request(server).post(`/api/companies/${org.id}/agent-setup-progress`).send({ purpose: "aws_connection", subjectId: org.connectionId }).expect(201)).body as AgentSetupProgressHandoff;
    const handoff = await create();
    const auth = { Authorization: `Bearer ${handoff.token}` };
    const item = (key: string) => path(handoff.urls.item.replace("{key}", key));
    await request(server).put(path(handoff.urls.checklist)).set(auth).send({ items: [
      { key: "a", title: "A" }, { key: "b", title: "B" }, { key: "c", title: "C" },
    ] }).expect(200);

    // Concurrent writes either land or answer 409 to be sent again: none is silently lost.
    const results = await Promise.all(["a", "b", "c"].map((key) => request(server).post(item(key)).set(auth).send({ status: "in_progress" })));
    expect(results.every((res) => res.status === 200 || res.status === 409)).toBe(true);
    const [afterRace] = await db.select().from(agentSetupProgress).where(eq(agentSetupProgress.id, handoff.progress.id));
    expect(afterRace!.updateCount).toBe(1 + results.filter((res) => res.status === 200).length);
    expect(afterRace!.items.filter((entry) => entry.status === "in_progress")).toHaveLength(results.filter((res) => res.status === 200).length);

    await request(server).post(item("b")).set(auth).send({ status: "failed", detail: "No permission" }).expect(200);
    const failed = await request(server).post(path(handoff.urls.finish)).set(auth).send({ status: "failed", summary: "Stopped: no permission" }).expect(200);
    expect(failed.body).toMatchObject({ status: "failed", summary: "Stopped: no permission" });
    expect(failed.body.items.find((entry: { key: string }) => entry.key === "b")).toMatchObject({ status: "failed", detail: "No permission" });
    // A late or retried write cannot reopen a finished setup.
    const late = await request(server).post(item("a")).set(auth).send({ status: "done" }).expect(409);
    expect(late.body.details).toMatchObject({ code: "agent_setup_progress_finished" });
    await request(server).post(path(handoff.urls.finish)).set(auth).send({ status: "done" }).expect(409);

    // Finishing done is the agent's verdict: every step is ticked off, including one that failed along the way.
    const second = await create();
    const auth2 = { Authorization: `Bearer ${second.token}` };
    await request(server).put(path(second.urls.checklist)).set(auth2).send({ items: [{ key: "a", title: "A" }, { key: "b", title: "B" }] }).expect(200);
    await request(server).post(path(second.urls.item.replace("{key}", "a"))).set(auth2).send({ status: "failed" }).expect(200);
    const done = await request(server).post(path(second.urls.finish)).set(auth2).send({ status: "done" }).expect(200);
    expect(done.body.items.map((entry: { status: string }) => entry.status)).toEqual(["done", "done"]);

    // Checklists a day past expiry are removed as new ones are created; recent ones stay.
    await db.update(agentSetupProgress).set({ expiresAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(agentSetupProgress.id, handoff.progress.id));
    await db.update(agentSetupProgress).set({ expiresAt: new Date(Date.now() - 3600_000) }).where(eq(agentSetupProgress.id, second.progress.id));
    // Another company's long-expired checklist is never touched by this company's cleanup.
    const other = await company();
    const foreign = (await request(app([other.id])).post(`/api/companies/${other.id}/agent-setup-progress`).send({ purpose: "aws_connection", subjectId: other.connectionId }).expect(201)).body as AgentSetupProgressHandoff;
    await db.update(agentSetupProgress).set({ expiresAt: new Date(Date.now() - 48 * 3600_000) }).where(eq(agentSetupProgress.id, foreign.progress.id));
    await create();
    expect(await db.select().from(agentSetupProgress).where(eq(agentSetupProgress.id, foreign.progress.id))).toHaveLength(1);
    expect(await db.select().from(agentSetupProgress).where(eq(agentSetupProgress.id, handoff.progress.id))).toHaveLength(0);
    expect(await db.select().from(agentSetupProgress).where(eq(agentSetupProgress.id, second.progress.id))).toHaveLength(1);
  });

  it("clears long-expired checklists across companies once at startup, and keeps the rest", async () => {
    const first = await company();
    const second = await company();
    const make = async (org: Awaited<ReturnType<typeof company>>) => ((await request(app([org.id])).post(`/api/companies/${org.id}/agent-setup-progress`)
      .send({ purpose: "aws_connection", subjectId: org.connectionId }).expect(201)).body as AgentSetupProgressHandoff).progress.id;
    const oldA = await make(first);
    const oldB = await make(second);
    const recent = await make(second);
    await db.update(agentSetupProgress).set({ expiresAt: new Date(Date.now() - 48 * 3600_000) }).where(inArray(agentSetupProgress.id, [oldA, oldB]));
    await db.update(agentSetupProgress).set({ expiresAt: new Date(Date.now() - 3600_000) }).where(eq(agentSetupProgress.id, recent));
    // Batches of one: the sweep keeps going until no old checklist is left, not just one batch.
    expect(await agentSetupProgressService(db).sweepExpired({ batchSize: 1 })).toBeGreaterThanOrEqual(2);
    const left = (await db.select({ id: agentSetupProgress.id }).from(agentSetupProgress).where(inArray(agentSetupProgress.id, [oldA, oldB, recent]))).map((row) => row.id);
    expect(left).toEqual([recent]);
  });

  it("does not let a cache keep the agent's token", async () => {
    const org = await company();
    const res = await request(app([org.id])).post(`/api/companies/${org.id}/agent-setup-progress`).send({ purpose: "aws_connection", subjectId: org.connectionId }).expect(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers.pragma).toBe("no-cache");
  });

  it("keeps checklists inside their company", async () => {
    const org = await company();
    const outsider = await company();
    const handoff = (await request(app([org.id])).post(`/api/companies/${org.id}/agent-setup-progress`).send({ purpose: "aws_connection", subjectId: org.connectionId }).expect(201)).body as AgentSetupProgressHandoff;
    // Another company's checklist answers exactly like a missing one.
    const hidden = await request(app([outsider.id])).get(`/api/agent-setup-progress/${handoff.progress.id}`).expect(404);
    const missing = await request(app([outsider.id])).get(`/api/agent-setup-progress/${randomUUID()}`).expect(404);
    expect(hidden.body).toEqual(missing.body);
    await request(app([outsider.id])).post(`/api/companies/${org.id}/agent-setup-progress`).send({ purpose: "aws_connection", subjectId: org.connectionId }).expect(403);

    // Inside the company: only someone who may configure the connection starts its setup,
    // and only the person who started it reads the checklist back.
    const viewerId = `viewer-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId: org.id, principalType: "user", principalId: viewerId, status: "active", membershipRole: "viewer" });
    await request(app([org.id], viewerId)).post(`/api/companies/${org.id}/agent-setup-progress`).send({ purpose: "aws_connection", subjectId: org.connectionId }).expect(403);
    // A manager whose permission covers just this connection may set it up; one scoped to another connection may not.
    const scopedId = `scoped-${randomUUID()}`;
    const elsewhereId = `elsewhere-${randomUUID()}`;
    const [otherConnection] = await db.insert(toolConnections).values({
      companyId: org.id, applicationId: org.applicationId, name: "Other", uid: `other-${randomUUID()}`, transport: "mcp_remote", createdByUserId: userId,
    }).returning();
    await db.insert(companyMemberships).values([scopedId, elsewhereId].map((principalId) => ({ companyId: org.id, principalType: "user", principalId, status: "active", membershipRole: "member" })));
    await db.insert(principalPermissionGrants).values([
      { companyId: org.id, principalType: "user", principalId: scopedId, permissionKey: "tools:manage_connections", scope: { connectionIds: [org.connectionId] } },
      { companyId: org.id, principalType: "user", principalId: elsewhereId, permissionKey: "tools:manage_connections", scope: { connectionIds: [otherConnection!.id] } },
    ]);
    await request(app([org.id], scopedId)).post(`/api/companies/${org.id}/agent-setup-progress`).send({ purpose: "aws_connection", subjectId: org.connectionId }).expect(201);
    await request(app([org.id], elsewhereId)).post(`/api/companies/${org.id}/agent-setup-progress`).send({ purpose: "aws_connection", subjectId: org.connectionId }).expect(403);
    const otherMember = await request(app([org.id], viewerId)).get(`/api/agent-setup-progress/${handoff.progress.id}`).expect(404);
    expect(otherMember.body).toEqual(missing.body);
    const own = await request(app([org.id])).get(`/api/agent-setup-progress/${handoff.progress.id}`).expect(200);
    expect(own.body.createdByUserId).toBeUndefined();
    // A checklist always names a real connection of this company.
    await request(app([org.id])).post(`/api/companies/${org.id}/agent-setup-progress`).send({ purpose: "aws_connection" }).expect(422);
    await request(app([org.id])).post(`/api/companies/${org.id}/agent-setup-progress`).send({ purpose: "aws_connection", subjectId: outsider.connectionId }).expect(404);
    // A malformed id is a clean not-found, never a server error.
    await request(app([org.id])).post(`/api/companies/${org.id}/agent-setup-progress`).send({ purpose: "aws_connection", subjectId: "abc" }).expect(404);
  });
});
