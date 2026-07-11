import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentConfigRevisions,
  agents,
  approvals,
  companies,
  createDb,
  type Db,
} from "@paperclipai/db";
import { AGENT_HIRE_REQUEST_METADATA_KEY } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import {
  fingerprintAgentHireRequest,
  runIdempotentAgentHire,
  withAgentHireIdempotencyMetadata,
  withoutAgentHireIdempotencyMetadata,
} from "../services/agent-hire-idempotency.js";
import { agentService } from "../services/agents.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent hire idempotency", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-hire-idempotency-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(name: string) {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name,
      issuePrefix: `H${id.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: true,
    });
    return id;
  }

  async function persistHire(input: {
    companyId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    name: string;
    wait?: () => Promise<void>;
  }, targetDb: Db = db) {
    await input.wait?.();
    const [agent] = await targetDb
      .insert(agents)
      .values({
        companyId: input.companyId,
        name: input.name,
        role: "engineer",
        status: "pending_approval",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        metadata: withAgentHireIdempotencyMetadata(null, {
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
        }),
      })
      .returning();
    const [approval] = await targetDb
      .insert(approvals)
      .values({
        companyId: input.companyId,
        type: "hire_agent",
        status: "pending",
        payload: {
          agentId: agent.id,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
        },
      })
      .returning();
    return { agent, approval };
  }

  it("serializes a pool-sized burst and creates one pending agent and approval", async () => {
    const companyId = await createCompany("Concurrency Co");
    const idempotencyKey = "harness:quality-verifier:v1";
    const semantics = { name: "Quality Verifier", adapterType: "process", reportsTo: null };
    const requestFingerprint = fingerprintAgentHireRequest(companyId, semantics);
    let createCalls = 0;

    const submit = () => runIdempotentAgentHire(db, {
      companyId,
      idempotencyKey,
      requestFingerprint,
    }, async (transactionDb) => {
      createCalls += 1;
      return persistHire({
        companyId,
        idempotencyKey,
        requestFingerprint,
        name: "Quality Verifier",
        wait: () => new Promise((resolve) => setTimeout(resolve, 40)),
      }, transactionDb);
    });

    const results = await Promise.all(Array.from({ length: 24 }, () => submit()));

    expect(createCalls).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(23);
    expect(new Set(results.map((result) => result.value.agent.id)).size).toBe(1);
    expect(new Set(results.map((result) => result.value.approval?.id)).size).toBe(1);
    expect(await db.select().from(agents)).toHaveLength(1);
    expect(await db.select().from(approvals)).toHaveLength(1);
  });

  it("returns 409 when one company reuses a key for different request semantics", async () => {
    const companyId = await createCompany("Conflict Co");
    const idempotencyKey = "harness:builder:v1";
    const firstFingerprint = fingerprintAgentHireRequest(companyId, { name: "Builder" });
    const conflictingFingerprint = fingerprintAgentHireRequest(companyId, { name: "Verifier" });

    await runIdempotentAgentHire(db, {
      companyId,
      idempotencyKey,
      requestFingerprint: firstFingerprint,
    }, (transactionDb) => persistHire({
      companyId,
      idempotencyKey,
      requestFingerprint: firstFingerprint,
      name: "Builder",
    }, transactionDb));

    let conflictingCreateCalls = 0;
    await expect(runIdempotentAgentHire(db, {
      companyId,
      idempotencyKey,
      requestFingerprint: conflictingFingerprint,
    }, async (transactionDb) => {
      conflictingCreateCalls += 1;
      return persistHire({
        companyId,
        idempotencyKey,
        requestFingerprint: conflictingFingerprint,
        name: "Verifier",
      }, transactionDb);
    })).rejects.toMatchObject({
      status: 409,
      message: "Agent hire idempotency key already exists for a different request",
    });

    expect(conflictingCreateCalls).toBe(0);
    expect(await db.select().from(agents)).toHaveLength(1);
    expect(await db.select().from(approvals)).toHaveLength(1);
  });

  it("rolls back a partial keyed hire so the same request can retry cleanly", async () => {
    const companyId = await createCompany("Retry Co");
    const idempotencyKey = "harness:release-operator:v1";
    const requestFingerprint = fingerprintAgentHireRequest(companyId, {
      name: "Release Operator",
    });

    await expect(runIdempotentAgentHire(db, {
      companyId,
      idempotencyKey,
      requestFingerprint,
    }, async (transactionDb) => {
      await transactionDb.insert(agents).values({
        companyId,
        name: "Release Operator",
        role: "engineer",
        status: "pending_approval",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        metadata: withAgentHireIdempotencyMetadata(null, {
          idempotencyKey,
          requestFingerprint,
        }),
      });
      throw new Error("simulated approval write failure");
    })).rejects.toThrow("simulated approval write failure");

    expect(await db.select().from(agents)).toHaveLength(0);

    const retried = await runIdempotentAgentHire(db, {
      companyId,
      idempotencyKey,
      requestFingerprint,
    }, (transactionDb) => persistHire({
      companyId,
      idempotencyKey,
      requestFingerprint,
      name: "Release Operator",
    }, transactionDb));

    expect(retried.replayed).toBe(false);
    expect(retried.value.approval?.status).toBe("pending");
    expect(await db.select().from(agents)).toHaveLength(1);
    expect(await db.select().from(approvals)).toHaveLength(1);
  });

  it("isolates the same idempotency key across companies", async () => {
    const [companyA, companyB] = await Promise.all([
      createCompany("Company A"),
      createCompany("Company B"),
    ]);
    const idempotencyKey = "harness:operator:v1";
    let started = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const waitForBothCompanies = async () => {
      started += 1;
      if (started === 2) releaseBarrier();
      await barrier;
    };

    const submit = (companyId: string, name: string) => {
      const requestFingerprint = fingerprintAgentHireRequest(companyId, { name });
      return runIdempotentAgentHire(db, {
        companyId,
        idempotencyKey,
        requestFingerprint,
      }, (transactionDb) => persistHire({
        companyId,
        idempotencyKey,
        requestFingerprint,
        name,
        wait: waitForBothCompanies,
      }, transactionDb));
    };

    const [hireA, hireB] = await Promise.all([
      submit(companyA, "Operator A"),
      submit(companyB, "Operator B"),
    ]);

    expect(started).toBe(2);
    expect(hireA.replayed).toBe(false);
    expect(hireB.replayed).toBe(false);
    expect(hireA.value.agent.companyId).toBe(companyA);
    expect(hireB.value.agent.companyId).toBe(companyB);
    expect(await db.select().from(agents)).toHaveLength(2);
    expect(await db.select().from(approvals)).toHaveLength(2);
  });

  it("keeps a keyed hire replayable after general metadata updates", async () => {
    const companyId = await createCompany("Mutable Metadata Co");
    const idempotencyKey = "harness:builder:v1";
    const requestFingerprint = fingerprintAgentHireRequest(companyId, { name: "Builder" });
    const svc = agentService(db);

    const agent = await svc.create(companyId, {
      name: "Builder",
      role: "engineer",
      status: "pending_approval",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      metadata: withAgentHireIdempotencyMetadata({ stage: "created" }, {
        idempotencyKey,
        requestFingerprint,
      }),
    }, { allowServerManagedHireMetadata: true });
    const [approval] = await db.insert(approvals).values({
      companyId,
      type: "hire_agent",
      status: "pending",
      payload: { agentId: agent.id },
    }).returning();

    const updated = await svc.update(agent.id, {
      metadata: { stage: "configured", owner: "platform" },
    }, {
      recordRevision: { source: "test" },
    });

    expect(updated?.metadata).toEqual(expect.objectContaining({
      stage: "configured",
      owner: "platform",
      [AGENT_HIRE_REQUEST_METADATA_KEY]: { idempotencyKey, requestFingerprint },
    }));

    let createCalls = 0;
    const replay = await runIdempotentAgentHire(db, {
      companyId,
      idempotencyKey,
      requestFingerprint,
    }, async () => {
      createCalls += 1;
      throw new Error("must not recreate a keyed hire");
    });

    expect(replay.replayed).toBe(true);
    expect(replay.value.agent.id).toBe(agent.id);
    expect(replay.value.approval?.id).toBe(approval.id);
    expect(createCalls).toBe(0);
  });

  it("preserves the marker across legacy rollback and rejects forged rollback metadata", async () => {
    const companyId = await createCompany("Rollback Metadata Co");
    const idempotencyKey = "harness:verifier:v1";
    const requestFingerprint = fingerprintAgentHireRequest(companyId, { name: "Verifier" });
    const marker = { idempotencyKey, requestFingerprint };
    const svc = agentService(db);

    expect(withoutAgentHireIdempotencyMetadata(
      withAgentHireIdempotencyMetadata({ portable: true }, marker),
    )).toEqual({ portable: true });
    expect(withoutAgentHireIdempotencyMetadata(
      withAgentHireIdempotencyMetadata(null, marker),
    )).toBeNull();

    await expect(svc.create(companyId, {
      name: "Marker Squatter",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      metadata: withAgentHireIdempotencyMetadata(null, marker),
    })).rejects.toMatchObject({ status: 422 });

    const agent = await svc.create(companyId, {
      name: "Verifier",
      role: "engineer",
      status: "pending_approval",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      metadata: withAgentHireIdempotencyMetadata({ stage: "created" }, marker),
    }, { allowServerManagedHireMetadata: true });

    await svc.update(agent.id, { metadata: { stage: "current" } }, {
      recordRevision: { source: "test" },
    });
    const revision = await db.select().from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.agentId, agent.id))
      .then((rows) => rows[0]);
    expect(revision).toBeTruthy();
    const snapshot = revision.afterConfig as Record<string, unknown>;

    await db.update(agentConfigRevisions).set({
      afterConfig: {
        ...snapshot,
        metadata: { stage: "legacy-rollback-target" },
      },
    }).where(eq(agentConfigRevisions.id, revision.id));

    const rolledBack = await svc.rollbackConfigRevision(agent.id, revision.id, {});
    expect(rolledBack?.metadata).toEqual({
      stage: "legacy-rollback-target",
      [AGENT_HIRE_REQUEST_METADATA_KEY]: marker,
    });

    await db.update(agentConfigRevisions).set({
      afterConfig: {
        ...snapshot,
        metadata: {
          stage: "forged-rollback-target",
          [AGENT_HIRE_REQUEST_METADATA_KEY]: {
            idempotencyKey: "harness:squatted:v1",
            requestFingerprint: "f".repeat(64),
          },
        },
      },
    }).where(eq(agentConfigRevisions.id, revision.id));

    await expect(
      svc.rollbackConfigRevision(agent.id, revision.id, {}),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("immutable server-managed metadata"),
    });
    expect((await svc.getById(agent.id))?.metadata).toEqual({
      stage: "legacy-rollback-target",
      [AGENT_HIRE_REQUEST_METADATA_KEY]: marker,
    });
  });
});
