import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  loadActivityRunRef,
  logActivity,
  persistActivity,
  resolveResponsibleUserIdForActivity,
  type ActivityPublication,
  type ActivityRunRef,
  type LogActivityInput,
} from "../services/activity-log.js";
import { logger } from "../middleware/logger.js";
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

describe("loadActivityRunRef", () => {
  it("returns null for a well-formed UUID with no matching run", async () => {
    const db = createReader(new Map([[heartbeatRuns, []]]));

    await expect(loadActivityRunRef(db, companyId, missingRunId)).resolves.toBeNull();
  });

  it("returns null for a syntactically invalid run id without querying", async () => {
    const db = {
      select: () => {
        throw new Error("a non-UUID run id should not reach the database");
      },
    } as unknown as Db;

    await expect(loadActivityRunRef(db, companyId, "not-a-uuid")).resolves.toBeNull();
    await expect(loadActivityRunRef(db, companyId, null)).resolves.toBeNull();
    await expect(loadActivityRunRef(db, companyId, undefined)).resolves.toBeNull();
  });

  it("returns the run row when it exists", async () => {
    const db = createReader(new Map([
      [heartbeatRuns, [{ id: runId, responsibleUserId: "run-user" }]],
    ]));

    await expect(loadActivityRunRef(db, companyId, runId)).resolves.toEqual({
      id: runId,
      responsibleUserId: "run-user",
    });
  });
});

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

/** The error Postgres really raises for a bad `activity_log.run_id`: FK violation, SQLSTATE 23503. */
class ForeignKeyViolation extends Error {
  readonly code = "23503";

  constructor(runId: unknown) {
    super(`activity_log.run_id=(${String(runId)}) is not present in "heartbeat_runs"`);
  }
}

/**
 * A `Db` stand-in that enforces the one constraint this issue is about: a non-null
 * `activity_log.run_id` must name a row that exists in `heartbeat_runs`.
 *
 * The embedded-Postgres suites below enforce it for real, but they are skipped on any host
 * without embedded Postgres -- so on their own the fix's central claim is only ever exercised
 * in CI, and the file still reports green where it is never checked. This keeps it falsifiable
 * everywhere, at the cost of trusting that `runId` is the column the FK hangs off.
 */
function createForeignKeyDb(runRows: ActivityRunRef[]) {
  const insertedRows: Array<Record<string, unknown>> = [];
  const knownRunIds = new Set(runRows.map((row) => row.id));
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => Promise.resolve(table === heartbeatRuns ? runRows : []),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        returning: () => {
          if (row.runId != null && !knownRunIds.has(String(row.runId))) {
            return Promise.reject(new ForeignKeyViolation(row.runId));
          }
          insertedRows.push(row);
          return Promise.resolve([{ id: "00000000-0000-4000-8000-0000000000ff" }]);
        },
      }),
    }),
  } as unknown as Db;
  return { db, insertedRows };
}

describe("persistActivity run-id foreign key", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("reproduces the 500: writing the caller's run id straight through violates the FK", async () => {
    const { db } = createForeignKeyDb([]);

    // The row `persistActivity` used to build -- the caller's `X-Paperclip-Run-Id` verbatim.
    // This is the statement that took down an already-committed mutation with a 500.
    await expect(db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      agentId,
      runId: missingRunId,
      responsibleUserId: null,
      details: null,
    }).returning({ id: activityLog.id })).rejects.toMatchObject({ code: "23503" });
  });

  it("drops an unknown run id so the insert survives, and warns with the run id and company", async () => {
    const { db, insertedRows } = createForeignKeyDb([]);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    await expect(persistActivity(db, activityInput({ runId: missingRunId })))
      .resolves.toMatchObject({ activity: { id: expect.any(String) } });

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]?.runId).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, runId: missingRunId }),
      expect.stringContaining("did not resolve"),
    );
  });

  it("keeps a run id that really exists, and does not warn", async () => {
    const { db, insertedRows } = createForeignKeyDb([{ id: runId, responsibleUserId: "run-user" }]);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    const { publication } = await persistActivity(db, activityInput({ runId }));

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]?.runId).toBe(runId);
    expect(publication.payload).toMatchObject({ runId, responsibleUserId: "run-user" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when no run id was supplied at all", async () => {
    const { db, insertedRows } = createForeignKeyDb([]);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    await persistActivity(db, activityInput());

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]?.runId).toBeNull();
    expect(warn).not.toHaveBeenCalled();
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
      .select({ responsibleUserId: activityLog.responsibleUserId })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .then((rows) => rows[0]);

    expect(row?.responsibleUserId).toBe("key-user");
  });
});

describeEmbeddedPostgres("logActivity run reference resolution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-run-ref-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const seededCompanyId = randomUUID();
    const seededAgentId = randomUUID();

    await db.insert(companies).values({
      id: seededCompanyId,
      name: "Paperclip",
      issuePrefix: `T${seededCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: seededAgentId,
      companyId: seededCompanyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId: seededCompanyId, agentId: seededAgentId };
  }

  // `activity_log.run_id` is an FK onto `heartbeat_runs.id`, and only the signed-agent-JWT auth
  // path checks the caller-supplied `X-Paperclip-Run-Id` against a claim. Every other path
  // (agent API key, board key, session) takes the header verbatim, so a client that mints its
  // own UUID used to FK-violate this insert *after* its mutation had committed -- 500ing the
  // request and orphaning the entity, because the id was never returned.
  it("drops an unknown run reference instead of violating the foreign key", async () => {
    const { companyId: seededCompanyId, agentId: seededAgentId } = await seedCompanyAndAgent();
    const unknownRunId = randomUUID();
    const entityId = randomUUID();

    await expect(logActivity(db, activityInput({
      companyId: seededCompanyId,
      actorId: seededAgentId,
      agentId: seededAgentId,
      runId: unknownRunId,
      entityType: "issue",
      entityId,
    }))).resolves.toBeDefined();

    const rows = await db
      .select({ action: activityLog.action, runId: activityLog.runId })
      .from(activityLog)
      .where(eq(activityLog.entityId, entityId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("issue.updated");
    expect(rows[0]?.runId).toBeNull();
  });

  it("preserves a run reference that really exists", async () => {
    const { companyId: seededCompanyId, agentId: seededAgentId } = await seedCompanyAndAgent();
    const realRunId = randomUUID();
    const entityId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: realRunId,
      companyId: seededCompanyId,
      agentId: seededAgentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });

    await logActivity(db, activityInput({
      companyId: seededCompanyId,
      actorId: seededAgentId,
      agentId: seededAgentId,
      runId: realRunId,
      entityType: "issue",
      entityId,
    }));

    const rows = await db
      .select({ runId: activityLog.runId })
      .from(activityLog)
      .where(eq(activityLog.entityId, entityId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.runId).toBe(realRunId);
  });

  it("drops a syntactically invalid run reference", async () => {
    const { companyId: seededCompanyId, agentId: seededAgentId } = await seedCompanyAndAgent();
    const entityId = randomUUID();

    await expect(logActivity(db, activityInput({
      companyId: seededCompanyId,
      actorId: seededAgentId,
      agentId: seededAgentId,
      runId: "not-a-uuid",
      entityType: "issue",
      entityId,
    }))).resolves.toBeDefined();

    const rows = await db
      .select({ runId: activityLog.runId })
      .from(activityLog)
      .where(eq(activityLog.entityId, entityId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.runId).toBeNull();
  });
});
