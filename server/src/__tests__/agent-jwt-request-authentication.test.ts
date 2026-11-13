import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  runIdentityContexts,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { meterDatabaseStatements } from "./helpers/database-statement-meter.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { acceptSteeredIdentity, initializeRunIdentity, prepareSteeredIdentity, reserveSteeredIdentity } from "../services/run-identity.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("agent JWT request authentication", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let meter: ReturnType<typeof meterDatabaseStatements>;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "request-authentication-test-secret");
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    database = await startEmbeddedPostgresTestDatabase("paperclip-agent-jwt-request-auth-");
    db = createDb(database.connectionString);
    meter = meterDatabaseStatements(db, database.connectionString);
  }, 30_000);

  afterAll(async () => {
    meter?.uninstall();
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  }, 60_000);

  async function addUser(companyId: string, userId: string) {
    await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@example.test`, emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "owner" });
  }

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const owner = `owner-${companyId.slice(0, 8)}`, next = `next-${companyId.slice(0, 8)}`;
    await db.insert(companies).values({ id: companyId, name: "Request authentication", issuePrefix: companyId.slice(0, 8) });
    await addUser(companyId, owner);
    await addUser(companyId, next);
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", adapterType: "codex_local",
      status: "running", adapterConfig: { instructions: "saved ".repeat(20_000) } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Request authentication task", responsibleUserId: owner });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
    const identity = await initializeRunIdentity(db, { companyId, runId, issueId, messageIds: [], responsibleUserId: owner,
      cause: "instruction" });
    const app = express();
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    app.get("/actor", (req, res) => res.json(req.actor));
    app.patch("/actor", (req, res) => res.json(req.actor));
    app.use(errorHandler);
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "stale-claim-user")!;
    expect(token).toBeTruthy();
    return { companyId, agentId, issueId, runId, owner, next, identity, app, token };
  }

  type Fixture = Awaited<ReturnType<typeof seed>>;
  const get = (f: Fixture, token = f.token) => request(f.app).get("/actor").set("Authorization", `Bearer ${token}`);
  const patch = (f: Fixture, token = f.token) => request(f.app).patch("/actor").set("Authorization", `Bearer ${token}`);

  it("authenticates a running agent with three statements and no transaction", async () => {
    const f = await seed();
    const before = meter.read();
    meter.startLog();
    const response = await get(f);
    const log = meter.stopLog();
    const after = meter.read();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      type: "agent", source: "agent_jwt", agentId: f.agentId, companyId: f.companyId, runId: f.runId,
      identityContextId: f.identity.id, onBehalfOfUserId: f.owner,
      onBehalfOfMemberships: [{ companyId: f.companyId, membershipRole: "owner", status: "active" }],
    });
    const statements = after.statements - before.statements;
    expect({ statements, transactions: after.transactions - before.transactions, waits: after.waits - before.waits },
      log.map(entry => entry.sql).join("\n---\n")).toEqual({ statements: 3, transactions: 0, waits: 3 });
    expect(after.bytesReceived - before.bytesReceived).toBeLessThan(8_192);
  });

  it("refuses the very next write after the run is cancelled, stopped or superseded", async () => {
    const cases: Array<{ revoke: Partial<typeof heartbeatRuns.$inferInsert>; code: string }> = [
      { revoke: { status: "cancelled" }, code: "agent_run_cancelled" },
      { revoke: { resultJson: { executionCancellation: { state: "requested" } } }, code: "agent_run_cancelled" },
      { revoke: { resultJson: { freshContinuationSupersededAt: new Date().toISOString() } }, code: "agent_run_superseded" },
    ];
    for (const { revoke, code } of cases) {
      const f = await seed();
      expect((await patch(f)).status).toBe(200);
      await db.update(heartbeatRuns).set(revoke).where(eq(heartbeatRuns.id, f.runId));
      const refused = await patch(f);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe(code);
    }
  });

  it("uses the new responsible user on the request after steering is accepted", async () => {
    const f = await seed();
    expect((await get(f)).body).toMatchObject({ identityContextId: f.identity.id, onBehalfOfUserId: f.owner });
    const messageId = randomUUID();
    await db.insert(issueComments).values({ id: messageId, companyId: f.companyId, issueId: f.issueId,
      authorUserId: f.next, body: "Next instruction" });
    const pending = (await reserveSteeredIdentity(db, { ...f, messageId }))!;
    await db.transaction(tx => acceptSteeredIdentity(tx as never, pending));
    const second = await get(f);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ identityContextId: pending.id, onBehalfOfUserId: f.next });
  });

  function holdOpen(f: Fixture, work: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<unknown>) {
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let ready!: () => void;
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const done = db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("no key update");
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)).for("no key update");
      await work(tx);
      ready();
      await released;
    });
    const holding = Promise.race([locked, done.then(() => undefined)]);
    return { holding, release, done };
  }

  const settledWithin = <T,>(promise: Promise<T>, ms: number) =>
    Promise.race([promise, new Promise<"pending">(resolve => setTimeout(() => resolve("pending"), ms))]);

  async function acknowledge(f: Fixture, messageId: string) {
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId, runId: f.runId,
      seq: 1, eventType: "item.completed", sourceEventId: randomUUID(),
      payload: { prpEvent: { turnId: "auth-turn", itemId: `auth-turn:steer:${messageId}`,
        payload: { kind: "steering_acknowledgement" } } } });
  }

  it("does not wait on an uncommitted steering reservation and holds the next request until it is acknowledged", async () => {
    const f = await seed();
    const messageId = randomUUID();
    await db.insert(issueComments).values({ id: messageId, companyId: f.companyId, issueId: f.issueId,
      authorUserId: f.next, body: "Concurrent instruction" });
    let pendingId = "";
    const writer = holdOpen(f, async tx => {
      pendingId = (await prepareSteeredIdentity(tx as never, { ...f, messageId })).id;
    });
    await writer.holding;
    try {
      const during = await settledWithin(get(f), 3_000);
      expect(during).not.toBe("pending");
      expect((during as request.Response).status).toBe(200);
      expect((during as request.Response).body).toMatchObject({ identityContextId: f.identity.id, onBehalfOfUserId: f.owner });
    } finally {
      writer.release();
      await writer.done;
    }
    expect((await get(f)).status).toBe(409);
    await acknowledge(f, messageId);
    expect((await get(f)).body).toMatchObject({ identityContextId: pendingId, onBehalfOfUserId: f.next });
  });

  it("waits for an acceptance in flight and returns the identity it commits", async () => {
    const f = await seed();
    const messageId = randomUUID();
    await db.insert(issueComments).values({ id: messageId, companyId: f.companyId, issueId: f.issueId,
      authorUserId: f.next, body: "Accepted instruction" });
    const pending = (await reserveSteeredIdentity(db, { ...f, messageId }))!;
    const writer = holdOpen(f, tx => acceptSteeredIdentity(tx as never, pending));
    await writer.holding;
    const response = get(f).then(result => result);
    try {
      expect(await settledWithin(response, 500)).toBe("pending");
    } finally {
      writer.release();
      await writer.done;
    }
    expect((await response).body).toMatchObject({ identityContextId: pending.id, onBehalfOfUserId: f.next });
  });

  it("keeps the identity of the run the token names, in the company and for the agent it names", async () => {
    const f = await seed();
    const other = await seed();
    const crossCompany = createLocalAgentJwt(other.agentId, f.companyId, "codex_local", other.runId, f.owner)!;
    expect((await get(f, crossCompany)).status).toBe(401);
    const foreignRun = createLocalAgentJwt(f.agentId, f.companyId, "codex_local", other.runId, null)!;
    const foreign = await get(f, foreignRun);
    expect(foreign.status).toBe(200);
    expect(foreign.body).toMatchObject({ runId: other.runId, identityContextId: null, onBehalfOfUserId: null,
      onBehalfOfMemberships: [] });
    await db.update(heartbeatRuns).set({ activeIdentityContextId: other.identity.id }).where(eq(heartbeatRuns.id, f.runId));
    const mismatched = await get(f);
    expect(mismatched.body).toMatchObject({ identityContextId: null, onBehalfOfUserId: "stale-claim-user" });
    const [context] = await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.id, other.identity.id));
    expect(context.runId).toBe(other.runId);
  });

  it("still settles a pending steering identity through the locked capture", async () => {
    const f = await seed();
    const messageId = randomUUID();
    await db.insert(issueComments).values({ id: messageId, companyId: f.companyId, issueId: f.issueId,
      authorUserId: f.next, body: "Pending instruction" });
    await reserveSteeredIdentity(db, { ...f, messageId });
    expect((await get(f)).status).toBe(409);
  });
});
