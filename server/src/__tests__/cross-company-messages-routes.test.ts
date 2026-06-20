import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentMemberships,
  agents,
  companies,
  companyMemberships,
  createDb,
  crossCompanyMessages,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { crossCompanyMessageRoutes } from "../routes/cross-company-messages.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres cross-company message tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function createApp(db: ReturnType<typeof createDb>, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", crossCompanyMessageRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("cross-company message routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-company-mail-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(crossCompanyMessages);
    await db.delete(agentMemberships);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const sourceCompanyId = randomUUID();
    const destinationCompanyId = randomUUID();
    const deniedCompanyId = randomUUID();
    const sourceAgentId = randomUUID();
    const destinationAgentId = randomUUID();
    const deniedAgentId = randomUUID();
    const sharedUserId = "user-1";

    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "Mission Control",
        issuePrefix: `S${sourceCompanyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: destinationCompanyId,
        name: "OpCo",
        issuePrefix: `D${destinationCompanyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: deniedCompanyId,
        name: "Denied",
        issuePrefix: `X${deniedCompanyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: sourceAgentId,
        companyId: sourceCompanyId,
        name: "MC Sender",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: destinationAgentId,
        companyId: destinationCompanyId,
        name: "OpCo Receiver",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: deniedAgentId,
        companyId: deniedCompanyId,
        name: "Denied Receiver",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(companyMemberships).values([
      {
        companyId: sourceCompanyId,
        principalType: "user",
        principalId: sharedUserId,
        status: "active",
        membershipRole: "owner",
      },
      {
        companyId: destinationCompanyId,
        principalType: "user",
        principalId: sharedUserId,
        status: "active",
        membershipRole: "owner",
      },
    ]);

    await db.insert(agentMemberships).values([
      {
        companyId: sourceCompanyId,
        agentId: sourceAgentId,
        userId: sharedUserId,
        state: "joined",
      },
    ]);

    return {
      sourceCompanyId,
      destinationCompanyId,
      deniedCompanyId,
      sourceAgentId,
      destinationAgentId,
      deniedAgentId,
    };
  }

  it("enqueues idempotently and lists the outbox for the source company", async () => {
    const { sourceCompanyId, destinationCompanyId, sourceAgentId } = await seed();
    const app = createApp(db, {
      type: "agent",
      agentId: sourceAgentId,
      companyId: sourceCompanyId,
      source: "agent_key",
    });

    const body = {
      destinationCompanyId,
      messageType: "directive.dispatch",
      payload: { directiveId: "dir-1", action: "sync" },
    };

    const first = await request(app)
      .post("/api/outbox")
      .set("Idempotency-Key", "dispatch-1")
      .send(body);
    const second = await request(app)
      .post("/api/outbox")
      .set("Idempotency-Key", "dispatch-1")
      .send(body);
    const outbox = await request(app).get("/api/outbox");

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.cursor).toBe(first.body.cursor);
    expect(outbox.status).toBe(200);
    expect(outbox.body.items).toHaveLength(1);
    expect(outbox.body.items[0]).toMatchObject({
      sourceCompanyId,
      destinationCompanyId,
      messageType: "directive.dispatch",
    });

    await expect(db.select().from(crossCompanyMessages)).resolves.toHaveLength(1);
  });

  it("replays inbox messages until they are acked", async () => {
    const { sourceCompanyId, destinationCompanyId, sourceAgentId, destinationAgentId } = await seed();
    const sender = createApp(db, {
      type: "agent",
      agentId: sourceAgentId,
      companyId: sourceCompanyId,
      source: "agent_key",
    });
    const receiver = createApp(db, {
      type: "agent",
      agentId: destinationAgentId,
      companyId: destinationCompanyId,
      source: "agent_key",
    });

    const created = await request(sender)
      .post("/api/outbox")
      .set("Idempotency-Key", "dispatch-2")
      .send({
        destinationCompanyId,
        messageType: "directive.dispatch",
        payload: { directiveId: "dir-2" },
      });

    const firstInbox = await request(receiver).get("/api/inbox");
    const replayInbox = await request(receiver).get(`/api/inbox?after=${created.body.cursor}`);
    const ack = await request(receiver).post(`/api/inbox/${created.body.id}/ack`);
    const postAckInbox = await request(receiver).get(`/api/inbox?after=${created.body.cursor}`);

    expect(firstInbox.status).toBe(200);
    expect(firstInbox.body.items).toHaveLength(1);
    expect(replayInbox.status).toBe(200);
    expect(replayInbox.body.items).toHaveLength(1);
    expect(replayInbox.body.items[0].id).toBe(created.body.id);
    expect(ack.status).toBe(200);
    expect(ack.body.ackedAt).toBeTruthy();
    expect(postAckInbox.status).toBe(200);
    expect(postAckInbox.body.items).toHaveLength(0);
    expect(postAckInbox.body.nextCursor).toBe(created.body.cursor);
  });

  it("denies destinations without a shared active user relationship", async () => {
    const { sourceCompanyId, deniedCompanyId, sourceAgentId } = await seed();
    const app = createApp(db, {
      type: "agent",
      agentId: sourceAgentId,
      companyId: sourceCompanyId,
      source: "agent_key",
    });

    const res = await request(app)
      .post("/api/outbox")
      .set("Idempotency-Key", "dispatch-3")
      .send({
        destinationCompanyId: deniedCompanyId,
        messageType: "directive.dispatch",
        payload: { directiveId: "dir-3" },
      });

    expect(res.status).toBe(403);
    await expect(db.select().from(crossCompanyMessages)).resolves.toHaveLength(0);
  });

  it("requires agent actors and an idempotency key", async () => {
    const { destinationCompanyId } = await seed();
    const boardApp = createApp(db, {
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: true,
    });

    const boardRes = await request(boardApp).get("/api/inbox");
    const missingKeyRes = await request(boardApp)
      .post("/api/outbox")
      .send({
        destinationCompanyId,
        messageType: "directive.dispatch",
        payload: { directiveId: "dir-4" },
      });

    expect(boardRes.status).toBe(403);
    expect(missingKeyRes.status).toBe(403);
  });
});
