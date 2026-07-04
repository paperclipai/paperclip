import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecretVersions,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import { secretRoutes } from "../routes/secrets.js";
import { secretService } from "../services/secrets.js";
import { errorHandler } from "../middleware/error-handler.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const secretsTmpDir = path.join(os.tmpdir(), `paperclip-cto-secret-metadata-${randomUUID()}`);
mkdirSync(secretsTmpDir, { recursive: true });
process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping CTO secret metadata route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

function buildApp(db: Db, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", secretRoutes(db as any));
  app.use(errorHandler);
  return app;
}

async function createCompany(db: Db, name: string) {
  const issuePrefix = `M${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  return db
    .insert(companies)
    .values({ name, issuePrefix })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(
  db: Db,
  input: { companyId: string; name?: string; role: string; reportsTo?: string | null },
) {
  return db
    .insert(agents)
    .values({
      companyId: input.companyId,
      name: input.name ?? `agent-${input.role}-${randomUUID().slice(0, 6)}`,
      role: input.role,
      adapterType: "process",
      reportsTo: input.reportsTo ?? null,
      permissions: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedMember(db: Db, companyId: string, userId: string) {
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole: "owner",
  });
}

async function seedLocalEncryptedSecret(db: Db, companyId: string, name: string, value: string) {
  const svc = secretService(db);
  const created = await svc.create(companyId, {
    name,
    provider: "local_encrypted",
    managedMode: "paperclip_managed",
    value,
    description: `Secret ${name}`,
  });
  await db
    .update(companySecrets)
    .set({
      providerMetadata: { environment: "production" },
    })
    .where(eq(companySecrets.id, created.id));
  return created.id;
}

describeEmbeddedPostgres("GET /api/companies/:companyId/secrets/metadata (CTO read-only)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cto-secret-metadata-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  it("returns metadata only (never value) for an agent with role 'cto'", async () => {
    const company = await createCompany(db, "Acme");
    const cto = await createAgent(db, { companyId: company.id, role: "cto", name: "CTO Agent" });
    const secretId = await seedLocalEncryptedSecret(db, company.id, "OPENAI_API_KEY", "sk-shhh-this-is-secret-value");

    const res = await request(
      buildApp(db, {
        type: "agent",
        agentId: cto.id,
        companyId: company.id,
        source: "agent_key",
      }),
    ).get(`/api/companies/${company.id}/secrets/metadata`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      secrets: [
        {
          id: secretId,
          name: "OPENAI_API_KEY",
          key: "openai_api_key",
          provider: "local_encrypted",
          managedMode: "paperclip_managed",
          status: "active",
          latestVersion: 1,
          providerMetadata: { environment: "production" },
          referenceCount: 0,
          description: "Secret OPENAI_API_KEY",
        },
      ],
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("sk-shhh-this-is-secret-value");
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("material");
    expect(serialized).not.toContain("value");
    expect(res.body.secrets[0]).not.toHaveProperty("value");
    expect(res.body.secrets[0]).not.toHaveProperty("material");

    const auditRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, company.id));
    const metadataReads = auditRows.filter((row) => row.action === "secret.metadata.read");
    expect(metadataReads).toHaveLength(1);
    expect(metadataReads[0]).toMatchObject({
      companyId: company.id,
      actorType: "agent",
      actorId: cto.id,
      action: "secret.metadata.read",
      entityType: "secret",
      details: { count: 1, scope: "company_secrets_metadata" },
    });
  });

  it("rejects agents that are not the company CTO", async () => {
    const company = await createCompany(db, "Bravo");
    const engineer = await createAgent(db, { companyId: company.id, role: "engineer" });

    const res = await request(
      buildApp(db, {
        type: "agent",
        agentId: engineer.id,
        companyId: company.id,
        source: "agent_key",
      }),
    ).get(`/api/companies/${company.id}/secrets/metadata`);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/CTO role required/);
    const auditRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "secret.metadata.read"));
    expect(auditRows).toHaveLength(0);
  });

  it("rejects board actors (additive boundary \u2014 board-only writes still on existing route)", async () => {
    const company = await createCompany(db, "Charlie");
    await seedMember(db, company.id, "user-board-1");

    const res = await request(
      buildApp(db, {
        type: "board",
        userId: "user-board-1",
        source: "session",
        companyIds: [company.id],
        memberships: [{ companyId: company.id, status: "active", membershipRole: "owner" }],
        isInstanceAdmin: false,
      }),
    ).get(`/api/companies/${company.id}/secrets/metadata`);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/Agent authentication required/);
  });

  it("rejects CTO agents whose companyId does not match the route parameter", async () => {
    const companyA = await createCompany(db, "Delta-A");
    const companyB = await createCompany(db, "Delta-B");
    const ctoOfB = await createAgent(db, { companyId: companyB.id, role: "cto" });

    const res = await request(
      buildApp(db, {
        type: "agent",
        agentId: ctoOfB.id,
        companyId: companyB.id,
        source: "agent_key",
      }),
    ).get(`/api/companies/${companyA.id}/secrets/metadata`);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/Agent does not belong to this company/);
  });
});
