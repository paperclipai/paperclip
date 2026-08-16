import { createHash, createHmac, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  applyPendingMigrations,
  companies,
  companyMemberships,
  companyWorkProjectionCredentials,
  companyWorkProjectionIssueHeads,
  companyWorkProjectionRevisions,
  companyWorkProjectionSourceEvents,
  companyWorkProjectionSourceWitnesses,
  companyWorkProjectionVerifications,
  createDb,
  issueRecoveryActions,
  issues,
  issueWorkProjectionVersions,
  principalPermissionGrants,
  projects,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";
import { companyWorkProjectionCredentialGuard } from "../middleware/company-work-projection-credential-guard.js";
import { errorHandler } from "../middleware/error-handler.js";
import { companyWorkProjectionRoutes } from "../routes/company-work-projection.js";
import { encodeCompanyWorkProjectionCursor } from "../services/company-work-projection-cursor.js";
import { companyWorkProjectionCredentialService } from "../services/company-work-projection-credentials.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.unmock("http");
vi.unmock("node:http");

const externalDatabaseUrl = process.env.PAPERCLIP_WORK_PROJECTION_TEST_DATABASE_URL?.trim();
const support = externalDatabaseUrl
  ? { supported: true as const }
  : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping company work projection tests: ${support.reason ?? "embedded PostgreSQL unavailable"}`);
}

const signingSecret = "synthetic-company-work-projection-secret";

function signRawCursorPayload(payload: string, companyId: string) {
  const companyKey = createHmac("sha256", signingSecret)
    .update(`company-work-projection-cursor:v1:${resolvePaperclipInstanceId()}:${companyId}`)
    .digest();
  return createHmac("sha256", companyKey).update(payload).digest("base64url");
}

describePostgres("company work projection", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const originalJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = signingSecret;
    if (externalDatabaseUrl) {
      await applyPendingMigrations(externalDatabaseUrl);
      db = createDb(externalDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-work-projection-");
      db = createDb(tempDb.connectionString);
    }
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(companyWorkProjectionCredentials);
    await db.delete(activityLog);
    await db.delete(agentApiKeys);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (originalJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalJwtSecret;
    await tempDb?.cleanup();
  });

  function app() {
    const instance = express();
    instance.locals.paperclipDb = db;
    instance.use(express.json());
    instance.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    instance.use(companyWorkProjectionCredentialGuard());
    instance.use("/api", companyWorkProjectionRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  function managementApp(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use(companyWorkProjectionCredentialGuard());
    instance.use("/api", companyWorkProjectionRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function boardMember(
    companyId: string,
    role: "owner" | "admin" | "operator" | "viewer",
  ) {
    const userId = `synthetic-${role}-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: role,
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: userId,
      membershipRole: role,
      grantedByUserId: null,
    });
    return {
      type: "board" as const,
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }],
      isInstanceAdmin: false,
      source: "session" as const,
    };
  }

  async function seed() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const credentialId = randomUUID();
    const token = `pcwp_v1_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await db.insert(companies).values([
      { id: companyId, name: "Synthetic Alpha", issuePrefix: `A${companyId.slice(0, 6)}` },
      { id: otherCompanyId, name: "Synthetic Beta", issuePrefix: `B${otherCompanyId.slice(0, 6)}` },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Synthetic Reader",
      role: "integration",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await insertProjectionCredential(companyId, "projection-reader", token, credentialId);
    return { companyId, otherCompanyId, agentId, credentialId, token };
  }

  async function insertProjectionCredential(
    companyId: string,
    name: string,
    token: string,
    credentialId = randomUUID(),
  ) {
    const audit = await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "synthetic-owner",
      action: "company_work_projection.credential_created",
      entityType: "company_work_projection_credential",
      entityId: credentialId,
    }).returning({ id: activityLog.id }).then((rows) => rows[0]);
    await db.insert(companyWorkProjectionCredentials).values({
      id: credentialId,
      companyId,
      name,
      keyHash: createHash("sha256").update(token).digest("hex"),
      tokenVersion: 1,
      creationActivityId: audit.id,
    });
    return credentialId;
  }

  async function addIssue(
    companyId: string,
    input: { priority?: "critical" | "high" | "medium" | "low"; assigneeAgentId?: string | null } = {},
  ) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: `Synthetic ${id}`,
      identifier: `SYN-${id.slice(0, 8)}`,
      priority: input.priority ?? "medium",
      status: "todo",
      assigneeAgentId: input.assigneeAgentId ?? null,
    });
    return id;
  }

  async function snapshotProjectionMaterialization(companyId: string) {
    const counter = await db.select().from(companyWorkProjectionRevisions)
      .where(eq(companyWorkProjectionRevisions.companyId, companyId))
      .then((rows) => rows[0]);
    if (!counter) throw new Error("synthetic projection counter missing");
    return {
      counter,
      history: await db.select().from(issueWorkProjectionVersions)
        .where(eq(issueWorkProjectionVersions.companyId, companyId)),
      sourceEvents: await db.select().from(companyWorkProjectionSourceEvents)
        .where(eq(companyWorkProjectionSourceEvents.companyId, companyId)),
      heads: await db.select().from(companyWorkProjectionIssueHeads)
        .where(eq(companyWorkProjectionIssueHeads.companyId, companyId)),
    };
  }

  async function replaceProjectionMaterialization(
    companyId: string,
    state: Awaited<ReturnType<typeof snapshotProjectionMaterialization>>,
  ) {
    await db.execute(sql`SELECT public.invalidate_company_work_projection_verification(${companyId}::uuid)`);
    await db.execute(sql.raw(
      "ALTER TABLE public.issue_work_projection_versions DISABLE TRIGGER USER; "
      + "ALTER TABLE public.company_work_projection_source_events DISABLE TRIGGER USER",
    ));
    try {
      await db.transaction(async (tx) => {
        await tx.delete(companyWorkProjectionSourceEvents)
          .where(eq(companyWorkProjectionSourceEvents.companyId, companyId));
        await tx.delete(companyWorkProjectionIssueHeads)
          .where(eq(companyWorkProjectionIssueHeads.companyId, companyId));
        await tx.delete(issueWorkProjectionVersions)
          .where(eq(issueWorkProjectionVersions.companyId, companyId));
        if (state.history.length > 0) await tx.insert(issueWorkProjectionVersions).values(state.history);
        if (state.sourceEvents.length > 0) {
          await tx.insert(companyWorkProjectionSourceEvents).values(state.sourceEvents);
        }
        if (state.heads.length > 0) await tx.insert(companyWorkProjectionIssueHeads).values(state.heads);
        await tx.update(companyWorkProjectionRevisions).set({
          currentRevision: state.counter.currentRevision,
          currentIntegrityToken: state.counter.currentIntegrityToken,
          updatedAt: state.counter.updatedAt,
        }).where(eq(companyWorkProjectionRevisions.companyId, companyId));
      });
    } finally {
      await db.execute(sql.raw(
        "ALTER TABLE public.issue_work_projection_versions ENABLE TRIGGER USER; "
        + "ALTER TABLE public.company_work_projection_source_events ENABLE TRIGGER USER",
      ));
    }
    await db.execute(sql`SELECT public.verify_company_work_projection_recovery(${companyId}::uuid)`);
  }

  async function getProjection(token: string, companyId: string, query = "") {
    return request(app())
      .get(`/api/v1/companies/${companyId}/work-projection${query}`)
      .set("Authorization", `Bearer ${token}`);
  }

  async function waitForDatabaseLock(
    queryFragment: string,
  ): Promise<{ pid: number; waitEventType: string; waitEvent: string; query: string }> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const rows = Array.from(await db.execute(sql<{
        pid: number;
        waitEventType: string;
        waitEvent: string;
        query: string;
      }>`
        SELECT pid, wait_event_type AS "waitEventType", wait_event AS "waitEvent", query
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE ${`%${queryFragment}%`}
        ORDER BY query_start
      `));
      const row = rows[0];
      if (row) {
        return {
          pid: row.pid,
          waitEventType: row.waitEventType,
          waitEvent: row.waitEvent,
          query: row.query,
        };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`database wait-state receipt missing for ${queryFragment}`);
  }

  async function legacyAgentKeyLookup(token: string) {
    return db.select({ id: agentApiKeys.id })
      .from(agentApiKeys)
      .where(and(
        eq(agentApiKeys.keyHash, createHash("sha256").update(token).digest("hex")),
        sql`${agentApiKeys.revokedAt} IS NULL`,
      ));
  }

  it("returns empty-complete and one-page bounded projections without any read mutation", async () => {
    const seeded = await seed();
    const empty = await getProjection(seeded.token, seeded.companyId);
    expect(empty.status).toBe(200);
    expect(empty.body.page).toMatchObject({ size: 0, hasMore: false, completeness: "complete" });

    const issueId = await addIssue(seeded.companyId, { assigneeAgentId: seeded.agentId });
    const before = {
      credential: await db.select().from(companyWorkProjectionCredentials)
        .where(eq(companyWorkProjectionCredentials.id, seeded.credentialId)),
      activity: await db.select().from(activityLog),
      recovery: await db.select().from(issueRecoveryActions),
      revisions: await db.select().from(companyWorkProjectionRevisions),
      witnesses: await db.select().from(companyWorkProjectionSourceWitnesses),
      versions: await db.select().from(issueWorkProjectionVersions),
      sourceEvents: await db.select().from(companyWorkProjectionSourceEvents),
      heads: await db.select().from(companyWorkProjectionIssueHeads),
      verifications: await db.select().from(companyWorkProjectionVerifications),
    };
    const response = await getProjection(seeded.token, seeded.companyId);
    expect(response.status).toBe(200);
    expect(response.headers.etag).toBe(response.body.etag);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      id: issueId,
      owner: { type: "agent", id: seeded.agentId },
      planningState: "todo",
      priority: "medium",
    });
    const serialized = JSON.stringify(response.body);
    for (const privateField of ["title", "description", "adapterConfig", "workspace", "recovery", "credentials"]) {
      expect(serialized).not.toContain(privateField);
    }
    expect(await db.select().from(companyWorkProjectionCredentials)
      .where(eq(companyWorkProjectionCredentials.id, seeded.credentialId))).toEqual(before.credential);
    expect(await db.select().from(activityLog)).toEqual(before.activity);
    expect(await db.select().from(issueRecoveryActions)).toEqual(before.recovery);
    expect(await db.select().from(companyWorkProjectionRevisions)).toEqual(before.revisions);
    expect(await db.select().from(companyWorkProjectionSourceWitnesses)).toEqual(before.witnesses);
    expect(await db.select().from(issueWorkProjectionVersions)).toEqual(before.versions);
    expect(await db.select().from(companyWorkProjectionSourceEvents)).toEqual(before.sourceEvents);
    expect(await db.select().from(companyWorkProjectionIssueHeads)).toEqual(before.heads);
    expect(await db.select().from(companyWorkProjectionVerifications)).toEqual(before.verifications);

    const conditional = await request(app())
      .get(`/api/v1/companies/${seeded.companyId}/work-projection`)
      .set("Authorization", `Bearer ${seeded.token}`)
      .set("If-None-Match", response.body.etag);
    expect(conditional.status).toBe(304);
    expect(conditional.text).toBe("");

    for (const ifNoneMatch of [
      "*",
      `W/${response.body.etag}`,
      `"unrelated", W/${response.body.etag}`,
    ]) {
      const standardsConditional = await request(app())
        .get(`/api/v1/companies/${seeded.companyId}/work-projection`)
        .set("Authorization", `Bearer ${seeded.token}`)
        .set("If-None-Match", ifNoneMatch);
      expect(standardsConditional.status, ifNoneMatch).toBe(304);
    }
    const nonMatch = await request(app())
      .get(`/api/v1/companies/${seeded.companyId}/work-projection`)
      .set("Authorization", `Bearer ${seeded.token}`)
      .set("If-None-Match", 'W/"unrelated"');
    expect(nonMatch.status).toBe(200);
  });

  it("keeps current, malformed, mixed-version, and rolled-back credential handling fail closed", async () => {
    const seeded = await seed();
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(200);
    expect(await legacyAgentKeyLookup(seeded.token)).toEqual([]);

    const malformedToken = `pcwp_v1_${"b".repeat(48)}`;
    const sharedHash = createHash("sha256").update(malformedToken).digest("hex");
    const malformedAudit = await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "synthetic-owner",
      action: "company_work_projection.credential_created",
      entityType: "company_work_projection_credential",
      entityId: randomUUID(),
    }).returning({ id: activityLog.id }).then((rows) => rows[0]);
    await db.execute(sql`
      INSERT INTO public.company_work_projection_credentials (
        company_id, name, key_hash, token_version, creation_activity_id
      ) VALUES (
        ${seeded.companyId}::uuid, 'malformed-version', ${sharedHash}, 999,
        ${malformedAudit.id}::uuid
      )
    `).catch(() => undefined);
    await db.insert(agentApiKeys).values({
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      name: "mixed-version-collision",
      keyHash: sharedHash,
      responsibleUserId: "synthetic-user",
      scopeConfig: null,
    });

    const malformed = await getProjection(malformedToken, seeded.companyId);
    expect(malformed.status).toBe(401);
    const mixedCollision = await db.select().from(agentApiKeys)
      .where(eq(agentApiKeys.keyHash, sharedHash));
    expect(mixedCollision[0]?.lastUsedAt).toBeNull();
    expect(await legacyAgentKeyLookup(seeded.token)).toEqual([]);

    const owner = await boardMember(seeded.companyId, "owner");
    await companyWorkProjectionCredentialService(db).revoke(
      seeded.companyId,
      seeded.credentialId,
      owner.userId,
    );
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(401);
  });

  it("limits credential lifecycle to owner/admin and keeps mutation plus audit atomic and idempotent", async () => {
    const seeded = await seed();
    const owner = await boardMember(seeded.companyId, "owner");
    const admin = await boardMember(seeded.companyId, "admin");
    const operator = await boardMember(seeded.companyId, "operator");

    const denied = await request(managementApp(operator))
      .post(`/api/v1/companies/${seeded.companyId}/work-projection-credentials`)
      .send({ name: "operator-must-not-create" });
    expect(denied.status).toBe(403);
    expect((await request(managementApp(operator))
      .get(`/api/v1/companies/${seeded.companyId}/work-projection-credentials`)).status).toBe(403);

    const ownerCreated = await request(managementApp(owner))
      .post(`/api/v1/companies/${seeded.companyId}/work-projection-credentials`)
      .send({ name: "owner-created" });
    expect(ownerCreated.status).toBe(201);
    expect(ownerCreated.body.token).toMatch(/^pcwp_v1_/);
    const adminList = await request(managementApp(admin))
      .get(`/api/v1/companies/${seeded.companyId}/work-projection-credentials`);
    expect(adminList.status).toBe(200);
    expect(adminList.body.map((row: { id: string }) => row.id)).toContain(ownerCreated.body.id);

    await db.update(companyMemberships).set({ membershipRole: "operator", updatedAt: new Date() })
      .where(and(
        eq(companyMemberships.companyId, seeded.companyId),
        eq(companyMemberships.principalId, owner.userId),
      ));
    const staleOwnerActor = await request(managementApp(owner))
      .post(`/api/v1/companies/${seeded.companyId}/work-projection-credentials`)
      .send({ name: "stale-owner-role" });
    expect(staleOwnerActor.status).toBe(403);
    await db.update(companyMemberships).set({ membershipRole: "owner", updatedAt: new Date() })
      .where(and(
        eq(companyMemberships.companyId, seeded.companyId),
        eq(companyMemberships.principalId, owner.userId),
      ));

    const missingCompanyId = randomUUID();
    for (const lifecycleRequest of [
      (instance: express.Express, companyId: string) => request(instance)
        .get(`/api/v1/companies/${companyId}/work-projection-credentials`),
      (instance: express.Express, companyId: string) => request(instance)
        .post(`/api/v1/companies/${companyId}/work-projection-credentials`)
        .send({ name: "oracle-resistant" }),
      (instance: express.Express, companyId: string) => request(instance)
        .delete(`/api/v1/companies/${companyId}/work-projection-credentials/${randomUUID()}`),
    ]) {
      const missing = await lifecycleRequest(managementApp(owner), missingCompanyId);
      const inaccessible = await lifecycleRequest(managementApp(owner), seeded.otherCompanyId);
      expect({ status: missing.status, body: missing.body }).toEqual({
        status: inaccessible.status,
        body: inaccessible.body,
      });
      expect(missing.status).toBe(404);
    }

    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION public.synthetic_fail_projection_credential_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action IN (
          'company_work_projection.credential_created',
          'company_work_projection.credential_revoked'
        ) THEN RAISE EXCEPTION 'synthetic audit failure'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER synthetic_fail_projection_credential_audit
      BEFORE INSERT ON public.activity_log
      FOR EACH ROW EXECUTE FUNCTION public.synthetic_fail_projection_credential_audit()
    `));
    try {
      const failedCreate = await request(managementApp(owner))
        .post(`/api/v1/companies/${seeded.companyId}/work-projection-credentials`)
        .send({ name: "audit-failed-create" });
      expect(failedCreate.status).toBe(500);
      expect(await db.select().from(companyWorkProjectionCredentials)
        .where(eq(companyWorkProjectionCredentials.name, "audit-failed-create"))).toEqual([]);

      const failedRevoke = await request(managementApp(owner))
        .delete(`/api/v1/companies/${seeded.companyId}/work-projection-credentials/${ownerCreated.body.id}`);
      expect(failedRevoke.status).toBe(500);
      const stillActive = await db.select().from(companyWorkProjectionCredentials)
        .where(eq(companyWorkProjectionCredentials.id, ownerCreated.body.id))
        .then((rows) => rows[0]);
      expect(stillActive.revokedAt).toBeNull();
      expect(stillActive.revocationActivityId).toBeNull();
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS synthetic_fail_projection_credential_audit ON public.activity_log;
        DROP FUNCTION IF EXISTS public.synthetic_fail_projection_credential_audit()
      `));
    }

    const [firstRevoke, replayRevoke] = await Promise.all([
      request(managementApp(owner))
        .delete(`/api/v1/companies/${seeded.companyId}/work-projection-credentials/${ownerCreated.body.id}`),
      request(managementApp(admin))
        .delete(`/api/v1/companies/${seeded.companyId}/work-projection-credentials/${ownerCreated.body.id}`),
    ]);
    expect(firstRevoke.status).toBe(200);
    expect(replayRevoke.status).toBe(200);
    expect(firstRevoke.body).toEqual(replayRevoke.body);
    const revokeAudits = await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, ownerCreated.body.id),
      eq(activityLog.action, "company_work_projection.credential_revoked"),
    ));
    expect(revokeAudits).toHaveLength(1);

    await expect(db.insert(companyWorkProjectionCredentials).values({
      companyId: seeded.companyId,
      name: "unlogged-active",
      keyHash: createHash("sha256").update("synthetic-unlogged").digest("hex"),
      tokenVersion: 1,
      creationActivityId: undefined as never,
    })).rejects.toThrow();
  });

  it("serializes create authorization through audit commit before a concurrent demotion", async () => {
    const seeded = await seed();
    const owner = await boardMember(seeded.companyId, "owner");
    const lockKey = 7_184_201;
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION public.synthetic_block_projection_credential_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'company_work_projection.credential_created' THEN
          PERFORM pg_advisory_xact_lock(${lockKey});
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER synthetic_block_projection_credential_audit
      BEFORE INSERT ON public.activity_log
      FOR EACH ROW EXECUTE FUNCTION public.synthetic_block_projection_credential_audit()
    `));
    let releaseBlocker: () => void = () => undefined;
    let markBlockerReady: () => void = () => undefined;
    const blockerReady = new Promise<void>((resolve) => { markBlockerReady = resolve; });
    const holdBlocker = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const blockerTransaction = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);
      markBlockerReady();
      await holdBlocker;
    });
    try {
      await blockerReady;
      const pendingCreate = request(managementApp(owner))
        .post(`/api/v1/companies/${seeded.companyId}/work-projection-credentials`)
        .send({ name: "serialized-create" })
        .then((response) => response);
      const createWait = await waitForDatabaseLock("activity_log");
      expect(createWait).toMatchObject({ waitEventType: "Lock", waitEvent: "advisory" });

      const pendingDemotion = db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE public.company_memberships
          SET membership_role = 'operator', updated_at = now()
          WHERE company_id = ${seeded.companyId}::uuid
            AND principal_type = 'user' AND principal_id = ${owner.userId}
        `);
        await tx.execute(sql`
          DELETE FROM public.principal_permission_grants
          WHERE company_id = ${seeded.companyId}::uuid
            AND principal_type = 'user' AND principal_id = ${owner.userId}
            AND permission_key = 'work_projection_credentials:manage'
        `);
      });
      const demotionWait = await waitForDatabaseLock("UPDATE public.company_memberships");
      expect(demotionWait).toMatchObject({ waitEventType: "Lock", waitEvent: "transactionid" });

      releaseBlocker();
      await blockerTransaction;
      const created = await pendingCreate;
      expect(created.status).toBe(201);
      await pendingDemotion;
      const afterLoss = await request(managementApp(owner))
        .post(`/api/v1/companies/${seeded.companyId}/work-projection-credentials`)
        .send({ name: "after-authority-loss" });
      expect(afterLoss.status).toBe(403);
      expect(await db.select().from(companyWorkProjectionCredentials)
        .where(eq(companyWorkProjectionCredentials.name, "serialized-create"))).toHaveLength(1);
    } finally {
      releaseBlocker();
      await blockerTransaction.catch(() => undefined);
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS synthetic_block_projection_credential_audit ON public.activity_log;
        DROP FUNCTION IF EXISTS public.synthetic_block_projection_credential_audit()
      `));
    }
  });

  it("denies revoke after a concurrent demotion commits while authorization is waiting", async () => {
    const seeded = await seed();
    const owner = await boardMember(seeded.companyId, "owner");
    const created = await request(managementApp(owner))
      .post(`/api/v1/companies/${seeded.companyId}/work-projection-credentials`)
      .send({ name: "demotion-before-revoke" });
    expect(created.status).toBe(201);

    let releaseDemoter: () => void = () => undefined;
    let markDemoterReady: () => void = () => undefined;
    const demoterReady = new Promise<void>((resolve) => { markDemoterReady = resolve; });
    const holdDemoter = new Promise<void>((resolve) => { releaseDemoter = resolve; });
    const demotionTransaction = db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE public.company_memberships
        SET membership_role = 'operator', updated_at = now()
        WHERE company_id = ${seeded.companyId}::uuid
          AND principal_type = 'user' AND principal_id = ${owner.userId}
      `);
      await tx.execute(sql`
        DELETE FROM public.principal_permission_grants
        WHERE company_id = ${seeded.companyId}::uuid
          AND principal_type = 'user' AND principal_id = ${owner.userId}
          AND permission_key = 'work_projection_credentials:manage'
      `);
      markDemoterReady();
      await holdDemoter;
    });
    try {
      await demoterReady;
      const pendingRevoke = request(managementApp(owner))
        .delete(`/api/v1/companies/${seeded.companyId}/work-projection-credentials/${created.body.id}`)
        .then((response) => response);
      const revokeWait = await waitForDatabaseLock("company_memberships");
      expect(revokeWait).toMatchObject({ waitEventType: "Lock", waitEvent: "transactionid" });
      releaseDemoter();
      await demotionTransaction;
      const denied = await pendingRevoke;
      expect(denied.status).toBe(403);
      const credential = await db.select().from(companyWorkProjectionCredentials)
        .where(eq(companyWorkProjectionCredentials.id, created.body.id))
        .then((rows) => rows[0]);
      expect(credential.revokedAt).toBeNull();
      expect(await db.select().from(activityLog).where(and(
        eq(activityLog.entityId, created.body.id),
        eq(activityLog.action, "company_work_projection.credential_revoked"),
      ))).toEqual([]);
    } finally {
      releaseDemoter();
      await demotionTransaction.catch(() => undefined);
    }
  });

  it("clears implicit board authority for malformed projection-family tokens", async () => {
    const seeded = await seed();
    const malformedToken = "pcwp_future_malformed";
    const malformedHash = createHash("sha256").update(malformedToken).digest("hex");
    await db.insert(agentApiKeys).values({
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      name: "unknown-scope-collision",
      keyHash: malformedHash,
      responsibleUserId: "synthetic-user",
      scopeConfig: { kind: "unknown_future_scope" },
    });

    const localTrusted = express();
    localTrusted.use(express.json());
    localTrusted.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    localTrusted.use(companyWorkProjectionCredentialGuard());
    localTrusted.use("/api", companyWorkProjectionRoutes(db));
    localTrusted.use(errorHandler);

    const projection = await request(localTrusted)
      .get(`/api/v1/companies/${seeded.companyId}/work-projection`)
      .set("Authorization", `Bearer ${malformedToken}`);
    expect(projection.status).toBe(401);

    const mutation = await request(localTrusted)
      .post(`/api/v1/companies/${seeded.companyId}/work-projection-credentials`)
      .set("Authorization", `Bearer ${malformedToken}`)
      .send({ name: "must-not-create" });
    expect(mutation.status).toBe(403);
    expect(await db.select().from(companyWorkProjectionCredentials)
      .where(eq(companyWorkProjectionCredentials.name, "must-not-create"))).toEqual([]);
    const legacyCollision = await db.select().from(agentApiKeys)
      .where(eq(agentApiKeys.keyHash, malformedHash));
    expect(legacyCollision[0]?.lastUsedAt).toBeNull();
  });

  it("is unavailable without signing readiness for both empty and one-page collections", async () => {
    const seeded = await seed();
    const previousAgentSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    const previousAuthSecret = process.env.BETTER_AUTH_SECRET;
    try {
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      delete process.env.BETTER_AUTH_SECRET;
      const empty = await getProjection(seeded.token, seeded.companyId);
      expect(empty.status).toBe(503);
      expect(empty.body.code).toBe("WORK_PROJECTION_UNAVAILABLE");

      await addIssue(seeded.companyId);
      const onePage = await getProjection(seeded.token, seeded.companyId);
      expect(onePage.status).toBe(503);
      expect(onePage.body.code).toBe("WORK_PROJECTION_UNAVAILABLE");
    } finally {
      if (previousAgentSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousAgentSecret;
      if (previousAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = previousAuthSecret;
    }
  });

  it("paginates a stable high-water snapshot and replays cursors deterministically", async () => {
    const seeded = await seed();
    const firstId = await addIssue(seeded.companyId, { priority: "low" });
    const secondId = await addIssue(seeded.companyId, { priority: "medium" });
    const thirdId = await addIssue(seeded.companyId, { priority: "high" });

    const first = await getProjection(seeded.token, seeded.companyId, "?pageSize=1");
    expect(first.status).toBe(200);
    expect(first.body.items[0].id).toBe(firstId);
    expect(first.body.page).toMatchObject({ size: 1, hasMore: true, completeness: "partial" });

    await db.update(issues).set({ priority: "critical", updatedAt: new Date() }).where(eq(issues.id, thirdId));

    const pageTwoPath = `?cursor=${encodeURIComponent(first.body.page.nextCursor)}`;
    const second = await getProjection(seeded.token, seeded.companyId, pageTwoPath);
    const replay = await getProjection(seeded.token, seeded.companyId, pageTwoPath);
    expect(second.status).toBe(200);
    expect(replay.body).toEqual(second.body);
    expect(second.body.items[0].id).toBe(secondId);
    expect(second.body.snapshot.revision).toBe(first.body.snapshot.revision);

    const third = await getProjection(
      seeded.token,
      seeded.companyId,
      `?cursor=${encodeURIComponent(second.body.page.nextCursor)}`,
    );
    expect(third.body.items).toMatchObject([{ id: thirdId, priority: "high" }]);
    expect(third.body.page).toMatchObject({ hasMore: false, completeness: "complete" });

    const fresh = await getProjection(seeded.token, seeded.companyId, "?pageSize=10");
    expect(BigInt(fresh.body.snapshot.revision)).toBeGreaterThan(BigInt(first.body.snapshot.revision));
    expect(fresh.body.items.find((item: { id: string }) => item.id === thirdId).priority).toBe("critical");
  });

  it("replays signed snapshots byte-identically across project, agent, and member lifecycle drift", async () => {
    const seeded = await seed();
    const projectId = randomUUID();
    const userId = "synthetic-historical-owner";
    await db.insert(projects).values({
      id: projectId,
      companyId: seeded.companyId,
      name: "Synthetic replay project",
    });
    const membership = await db.insert(companyMemberships).values({
      companyId: seeded.companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    }).returning().then((rows) => rows[0]);
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      projectId,
      title: "Synthetic agent-owned replay issue",
      identifier: "REPLAY-1",
      status: "todo",
      priority: "medium",
      assigneeAgentId: seeded.agentId,
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      title: "Synthetic user-owned replay issue",
      identifier: "REPLAY-2",
      status: "todo",
      priority: "medium",
      assigneeUserId: userId,
    });

    const first = await getProjection(seeded.token, seeded.companyId, "?pageSize=1");
    const cursorPath = `?cursor=${encodeURIComponent(first.body.page.nextCursor)}`;
    const historicalPage = await getProjection(seeded.token, seeded.companyId, cursorPath);
    expect(historicalPage.status).toBe(200);

    await db.update(projects).set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(projects.id, projectId));
    await db.update(agents).set({ status: "pending_approval", updatedAt: new Date() })
      .where(eq(agents.id, seeded.agentId));
    await db.update(companyMemberships).set({ status: "archived", updatedAt: new Date() })
      .where(eq(companyMemberships.id, membership.id));

    const replay = await getProjection(seeded.token, seeded.companyId, cursorPath);
    expect(replay.body).toEqual(historicalPage.body);
    const freshInvalid = await getProjection(seeded.token, seeded.companyId, "?pageSize=10");
    expect(freshInvalid.status).toBe(409);
    expect(JSON.stringify(freshInvalid.body)).not.toContain(projectId);
    expect(JSON.stringify(freshInvalid.body)).not.toContain(seeded.agentId);
    expect(JSON.stringify(freshInvalid.body)).not.toContain(userId);

    await db.update(projects).set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(projects.id, projectId));
    await db.update(agents).set({ status: "idle", updatedAt: new Date() })
      .where(eq(agents.id, seeded.agentId));
    await db.update(companyMemberships).set({ status: "active", updatedAt: new Date() })
      .where(eq(companyMemberships.id, membership.id));
    const freshReactivated = await getProjection(seeded.token, seeded.companyId, "?pageSize=10");
    expect(freshReactivated.status).toBe(200);
    expect(freshReactivated.body.items).toHaveLength(2);
  });

  it("projects delete, hide, harness, company-move, and plugin-operation transitions without gaps", async () => {
    const seeded = await seed();
    const targetToken = `pcwp_v1_${"c".repeat(48)}`;
    await insertProjectionCredential(seeded.otherCompanyId, "target-reader", targetToken);

    const lifecycleId = await addIssue(seeded.companyId);
    const pluginId = randomUUID();
    await db.insert(issues).values({
      id: pluginId,
      companyId: seeded.companyId,
      title: "Synthetic plugin operation",
      identifier: "PLUGIN-1",
      status: "todo",
      priority: "low",
      originKind: "plugin:synthetic:operation",
    });
    expect((await getProjection(seeded.token, seeded.companyId)).body.items.map((item: { id: string }) => item.id))
      .toEqual([lifecycleId]);

    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, lifecycleId));
    expect((await getProjection(seeded.token, seeded.companyId)).body.items).toEqual([]);
    await db.update(issues).set({ hiddenAt: null }).where(eq(issues.id, lifecycleId));
    await db.update(issues).set({ harnessKind: "evaluation" }).where(eq(issues.id, lifecycleId));
    expect((await getProjection(seeded.token, seeded.companyId)).body.items).toEqual([]);
    await db.update(issues).set({ harnessKind: null }).where(eq(issues.id, lifecycleId));

    await db.update(issues).set({ originKind: "plugin:synthetic:operation" }).where(eq(issues.id, lifecycleId));
    expect((await getProjection(seeded.token, seeded.companyId)).body.items).toEqual([]);
    await db.update(issues).set({ originKind: "manual" }).where(eq(issues.id, lifecycleId));

    const movingId = await addIssue(seeded.companyId);
    await db.update(issues).set({ companyId: seeded.otherCompanyId }).where(eq(issues.id, movingId));
    expect((await getProjection(seeded.token, seeded.companyId)).body.items.map((item: { id: string }) => item.id))
      .toEqual([lifecycleId]);
    expect((await getProjection(targetToken, seeded.otherCompanyId)).body.items.map((item: { id: string }) => item.id))
      .toEqual([movingId]);

    await db.delete(issues).where(eq(issues.id, lifecycleId));
    await db.delete(issues).where(eq(issues.id, movingId));
    expect((await getProjection(seeded.token, seeded.companyId)).body.items).toEqual([]);
    expect((await getProjection(targetToken, seeded.otherCompanyId)).body.items).toEqual([]);

    for (const companyId of [seeded.companyId, seeded.otherCompanyId]) {
      const history = await db.select().from(issueWorkProjectionVersions)
        .where(eq(issueWorkProjectionVersions.companyId, companyId));
      const counter = await db.select().from(companyWorkProjectionRevisions)
        .where(eq(companyWorkProjectionRevisions.companyId, companyId));
      expect(history.map((row) => row.revision).sort((left, right) => Number(left - right))).toEqual(
        Array.from({ length: history.length }, (_, index) => BigInt(index + 1)),
      );
      expect(counter[0]?.currentRevision).toBe(BigInt(history.length));
    }
  });

  it("detects paired history/counter rollback after insert, update, delete, company move, and revision zero", async () => {
    const seeded = await seed();
    const targetToken = `pcwp_v1_${"f".repeat(48)}`;
    await insertProjectionCredential(seeded.otherCompanyId, "target-reader", targetToken);

    const revisionZero = await snapshotProjectionMaterialization(seeded.companyId);
    const issueId = await addIssue(seeded.companyId);
    const afterInsert = await snapshotProjectionMaterialization(seeded.companyId);
    await replaceProjectionMaterialization(seeded.companyId, revisionZero);
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);
    await replaceProjectionMaterialization(seeded.companyId, afterInsert);

    const beforeUpdate = await snapshotProjectionMaterialization(seeded.companyId);
    await db.update(issues).set({ priority: "high", updatedAt: new Date() })
      .where(eq(issues.id, issueId));
    const afterUpdate = await snapshotProjectionMaterialization(seeded.companyId);
    await replaceProjectionMaterialization(seeded.companyId, beforeUpdate);
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);
    await replaceProjectionMaterialization(seeded.companyId, afterUpdate);

    const beforeDelete = await snapshotProjectionMaterialization(seeded.companyId);
    await db.delete(issues).where(eq(issues.id, issueId));
    const afterDelete = await snapshotProjectionMaterialization(seeded.companyId);
    await replaceProjectionMaterialization(seeded.companyId, beforeDelete);
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);
    await replaceProjectionMaterialization(seeded.companyId, afterDelete);

    const movingIssueId = await addIssue(seeded.companyId);
    const sourceBeforeMove = await snapshotProjectionMaterialization(seeded.companyId);
    const targetBeforeMove = await snapshotProjectionMaterialization(seeded.otherCompanyId);
    await db.update(issues).set({ companyId: seeded.otherCompanyId, updatedAt: new Date() })
      .where(eq(issues.id, movingIssueId));
    const sourceAfterMove = await snapshotProjectionMaterialization(seeded.companyId);
    const targetAfterMove = await snapshotProjectionMaterialization(seeded.otherCompanyId);
    await replaceProjectionMaterialization(seeded.companyId, sourceBeforeMove);
    await replaceProjectionMaterialization(seeded.otherCompanyId, targetBeforeMove);
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);
    expect((await getProjection(targetToken, seeded.otherCompanyId)).status).toBe(409);
    await replaceProjectionMaterialization(seeded.companyId, sourceAfterMove);
    await replaceProjectionMaterialization(seeded.otherCompanyId, targetAfterMove);
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(200);
    expect((await getProjection(targetToken, seeded.otherCompanyId)).status).toBe(200);
  });

  it("separates unauthorized, forbidden, malformed, stale, expired, incompatible, and rate-limited results", async () => {
    const seeded = await seed();
    await addIssue(seeded.companyId);

    expect((await request(app()).get(`/api/v1/companies/${seeded.companyId}/work-projection`)).status).toBe(401);
    expect((await getProjection(seeded.token, seeded.otherCompanyId)).status).toBe(403);
    expect((await getProjection(seeded.token, seeded.companyId, "?pageSize=9999")).status).toBe(400);
    const standardToken = `pc_standard_${randomUUID()}`;
    await db.insert(agentApiKeys).values({
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      name: "wrong-profile",
      keyHash: createHash("sha256").update(standardToken).digest("hex"),
      responsibleUserId: "synthetic-user",
      scopeConfig: null,
    });
    expect((await getProjection(standardToken, seeded.companyId)).status).toBe(403);

    const cursorIssuedAt = new Date();
    const baseCursor = {
      apiVersion: "paperclip.company-work-projection/v1" as const,
      schemaVersion: 1 as const,
      companyId: seeded.companyId,
      issuedAt: cursorIssuedAt.toISOString(),
      expiresAt: new Date(cursorIssuedAt.getTime() + 5 * 60 * 1000).toISOString(),
      afterRevision: "0",
      afterIssueId: null,
      pageSize: 100,
    };
    const stale = encodeCompanyWorkProjectionCursor({ ...baseCursor, snapshotRevision: "999" }, signingSecret);
    const staleResponse = await getProjection(seeded.token, seeded.companyId, `?cursor=${encodeURIComponent(stale)}`);
    expect(staleResponse.status).toBe(410);
    expect(staleResponse.body.code).toBe("WORK_PROJECTION_SNAPSHOT_STALE");

    const expired = encodeCompanyWorkProjectionCursor({
      ...baseCursor,
      snapshotRevision: "1",
      issuedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-01T00:05:00.000Z",
    }, signingSecret);
    const expiredResponse = await getProjection(seeded.token, seeded.companyId, `?cursor=${encodeURIComponent(expired)}`);
    expect(expiredResponse.status).toBe(410);
    expect(expiredResponse.body.code).toBe("WORK_PROJECTION_SNAPSHOT_EXPIRED");

    const incompatiblePayload = Buffer.from(JSON.stringify({
      ...baseCursor,
      apiVersion: "paperclip.company-work-projection/v2",
      schemaVersion: 2,
      snapshotRevision: "1",
    })).toString("base64url");
    const incompatibleResponse = await getProjection(
      seeded.token,
      seeded.companyId,
      `?cursor=${encodeURIComponent(
        `${incompatiblePayload}.${signRawCursorPayload(incompatiblePayload, seeded.companyId)}`,
      )}`,
    );
    expect(incompatibleResponse.status).toBe(409);
    expect(incompatibleResponse.body.code).toBe("WORK_PROJECTION_INCOMPATIBLE");
  });

  it("enforces the shared PostgreSQL admission bound across independent connections", async () => {
    const seeded = await seed();
    let acquiredCount = 0;
    let markAllAcquired: () => void = () => undefined;
    let releaseBlockers: () => void = () => undefined;
    const allAcquired = new Promise<void>((resolve) => {
      markAllAcquired = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseBlockers = resolve;
    });
    const blockerTransactions = Array.from({ length: 4 }, (_, slot) => db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            ${`company-work-projection-admission:v1:${seeded.credentialId}:${slot}`},
            0
          )
        )
      `);
      acquiredCount += 1;
      if (acquiredCount === 4) markAllAcquired();
      await blocked;
    }));
    try {
      await allAcquired;
      const limited = await getProjection(seeded.token, seeded.companyId);
      expect(limited.status).toBe(429);
      expect(limited.headers["retry-after"]).toBe("1");
      expect(limited.body.code).toBe("WORK_PROJECTION_RATE_LIMITED");
    } finally {
      releaseBlockers();
      await Promise.all(blockerTransactions);
    }
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(200);
  });

  it("returns an explicit unavailable result when the projection store cannot be read", async () => {
    const companyId = randomUUID();
    const unavailableApp = express();
    unavailableApp.use((req, _res, next) => {
      req.actor = {
        type: "none",
        companyId,
        credentialId: randomUUID(),
        source: "none",
      };
      next();
    });
    unavailableApp.use("/api", companyWorkProjectionRoutes({
      transaction: async () => {
        throw new Error("synthetic database outage");
      },
    } as unknown as Parameters<typeof companyWorkProjectionRoutes>[0]));
    unavailableApp.use(errorHandler);

    const response = await request(unavailableApp).get(`/api/v1/companies/${companyId}/work-projection`);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("WORK_PROJECTION_UNAVAILABLE");
  });

  it("rejects every non-projection or mutation use without role-drift authority", async () => {
    const seeded = await seed();
    const beforeActivity = await db.select().from(activityLog);
    const before = await db.select().from(companyWorkProjectionCredentials)
      .where(eq(companyWorkProjectionCredentials.id, seeded.credentialId));
    await db.update(agents).set({ role: "ceo", permissions: { "tasks:assign": true } })
      .where(eq(agents.id, seeded.agentId));
    const attempts = [
      ["head", `/api/v1/companies/${seeded.companyId}/work-projection`],
      ["post", `/api/v1/companies/${seeded.companyId}/work-projection`],
      ["patch", `/api/issues/${randomUUID()}`],
      ["delete", `/api/issues/${randomUUID()}`],
      ["post", `/api/approvals/${randomUUID()}/approve`],
      ["post", `/api/issues/${randomUUID()}/assign`],
      ["post", `/api/issues/${randomUUID()}/transition`],
      ["get", `/api/v1/companies/${seeded.otherCompanyId}/work-projection`],
    ] as const;
    for (const [method, path] of attempts) {
      const response = await request(app())[method](path).set("Authorization", `Bearer ${seeded.token}`);
      expect(response.status, `${method.toUpperCase()} ${path}`).toBe(403);
      if (method !== "head") expect(response.body.code).toBe("WORK_PROJECTION_FORBIDDEN");
    }
    const jwt = createLocalAgentJwt(
      seeded.agentId,
      seeded.companyId,
      "process",
      randomUUID(),
      null,
      { kind: "standard" },
    );
    expect(jwt).not.toBeNull();
    const jwtResponse = await request(app())
      .get(`/api/v1/companies/${seeded.companyId}/work-projection`)
      .set("Authorization", `Bearer ${jwt}`);
    expect(jwtResponse.status).toBe(403);
    expect(jwtResponse.body.code).toBe("WORK_PROJECTION_FORBIDDEN");
    expect(await db.select().from(companyWorkProjectionCredentials)
      .where(eq(companyWorkProjectionCredentials.id, seeded.credentialId))).toEqual(before);
    expect(await db.select().from(activityLog)).toEqual(beforeActivity);
  });

  it("rejects runtime history deletion and fails closed for witness-event loss or unknown source state", async () => {
    const seeded = await seed();
    const issueId = await addIssue(seeded.companyId);
    await db.update(issues).set({ status: "unknown_state", updatedAt: new Date() }).where(eq(issues.id, issueId));
    const unknown = await getProjection(seeded.token, seeded.companyId);
    expect(unknown.status).toBe(409);
    expect(unknown.body.code).toBe("WORK_PROJECTION_INCOMPATIBLE");

    await db.update(issues).set({ status: "todo", updatedAt: new Date() }).where(eq(issues.id, issueId));
    try {
      await db.delete(issueWorkProjectionVersions).where(and(
        eq(issueWorkProjectionVersions.companyId, seeded.companyId),
        eq(issueWorkProjectionVersions.revision, 2n),
      ));
      throw new Error("expected append-only deletion rejection");
    } catch (error) {
      expect((error as { cause?: { message?: string } }).cause?.message).toContain("append-only");
    }

    const complete = await snapshotProjectionMaterialization(seeded.companyId);
    const missingCurrentEvent = {
      ...complete,
      sourceEvents: complete.sourceEvents.filter(
        (event) => event.revision !== complete.counter.currentRevision,
      ),
    };
    await replaceProjectionMaterialization(seeded.companyId, missingCurrentEvent);
    const gap = await getProjection(seeded.token, seeded.companyId);
    expect(gap.status).toBe(409);
    expect(gap.body.code).toBe("WORK_PROJECTION_INCOMPATIBLE");
    await replaceProjectionMaterialization(seeded.companyId, complete);
  });

  it("requires an offline verification receipt after restore and rejects an internal matched gap", async () => {
    const seeded = await seed();
    const omittedIssueId = await addIssue(seeded.companyId);
    const retainedIssueId = await addIssue(seeded.companyId);
    await db.update(issues).set({ priority: "high", updatedAt: new Date() })
      .where(eq(issues.id, retainedIssueId));
    const complete = await snapshotProjectionMaterialization(seeded.companyId);
    const omittedHistory = complete.history.find((row) => row.issueId === omittedIssueId);
    const omittedEvent = complete.sourceEvents.find((row) => row.revision === omittedHistory?.revision);
    const omittedHead = complete.heads.find((row) => row.issueId === omittedIssueId);
    if (!omittedHistory || !omittedEvent || !omittedHead) throw new Error("synthetic restore rows missing");

    await db.execute(sql`SELECT public.invalidate_company_work_projection_verification(${seeded.companyId}::uuid)`);
    await db.execute(sql.raw(
      "ALTER TABLE public.issue_work_projection_versions DISABLE TRIGGER USER; "
      + "ALTER TABLE public.company_work_projection_source_events DISABLE TRIGGER USER",
    ));
    try {
      await db.delete(companyWorkProjectionIssueHeads).where(and(
        eq(companyWorkProjectionIssueHeads.companyId, seeded.companyId),
        eq(companyWorkProjectionIssueHeads.issueId, omittedIssueId),
      ));
      await db.delete(companyWorkProjectionSourceEvents).where(and(
        eq(companyWorkProjectionSourceEvents.companyId, seeded.companyId),
        eq(companyWorkProjectionSourceEvents.revision, omittedHistory.revision),
      ));
      await db.delete(issueWorkProjectionVersions).where(and(
        eq(issueWorkProjectionVersions.companyId, seeded.companyId),
        eq(issueWorkProjectionVersions.revision, omittedHistory.revision),
      ));

      const invalidVerification = await db.execute(sql<{ verified: boolean }>`
        SELECT public.verify_company_work_projection_recovery(${seeded.companyId}::uuid) AS verified
      `);
      expect(Array.from(invalidVerification)[0]?.verified).toBe(false);
      const incomplete = await getProjection(seeded.token, seeded.companyId);
      expect(incomplete.status).toBe(409);
      expect(incomplete.body.code).toBe("WORK_PROJECTION_INCOMPATIBLE");
      expect(await db.select().from(companyWorkProjectionVerifications)
        .where(eq(companyWorkProjectionVerifications.companyId, seeded.companyId))).toEqual([]);

      await db.insert(issueWorkProjectionVersions).values(omittedHistory);
      await db.insert(companyWorkProjectionSourceEvents).values(omittedEvent);
      await db.insert(companyWorkProjectionIssueHeads).values(omittedHead);
      const recoveredVerification = await db.execute(sql<{ verified: boolean }>`
        SELECT public.verify_company_work_projection_recovery(${seeded.companyId}::uuid) AS verified
      `);
      expect(Array.from(recoveredVerification)[0]?.verified).toBe(true);
    } finally {
      await db.execute(sql.raw(
        "ALTER TABLE public.issue_work_projection_versions ENABLE TRIGGER USER; "
        + "ALTER TABLE public.company_work_projection_source_events ENABLE TRIGGER USER",
      ));
    }
    const recovered = await getProjection(seeded.token, seeded.companyId);
    expect(recovered.status).toBe(200);
    expect(recovered.body.items.map((item: { id: string }) => item.id).sort())
      .toEqual([omittedIssueId, retainedIssueId].sort());

    await db.update(companyWorkProjectionSourceWitnesses).set({
      databaseEpoch: randomUUID(),
      updatedAt: new Date(),
    }).where(eq(companyWorkProjectionSourceWitnesses.companyId, seeded.companyId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);
    const newEpochVerification = await db.execute(sql<{ verified: boolean }>`
      SELECT public.verify_company_work_projection_recovery(${seeded.companyId}::uuid) AS verified
    `);
    expect(Array.from(newEpochVerification)[0]?.verified).toBe(true);
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(200);
  });

  it("fails closed for missing, behind, ahead, and partially restored materialization state", async () => {
    const seeded = await seed();
    await addIssue(seeded.companyId);
    const complete = await snapshotProjectionMaterialization(seeded.companyId);

    await db.delete(companyWorkProjectionRevisions)
      .where(eq(companyWorkProjectionRevisions.companyId, seeded.companyId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);

    await db.insert(companyWorkProjectionRevisions).values({
      companyId: seeded.companyId,
      currentRevision: 1n,
      currentIntegrityToken: complete.counter.currentIntegrityToken,
    });
    await db.update(companyWorkProjectionRevisions).set({ currentRevision: 0n })
      .where(eq(companyWorkProjectionRevisions.companyId, seeded.companyId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);

    await db.update(companyWorkProjectionRevisions).set({ currentRevision: 2n })
      .where(eq(companyWorkProjectionRevisions.companyId, seeded.companyId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);

    await replaceProjectionMaterialization(seeded.companyId, {
      counter: complete.counter,
      history: [],
      sourceEvents: [],
      heads: [],
    });
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);

    await replaceProjectionMaterialization(seeded.companyId, complete);
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(200);
  });

  it("fails closed instead of projecting cross-company project, agent, or user references", async () => {
    const seeded = await seed();
    const issueId = await addIssue(seeded.companyId);
    const otherAgentId = randomUUID();
    const otherProjectId = randomUUID();
    const otherUserId = "synthetic-foreign-user";
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: seeded.otherCompanyId,
      name: "Synthetic foreign agent",
      role: "integration",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: otherProjectId,
      companyId: seeded.otherCompanyId,
      name: "Synthetic foreign project",
    });
    await db.insert(companyMemberships).values({
      companyId: seeded.otherCompanyId,
      principalType: "user",
      principalId: otherUserId,
      status: "active",
      membershipRole: "member",
    });

    await db.update(issues).set({ projectId: otherProjectId }).where(eq(issues.id, issueId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);
    await db.update(issues).set({ projectId: null, assigneeAgentId: otherAgentId }).where(eq(issues.id, issueId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);
    await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: otherUserId }).where(eq(issues.id, issueId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);
    await db.update(issues).set({ assigneeUserId: null }).where(eq(issues.id, issueId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(200);
  });

  it("rejects empty or whitespace-normalized source identities before evidence hashing", async () => {
    const seeded = await seed();
    const issueId = await addIssue(seeded.companyId);
    await db.update(issues).set({ identifier: "  SYN-UNSAFE  ", updatedAt: new Date() })
      .where(eq(issues.id, issueId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);

    await db.update(issues).set({ identifier: "SYN-SAFE", updatedAt: new Date() })
      .where(eq(issues.id, issueId));
    const whitespaceUserId = "  synthetic-user  ";
    await db.insert(companyMemberships).values({
      companyId: seeded.companyId,
      principalType: "user",
      principalId: whitespaceUserId,
      status: "active",
      membershipRole: "operator",
    });
    await db.update(issues).set({ assigneeUserId: whitespaceUserId, updatedAt: new Date() })
      .where(eq(issues.id, issueId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);

    await db.update(issues).set({ assigneeUserId: null, identifier: "", updatedAt: new Date() })
      .where(eq(issues.id, issueId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);
  });

  it("records trigger revisions transactionally and PostgreSQL rejects writes inside projection reads", async () => {
    const seeded = await seed();
    const issueId = await addIssue(seeded.companyId);
    await db.transaction(async (tx) => {
      await tx.update(issues).set({ status: "in_progress", updatedAt: new Date() }).where(eq(issues.id, issueId));
      const revisions = await tx.select().from(issueWorkProjectionVersions)
        .where(eq(issueWorkProjectionVersions.companyId, seeded.companyId));
      expect(revisions.map((row) => row.revision)).toEqual([1n, 2n]);
    });

    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw("SET TRANSACTION READ ONLY"));
        await tx.update(companyWorkProjectionCredentials).set({ revokedAt: new Date() })
          .where(eq(companyWorkProjectionCredentials.id, seeded.credentialId));
      });
      throw new Error("expected PostgreSQL read-only enforcement");
    } catch (error) {
      expect((error as { cause?: { code?: string } }).cause?.code).toBe("25006");
    }
  });
});
