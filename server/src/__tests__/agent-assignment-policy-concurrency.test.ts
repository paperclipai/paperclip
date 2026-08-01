import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  pipelines,
  pipelineStages,
  routines,
  statusCards,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { withBuiltInAgentMarker } from "../services/built-in-agent-metadata.js";
import { routineService } from "../services/routines.js";
import { statusCardService } from "../services/status-cards.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describeEmbeddedPostgres("reserved-agent policy transaction serialization", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let contenderDb: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-assignment-policy-lock-");
    db = createDb(tempDb.connectionString);
    contenderDb = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const allowedUserId = `owner-${randomUUID()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Assignment Policy Lock Co",
      issuePrefix: `APL${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      defaultResponsibleUserId: allowedUserId,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Serialized Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      metadata: withBuiltInAgentMarker(null, {
        key: "summarizer",
        featureKeys: ["summarizer"],
      }),
    });
    return { companyId, agentId, allowedUserId };
  }

  function reservedPermissions(allowedUserId: string) {
    return {
      canCreateAgents: false,
      authorizationPolicy: {
        assignmentPolicy: {
          mode: "board_ui_create_only",
          allowedUserIds: [allowedUserId],
        },
      },
    };
  }

  function routineInput(agentId: string, title: string) {
    return {
      projectId: null,
      goalId: null,
      parentIssueId: null,
      title,
      description: null,
      assigneeAgentId: agentId,
      priority: "medium" as const,
      status: "active" as const,
      concurrencyPolicy: "coalesce_if_active" as const,
      catchUpPolicy: "skip_missed" as const,
    };
  }

  function implicitStatusCardInput(prompt: string) {
    return {
      interestPrompt: prompt,
      titlePinned: false,
      agentId: null,
      refreshPolicy: { mode: "manual" as const },
    };
  }

  async function withShortLockTimeout<T>(operation: (txDb: Db) => Promise<T>) {
    return contenderDb.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '200ms'`);
      return operation(tx as unknown as Db);
    });
  }

  it("makes policy activation wait for an in-flight routine write and then reject the committed reference", async () => {
    const { companyId, agentId, allowedUserId } = await seed();
    const routineWritten = deferred();
    const releaseRoutineCommit = deferred();

    const routineTransaction = db.transaction(async (tx) => {
      const created = await routineService(tx as unknown as Db).create(
        companyId,
        routineInput(agentId, "Writer wins"),
        { userId: allowedUserId },
      );
      routineWritten.resolve();
      await releaseRoutineCommit.promise;
      return created;
    });

    await routineWritten.promise;
    try {
      await expect(withShortLockTimeout((txDb) =>
        agentService(txDb).updatePermissions(agentId, reservedPermissions(allowedUserId))))
        .rejects.toMatchObject({ cause: { code: "55P03" } });
    } finally {
      releaseRoutineCommit.resolve();
    }
    await expect(routineTransaction).resolves.toMatchObject({ assigneeAgentId: agentId, status: "active" });

    await expect(agentService(db).updatePermissions(agentId, reservedPermissions(allowedUserId)))
      .rejects.toMatchObject({
        status: 422,
        details: {
          code: "reserved_agent_automatic_configuration",
          references: [{ kind: "routine" }],
        },
      });
    const persistedAgent = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
    expect(persistedAgent.permissions).not.toMatchObject({
      authorizationPolicy: { assignmentPolicy: { mode: "board_ui_create_only" } },
    });
  });

  it("makes a routine writer wait for in-flight policy activation and then reject the committed policy", async () => {
    const { companyId, agentId, allowedUserId } = await seed();
    const policyWritten = deferred();
    const releasePolicyCommit = deferred();

    const policyTransaction = db.transaction(async (tx) => {
      const updated = await agentService(tx as unknown as Db).updatePermissions(
        agentId,
        reservedPermissions(allowedUserId),
      );
      policyWritten.resolve();
      await releasePolicyCommit.promise;
      return updated;
    });

    await policyWritten.promise;
    try {
      await expect(withShortLockTimeout((txDb) => routineService(txDb).create(
        companyId,
        routineInput(agentId, "Policy wins while writer waits"),
        { userId: allowedUserId },
      ))).rejects.toMatchObject({ cause: { code: "55P03" } });
    } finally {
      releasePolicyCommit.resolve();
    }
    await expect(policyTransaction).resolves.toMatchObject({ id: agentId });

    await expect(routineService(db).create(
      companyId,
      routineInput(agentId, "Policy wins after commit"),
      { userId: allowedUserId },
    )).rejects.toMatchObject({
      status: 422,
      details: { code: "reserved_agent_automatic_configuration" },
    });
    await expect(db.select().from(routines)).resolves.toHaveLength(0);
  });

  it("makes an implicit status-card writer wait for in-flight Summarizer policy activation", async () => {
    const { companyId, agentId, allowedUserId } = await seed();
    const policyWritten = deferred();
    const releasePolicyCommit = deferred();

    const policyTransaction = db.transaction(async (tx) => {
      const updated = await agentService(tx as unknown as Db).updatePermissions(
        agentId,
        reservedPermissions(allowedUserId),
      );
      policyWritten.resolve();
      await releasePolicyCommit.promise;
      return updated;
    });

    await policyWritten.promise;
    try {
      await expect(withShortLockTimeout((txDb) => statusCardService(txDb).create(
        companyId,
        implicitStatusCardInput("Policy wins over implicit card"),
        { userId: allowedUserId, agentId: null },
      ))).rejects.toMatchObject({ cause: { code: "55P03" } });
    } finally {
      releasePolicyCommit.resolve();
    }
    await expect(policyTransaction).resolves.toMatchObject({ id: agentId });

    await expect(statusCardService(db).create(
      companyId,
      implicitStatusCardInput("Rejected after policy commit"),
      { userId: allowedUserId, agentId: null },
    )).rejects.toMatchObject({
      status: 422,
      details: { code: "reserved_agent_automatic_configuration" },
    });
    await expect(db.select().from(statusCards)).resolves.toHaveLength(0);
  });

  it("makes Summarizer policy activation wait for an in-flight implicit status-card writer", async () => {
    const { companyId, agentId, allowedUserId } = await seed();
    const cardWritten = deferred();
    const releaseCardCommit = deferred();

    const cardTransaction = db.transaction(async (tx) => {
      const created = await statusCardService(tx as unknown as Db).create(
        companyId,
        implicitStatusCardInput("Implicit card wins"),
        { userId: allowedUserId, agentId: null },
      );
      cardWritten.resolve();
      await releaseCardCommit.promise;
      return created;
    });

    await cardWritten.promise;
    try {
      await expect(withShortLockTimeout((txDb) => agentService(txDb).updatePermissions(
        agentId,
        reservedPermissions(allowedUserId),
      ))).rejects.toMatchObject({ cause: { code: "55P03" } });
    } finally {
      releaseCardCommit.resolve();
    }
    await expect(cardTransaction).resolves.toMatchObject({ agentId: null });

    await expect(agentService(db).updatePermissions(
      agentId,
      reservedPermissions(allowedUserId),
    )).rejects.toMatchObject({
      status: 422,
      details: {
        code: "reserved_agent_automatic_configuration",
        references: [{ kind: "status_card" }],
      },
    });
  });

  it("rejects an explicit override to implicit Summarizer transition when Summarizer is reserved", async () => {
    const { companyId, agentId, allowedUserId } = await seed();
    const [override] = await db.insert(agents).values({
      companyId,
      name: "Explicit card writer",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    await agentService(db).updatePermissions(agentId, reservedPermissions(allowedUserId));
    const service = statusCardService(db);
    const card = await service.create(
      companyId,
      {
        ...implicitStatusCardInput("Explicit override"),
        agentId: override!.id,
      },
      { userId: allowedUserId, agentId: null },
    );

    await expect(service.update(
      card,
      { agentId: null },
      { userId: allowedUserId, agentId: null },
    )).rejects.toMatchObject({
      status: 422,
      details: { code: "reserved_agent_automatic_configuration" },
    });
    await expect(db.select().from(statusCards).where(eq(statusCards.id, card.id)))
      .resolves.toMatchObject([{ agentId: override!.id }]);
  });

  it("guards generic permission updates with the same automatic-reference invariant", async () => {
    const { companyId, agentId, allowedUserId } = await seed();
    const agentsSvc = agentService(db);
    await routineService(db).create(
      companyId,
      routineInput(agentId, "Existing automatic reference"),
      { userId: allowedUserId },
    );

    await expect(agentsSvc.update(agentId, {
      permissions: reservedPermissions(allowedUserId),
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "reserved_agent_automatic_configuration" },
    });
  });

  it("rejects policy activation while a paused routine remains runnable from a pipeline", async () => {
    const { companyId, agentId, allowedUserId } = await seed();
    const [routine] = await db.insert(routines).values({
      companyId,
      title: "Paused but pipeline-runnable",
      assigneeAgentId: agentId,
      status: "paused",
      originKind: "pipeline_automation",
    }).returning();
    const [pipeline] = await db.insert(pipelines).values({
      companyId,
      key: "paused-routine-policy",
      name: "Paused routine policy",
    }).returning();
    await db.insert(pipelineStages).values({
      pipelineId: pipeline!.id,
      key: "working",
      name: "Working",
      kind: "working",
      position: 100,
      config: { onEnter: { type: "run_routine", routineId: routine!.id } },
    });

    await expect(agentService(db).updatePermissions(agentId, reservedPermissions(allowedUserId)))
      .rejects.toMatchObject({
        status: 422,
        details: {
          code: "reserved_agent_automatic_configuration",
          references: [{ kind: "routine", id: routine!.id }],
        },
      });
  });

  it("serializes config rollback behind a concurrent policy update", async () => {
    const { agentId, allowedUserId } = await seed();
    const agentsSvc = agentService(db);
    await agentsSvc.update(agentId, { title: "Revision one" }, {
      recordRevision: { source: "patch", createdByUserId: allowedUserId },
    });
    const [revisionOne] = await agentsSvc.listConfigRevisions(agentId);
    expect(revisionOne).toBeDefined();
    await agentsSvc.update(agentId, { title: "Revision two" }, {
      recordRevision: { source: "patch", createdByUserId: allowedUserId },
    });

    const policyWritten = deferred();
    const releasePolicyCommit = deferred();
    const policyTransaction = db.transaction(async (tx) => {
      const updated = await agentService(tx as unknown as Db).updatePermissions(
        agentId,
        reservedPermissions(allowedUserId),
      );
      policyWritten.resolve();
      await releasePolicyCommit.promise;
      return updated;
    });

    await policyWritten.promise;
    try {
      await expect(withShortLockTimeout((txDb) =>
        agentService(txDb).rollbackConfigRevision(agentId, revisionOne!.id, {
          userId: allowedUserId,
        }))).rejects.toMatchObject({ cause: { code: "55P03" } });
    } finally {
      releasePolicyCommit.resolve();
    }
    await expect(policyTransaction).resolves.toMatchObject({ id: agentId });
    await expect(agentsSvc.rollbackConfigRevision(agentId, revisionOne!.id, {
      userId: allowedUserId,
    })).resolves.toMatchObject({ title: "Revision one" });
  });

  it("keeps pending approval activation atomic with automatic-reference validation", async () => {
    const { companyId, agentId, allowedUserId } = await seed();
    await db.update(agents).set({
      status: "pending_approval",
      permissions: reservedPermissions(allowedUserId),
    }).where(eq(agents.id, agentId));
    await db.insert(routines).values({
      companyId,
      title: "Legacy pending approval reference",
      status: "active",
      assigneeAgentId: agentId,
    });

    await expect(agentService(db).activatePendingApproval(agentId)).rejects.toMatchObject({
      status: 422,
      details: { code: "reserved_agent_automatic_configuration" },
    });
    await expect(db.select().from(agents).where(eq(agents.id, agentId)))
      .resolves.toMatchObject([{ status: "pending_approval" }]);
  });
});
