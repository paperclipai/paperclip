import { randomUUID } from "node:crypto";
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
  type LogActivityInput,
} from "../services/activity-log.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

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
    const db = createReader(new Map([
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
    const db = createReader(new Map([
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
    const db = createReader(new Map([
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
    const db = createReader(new Map([
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
    const db = createReader(new Map([
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
    const db = createReader(new Map([
      [issues, [{ responsibleUserId: null, createdByUserId: "creator-user" }]],
      [companies, [{ defaultResponsibleUserId: "default-user" }]],
    ]));

    await expect(resolveResponsibleUserIdForActivity(db, activityInput())).resolves.toBe("creator-user");
  });

  it("ignores malformed UUID-backed identifiers", async () => {
    const db = createReader(new Map([
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

describeEmbeddedPostgres("logActivity responsible-user stamping", () => {
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

    await logActivity(db, activityInput({
      companyId,
      actorId: agentId,
      agentId,
      entityType: "agent",
      entityId: agentId,
      agentApiKeyId,
    }));

    const row = await db
      .select({ responsibleUserId: activityLog.responsibleUserId })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .then((rows) => rows[0]);

    expect(row?.responsibleUserId).toBe("key-user");
  });
});
