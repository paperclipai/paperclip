import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "@paperclipai/db/response-capture";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { captureRunIdentity, initializeRunIdentity, reserveSteeredIdentity } from "../services/run-identity.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("agent authentication identity transfer", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "identity-transfer-test-secret");
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    database = await startEmbeddedPostgresTestDatabase("paperclip-auth-identity-transfer-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  }, 60_000);

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Authentication transfer", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reader", role: "engineer", adapterType: "codex_local", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Authentication task", responsibleUserId: "owner" });
    const padding = "retained input ".repeat(32_768);
    const payloads = {
      contextSnapshot: { issueId, launchInput: padding },
      runnerProfileJson: { nativeExecutionInput: { savedInput: padding } },
      resultJson: { savedResult: padding }, stdoutExcerpt: padding, stderrExcerpt: padding,
    };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", ...payloads });
    const identity = await initializeRunIdentity(db, { companyId, runId, issueId, messageIds: [], responsibleUserId: "owner", cause: "instruction" });
    const app = express();
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    app.get("/actor", (req, res) => res.json(req.actor));
    app.patch("/actor", (req, res) => res.json(req.actor));
    app.use(errorHandler);
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "stale-user");
    expect(token).not.toBeNull();
    return { companyId, agentId, issueId, runId, app, token: token!, identity, payloads };
  }

  it("bounds actual middleware responses and preserves the complete stored run", async () => {
    const fixture = await seed();
    const events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { heartbeatRuns }, capture);
    try {
      const response = await request(fixture.app).get("/actor").set("Authorization", `Bearer ${fixture.token}`);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ type: "agent", runId: fixture.runId,
        identityContextId: fixture.identity.id, onBehalfOfUserId: "owner" });
    } finally { capture.flush(); }
    const reads = events.filter(event => event.event === "paperclip.db_response_capture.entry.v1"
      && event.table === "heartbeat_runs" && (event.operation === "select" || event.operation === "execute"));
    expect(reads.reduce((sum, event) => sum + Number(event.calls), 0)).toBeGreaterThanOrEqual(3);
    expect(reads.reduce((sum, event) => sum + Number(event.responseValueBytes), 0)).toBeLessThan(16_384);
    expect((await captureRunIdentity(db, fixture)).run).toMatchObject(fixture.payloads);
  });

  it("blocks uncertain steering, accepts its durable acknowledgement, and rechecks cancellation", async () => {
    const fixture = await seed(), messageId = randomUUID();
    await db.insert(issueComments).values({ id: messageId, companyId: fixture.companyId, issueId: fixture.issueId,
      authorUserId: "next-user", body: "Next instruction" });
    const pending = await reserveSteeredIdentity(db, { ...fixture, messageId });
    expect(pending).not.toBeNull();
    const blocked = await request(fixture.app).get("/actor").set("Authorization", `Bearer ${fixture.token}`);
    expect(blocked.status).toBe(409);
    await db.insert(heartbeatRunEvents).values({ companyId: fixture.companyId, agentId: fixture.agentId, runId: fixture.runId,
      seq: 1, eventType: "item.completed", sourceEventId: randomUUID(),
      payload: { prpEvent: { turnId: "auth-turn", itemId: `auth-turn:steer:${messageId}`,
        payload: { kind: "steering_acknowledgement" } } } });
    const accepted = await request(fixture.app).get("/actor").set("Authorization", `Bearer ${fixture.token}`);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ identityContextId: pending!.id, onBehalfOfUserId: "next-user" });
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, fixture.runId));
    const revoked = await request(fixture.app).patch("/actor").set("Authorization", `Bearer ${fixture.token}`);
    expect(revoked.status).toBe(403);
    expect(revoked.body.code).toBe("agent_run_cancelled");
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(stored).toMatchObject(fixture.payloads);
  });

  it.each(["company", "agent", "missing", "finished"] as const)("rejects %s run identity for the compact scope", async (fault) => {
    const fixture = await seed();
    if (fault === "finished") await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, fixture.runId));
    const input = { companyId: fault === "company" ? randomUUID() : fixture.companyId,
      agentId: fault === "agent" ? randomUUID() : fixture.agentId,
      runId: fault === "missing" ? randomUUID() : fixture.runId };
    await expect(captureRunIdentity(db, input, { readScope: "request_authentication" })).rejects.toThrow(/active run/);
  });
});
