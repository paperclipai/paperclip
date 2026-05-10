import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  anthropicAccountSwitches,
  anthropicAccounts,
  anthropicActiveAccount,
  companies,
  createDb,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { anthropicAccountsRoutes } from "../routes/anthropic-accounts.js";
import { anthropicAccountsService } from "../services/anthropic-accounts.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping anthropic-accounts tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("anthropic-accounts", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("anthropic-accounts");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(anthropicAccountSwitches);
    await db.delete(anthropicActiveAccount);
    await db.delete(anthropicAccounts);
    await db.delete(agents);
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany(name = "Acme") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: [companyId],
        memberships: [
          { companyId, status: "active", membershipRole: "admin" },
        ],
      };
      next();
    });
    app.use("/api", anthropicAccountsRoutes(db));
    app.use(errorHandler);
    return app;
  }

  describe("REST CRUD lifecycle", () => {
    it("POST → GET → PUT active → GET → DELETE", async () => {
      const companyId = await seedCompany();
      const app = createApp(companyId);

      // GET empty list
      const empty = await request(app).get(
        `/api/companies/${companyId}/anthropic-accounts`,
      );
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual([]);

      // POST
      const created = await request(app)
        .post(`/api/companies/${companyId}/anthropic-accounts`)
        .send({ label: "Primary OAuth", mode: "oauth" });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        companyId,
        label: "Primary OAuth",
        mode: "oauth",
      });
      const accountId = created.body.id as string;
      expect(typeof accountId).toBe("string");

      // GET list
      const listed = await request(app).get(
        `/api/companies/${companyId}/anthropic-accounts`,
      );
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0].id).toBe(accountId);

      // PUT active (no active yet → 404)
      const noActive = await request(app).get(
        `/api/companies/${companyId}/anthropic-accounts/active`,
      );
      expect(noActive.status).toBe(404);

      // PUT active
      const activated = await request(app)
        .put(`/api/companies/${companyId}/anthropic-accounts/active`)
        .send({ accountId });
      expect(activated.status).toBe(200);
      expect(activated.body.accountId).toBe(accountId);
      expect(activated.body.account.id).toBe(accountId);

      // GET active
      const active = await request(app).get(
        `/api/companies/${companyId}/anthropic-accounts/active`,
      );
      expect(active.status).toBe(200);
      expect(active.body.accountId).toBe(accountId);

      // DELETE while active → 409
      const deleteActive = await request(app).delete(
        `/api/companies/${companyId}/anthropic-accounts/${accountId}`,
      );
      expect(deleteActive.status).toBe(409);

      // Add second account, switch to it, then delete first
      const second = await request(app)
        .post(`/api/companies/${companyId}/anthropic-accounts`)
        .send({ label: "Backup OAuth", mode: "oauth" });
      expect(second.status).toBe(201);
      const secondId = second.body.id as string;

      const switched = await request(app)
        .put(`/api/companies/${companyId}/anthropic-accounts/active`)
        .send({ accountId: secondId });
      expect(switched.status).toBe(200);
      expect(switched.body.accountId).toBe(secondId);

      const deleteFirst = await request(app).delete(
        `/api/companies/${companyId}/anthropic-accounts/${accountId}`,
      );
      expect(deleteFirst.status).toBe(200);
      expect(deleteFirst.body).toEqual({ ok: true });

      const remaining = await request(app).get(
        `/api/companies/${companyId}/anthropic-accounts`,
      );
      expect(remaining.body).toHaveLength(1);
      expect(remaining.body[0].id).toBe(secondId);
    });

    it("rejects mode=api_key without apiKeySecretId", async () => {
      const companyId = await seedCompany();
      const app = createApp(companyId);
      const res = await request(app)
        .post(`/api/companies/${companyId}/anthropic-accounts`)
        .send({ label: "API Key", mode: "api_key" });
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toMatch(/apiKeySecretId/);
    });

    it("rejects accountId for a different company on PUT active", async () => {
      const companyA = await seedCompany("A");
      const companyB = await seedCompany("B");
      const appA = createApp(companyA);

      // Create an account in company B directly via DB
      const [foreign] = await db
        .insert(anthropicAccounts)
        .values({ companyId: companyB, label: "Foreign", mode: "oauth" })
        .returning();

      const res = await request(appA)
        .put(`/api/companies/${companyA}/anthropic-accounts/active`)
        .send({ accountId: foreign!.id });
      expect(res.status).toBe(404);
    });

    it("rejects DELETE for an account in a different company", async () => {
      const companyA = await seedCompany("A");
      const companyB = await seedCompany("B");
      const appA = createApp(companyA);

      const [foreign] = await db
        .insert(anthropicAccounts)
        .values({ companyId: companyB, label: "Foreign", mode: "oauth" })
        .returning();

      const res = await request(appA).delete(
        `/api/companies/${companyA}/anthropic-accounts/${foreign!.id}`,
      );
      expect(res.status).toBe(404);
    });
  });

  describe("resolveActiveForAgent", () => {
    it("returns the company-active account when agent has no override", async () => {
      const companyId = await seedCompany();
      const svc = anthropicAccountsService(db);
      const account = await svc.createAccount({
        companyId,
        label: "Default",
        mode: "oauth",
      });
      await svc.setActiveAccount(companyId, account.id, { userId: "user-1" });

      const [agent] = await db
        .insert(agents)
        .values({
          companyId,
          name: "Worker",
          role: "engineer",
          adapterType: "claude_local",
          adapterConfig: {},
        })
        .returning();

      const resolved = await svc.resolveActiveForAgent(companyId, agent!.id);
      expect(resolved.id).toBe(account.id);
    });

    it("applies per-agent override from adapterConfig.anthropicAccountId", async () => {
      const companyId = await seedCompany();
      const svc = anthropicAccountsService(db);
      const defaultAcc = await svc.createAccount({
        companyId,
        label: "Default",
        mode: "oauth",
      });
      const overrideAcc = await svc.createAccount({
        companyId,
        label: "Override",
        mode: "oauth",
      });
      await svc.setActiveAccount(companyId, defaultAcc.id, { userId: "user-1" });

      const [agent] = await db
        .insert(agents)
        .values({
          companyId,
          name: "Worker",
          role: "engineer",
          adapterType: "claude_local",
          adapterConfig: { anthropicAccountId: overrideAcc.id },
        })
        .returning();

      const resolved = await svc.resolveActiveForAgent(companyId, agent!.id);
      expect(resolved.id).toBe(overrideAcc.id);
    });

    it("falls back to company-active when override points at a deleted account", async () => {
      const companyId = await seedCompany();
      const svc = anthropicAccountsService(db);
      const defaultAcc = await svc.createAccount({
        companyId,
        label: "Default",
        mode: "oauth",
      });
      await svc.setActiveAccount(companyId, defaultAcc.id, { userId: "user-1" });

      const [agent] = await db
        .insert(agents)
        .values({
          companyId,
          name: "Worker",
          role: "engineer",
          adapterType: "claude_local",
          adapterConfig: { anthropicAccountId: randomUUID() },
        })
        .returning();

      const resolved = await svc.resolveActiveForAgent(companyId, agent!.id);
      expect(resolved.id).toBe(defaultAcc.id);
    });

    it("rejects override pointing at an account in another company", async () => {
      const companyA = await seedCompany("A");
      const companyB = await seedCompany("B");
      const svc = anthropicAccountsService(db);
      const defaultAcc = await svc.createAccount({
        companyId: companyA,
        label: "Default",
        mode: "oauth",
      });
      const foreignAcc = await svc.createAccount({
        companyId: companyB,
        label: "Foreign",
        mode: "oauth",
      });
      await svc.setActiveAccount(companyA, defaultAcc.id, { userId: "user-1" });

      const [agent] = await db
        .insert(agents)
        .values({
          companyId: companyA,
          name: "Worker",
          role: "engineer",
          adapterType: "claude_local",
          adapterConfig: { anthropicAccountId: foreignAcc.id },
        })
        .returning();

      // Foreign override should be ignored, falls back to default
      const resolved = await svc.resolveActiveForAgent(companyA, agent!.id);
      expect(resolved.id).toBe(defaultAcc.id);
    });
  });

  describe("setActiveAccount concurrency", () => {
    it("serialises concurrent switches to a single consistent pointer", async () => {
      const companyId = await seedCompany();
      const svc = anthropicAccountsService(db);
      const accountA = await svc.createAccount({
        companyId,
        label: "A",
        mode: "oauth",
      });
      const accountB = await svc.createAccount({
        companyId,
        label: "B",
        mode: "oauth",
      });

      // Race two setActiveAccount calls. The advisory xact lock guarantees
      // only one succeeds at any moment; final pointer must be exactly one
      // of the two accounts.
      const results = await Promise.all([
        svc.setActiveAccount(companyId, accountA.id, { userId: "user-1" }),
        svc.setActiveAccount(companyId, accountB.id, { userId: "user-1" }),
      ]);
      const winners = new Set(results.map((r) => r.account.id));
      expect(winners.size).toBeGreaterThanOrEqual(1);

      const stored = await db
        .select()
        .from(anthropicActiveAccount)
        .where(eq(anthropicActiveAccount.companyId, companyId));
      expect(stored).toHaveLength(1);
      expect([accountA.id, accountB.id]).toContain(stored[0]!.accountId);
    });
  });
});
