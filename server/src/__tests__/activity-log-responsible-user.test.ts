import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentApiKeys,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  logActivity,
  resolveResponsibleUserIdForActivity,
  type ActivityPublication,
  type LogActivityInput,
} from "../services/activity-log.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { requestActorContext, withRequestActor } from "../services/request-actor-context.js";

type TableRows = Map<unknown, Array<Record<string, unknown>>>;

const companyId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const issueId = "00000000-0000-4000-8000-000000000003";
const runId = "00000000-0000-4000-8000-000000000004";
const missingRunId = "00000000-0000-4000-8000-000000000005";
const agentApiKeyId = "00000000-0000-4000-8000-000000000006";
const missingAgentApiKeyId = "00000000-0000-4000-8000-000000000007";

function createReader(rowsByTable: TableRows) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          expect(condition).toBeDefined();
          return Promise.resolve(rowsByTable.get(table) ?? []);
        },
      }),
    }),
  } as unknown as Db;
}

function activityInput(overrides: Partial<LogActivityInput> = {}): LogActivityInput {
  return {
    companyId,
    actorType: "agent",
    actorId: agentId,
    action: "issue.updated",
    entityType: "issue",
    entityId: issueId,
    agentId,
    ...overrides,
  };
}

describe("resolveResponsibleUserIdForActivity", () => {
  it("attributes user actions directly without database lookups", async () => {
    const db = {
      select: () => {
        throw new Error("user attribution should not query the database");
      },
    } as unknown as Db;

    await expect(resolveResponsibleUserIdForActivity(db, activityInput({
      actorType: "user",
      actorId: "user-1",
      entityType: "company",
      entityId: companyId,
    }))).resolves.toBe("user-1");
  });

  it("prefers the heartbeat run responsible user", async () => {
    const db = createReader(new Map<unknown, Array<Record<string, unknown>>>([
      [heartbeatRuns, [{ responsibleUserId: "run-user" }]],
      [issues, [{ responsibleUserId: "issue-user", createdByUserId: null }]],
      [agentApiKeys, [{ responsibleUserId: "key-user" }]],
      [companies, [{ defaultResponsibleUserId: "default-user" }]],
    ]));

    await expect(resolveResponsibleUserIdForActivity(db, activityInput({
      runId,
      agentApiKeyId,
    }))).resolves.toBe("run-user");
  });

  it("falls back to issue attribution when the run is unavailable", async () => {
    const db = createReader(new Map<unknown, Array<Record<string, unknown>>>([
      [heartbeatRuns, []],
      [issues, [{ responsibleUserId: "issue-user", createdByUserId: "creator-user" }]],
      [agentApiKeys, [{ responsibleUserId: "key-user" }]],
      [companies, [{ defaultResponsibleUserId: "default-user" }]],
    ]));

    await expect(resolveResponsibleUserIdForActivity(db, activityInput({
      runId: missingRunId,
      agentApiKeyId,
    }))).resolves.toBe("issue-user");
  });

  it("uses explicit issue context for non-issue activity", async () => {
    const db = createReader(new Map<unknown, Array<Record<string, unknown>>>([
      [issues, [{ responsibleUserId: "issue-user", createdByUserId: null }]],
      [companies, [{ defaultResponsibleUserId: "default-user" }]],
    ]));

    await expect(resolveResponsibleUserIdForActivity(db, activityInput({
      entityType: "heartbeat_run",
      entityId: runId,
      issueId,
    }))).resolves.toBe("issue-user");
  });

  it("uses the active agent API key responsible user for no-run actions", async () => {
    const db = createReader(new Map<unknown, Array<Record<string, unknown>>>([
      [agentApiKeys, [{ responsibleUserId: "key-user" }]],
      [companies, [{ defaultResponsibleUserId: "default-user" }]],
    ]));

    await expect(resolveResponsibleUserIdForActivity(db, activityInput({
      entityType: "agent",
      entityId: agentId,
      agentApiKeyId,
    }))).resolves.toBe("key-user");
  });

  it("falls back to the company default responsible user", async () => {
    const db = createReader(new Map<unknown, Array<Record<string, unknown>>>([
      [agentApiKeys, []],
      [companies, [{ defaultResponsibleUserId: "default-user" }]],
    ]));

    await expect(resolveResponsibleUserIdForActivity(db, activityInput({
      entityType: "company",
      entityId: companyId,
      agentApiKeyId: missingAgentApiKeyId,
    }))).resolves.toBe("default-user");
  });

  it("uses issue creator attribution when responsibleUserId is absent", async () => {
    const db = createReader(new Map<unknown, Array<Record<string, unknown>>>([
      [issues, [{ responsibleUserId: null, createdByUserId: "creator-user" }]],
      [companies, [{ defaultResponsibleUserId: "default-user" }]],
    ]));

    await expect(resolveResponsibleUserIdForActivity(db, activityInput())).resolves.toBe("creator-user");
  });

  it("ignores malformed UUID-backed identifiers", async () => {
    const db = createReader(new Map<unknown, Array<Record<string, unknown>>>([
      [heartbeatRuns, [{ responsibleUserId: "run-user" }]],
      [issues, [{ responsibleUserId: "issue-user", createdByUserId: null }]],
      [agentApiKeys, [{ responsibleUserId: "key-user" }]],
      [companies, [{ defaultResponsibleUserId: "default-user" }]],
    ]));

    await expect(resolveResponsibleUserIdForActivity(db, activityInput({
      runId: "not-a-run-uuid",
      entityId: "not-an-issue-uuid",
      agentApiKeyId: "not-a-key-uuid",
      details: { issueId },
    }))).resolves.toBe("default-user");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("logActivity attribution stamping", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-responsible-user-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists API-key attribution for an out-of-run action", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const agentApiKeyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "default-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentApiKeys).values({
      id: agentApiKeyId,
      companyId,
      agentId,
      name: "test",
      keyHash: `hash-${agentApiKeyId}`,
      responsibleUserId: "key-user",
    });

    const postCommitPublications: ActivityPublication[] = [];
    await logActivity(db, activityInput({
      companyId,
      actorId: agentId,
      agentId,
      entityType: "agent",
      entityId: agentId,
      agentApiKeyId,
    }), postCommitPublications);

    expect(postCommitPublications).toHaveLength(1);
    expect(postCommitPublications[0]).toMatchObject({
      companyId,
      payload: {
        action: "issue.updated",
        entityType: "agent",
        entityId: agentId,
      },
    });

    const row = await db
      .select({ responsibleUserId: activityLog.responsibleUserId, apiKeyId: activityLog.apiKeyId })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .then((rows) => rows[0]);

    expect(row?.responsibleUserId).toBe("key-user");
    expect(row?.apiKeyId).toBe(agentApiKeyId);
  });

  it("does not let a callback created during a keyed request reuse the key after the response", async () => {
    const companyId = randomUUID();
    const boardApiKeyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Worker",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const record = (actorId: string) => logActivity(db, activityInput({
      companyId, actorType: "user", actorId, agentId: null, entityType: "company", entityId: companyId,
    }), []);
    let releaseWorker!: () => void;
    let workerActivity!: Promise<unknown>;
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = { type: "board", userId: "board-key-user", keyId: boardApiKeyId, source: "board_key" };
      next();
    });
    app.use(requestActorContext);
    app.post("/configure", async (_req, res) => {
      workerActivity = new Promise<void>((resolve) => { releaseWorker = resolve; }).then(() => record("after-response"));
      await record("during-request");
      res.json({ ok: true });
    });

    await request(app).post("/configure").expect(200);
    releaseWorker();
    await workerActivity;

    const rows = await db
      .select({ actorId: activityLog.actorId, apiKeyId: activityLog.apiKeyId })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));

    expect(rows).toEqual(expect.arrayContaining([
      { actorId: "during-request", apiKeyId: boardApiKeyId },
      { actorId: "after-response", apiKeyId: null },
    ]));
  });

  it("keeps the request key for handler work that finishes after the client disconnects", async () => {
    const companyId = randomUUID();
    const boardApiKeyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Disconnect",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let markClosed!: () => void;
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    let handlerDone!: Promise<void>;
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = { type: "board", userId: "board-key-user", keyId: boardApiKeyId, source: "board_key" };
      next();
    });
    app.use(requestActorContext);
    app.put("/file", (_req, res) => {
      res.once("close", () => markClosed());
      handlerDone = (async () => {
        markStarted();
        await handlerGate;
        await logActivity(db, activityInput({
          companyId, actorType: "user", actorId: "after-disconnect", agentId: null, entityType: "company", entityId: companyId,
        }), []);
        res.json({ ok: true });
      })();
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    try {
      const { port } = server.address() as AddressInfo;
      const client = httpRequest({ host: "127.0.0.1", port, method: "PUT", path: "/file" });
      client.on("error", () => {});
      client.end();
      await started;
      client.destroy();
      await closed;
      releaseHandler();
      await handlerDone;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const rows = await db
      .select({ actorId: activityLog.actorId, apiKeyId: activityLog.apiKeyId })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));

    expect(rows).toEqual([{ actorId: "after-disconnect", apiKeyId: boardApiKeyId }]);
  });

  it("stores a Board API key id and leaves session activity unkeyed", async () => {
    const companyId = randomUUID();
    const boardApiKeyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Board",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await withRequestActor({ type: "board", userId: "board-key-user", keyId: boardApiKeyId, source: "board_key" }, () =>
      logActivity(db, activityInput({
        companyId,
        actorType: "user",
        actorId: "board-key-user",
        agentId: null,
        entityType: "company",
        entityId: companyId,
      }), []));
    await withRequestActor({ type: "board", userId: "board-key-user", keyId: boardApiKeyId, source: "board_key" }, () =>
      logActivity(db, activityInput({
        companyId,
        actorType: "system",
        actorId: "recovery",
        agentId: null,
        entityType: "company",
        entityId: companyId,
      }), []));
    await withRequestActor({ type: "board", userId: "session-user", source: "session" }, () =>
      logActivity(db, activityInput({
        companyId,
        actorType: "user",
        actorId: "session-user",
        agentId: null,
        entityType: "company",
        entityId: companyId,
      }), []));

    const rows = await db
      .select({ actorId: activityLog.actorId, apiKeyId: activityLog.apiKeyId })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));

    expect(rows).toEqual(expect.arrayContaining([
      { actorId: "board-key-user", apiKeyId: boardApiKeyId },
      { actorId: "recovery", apiKeyId: null },
      { actorId: "session-user", apiKeyId: null },
    ]));
  });
});
