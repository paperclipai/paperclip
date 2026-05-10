import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  companySecrets,
  createDb,
} from "@paperclipai/db";
import {
  accountDir,
  provisionOauthAccount,
} from "@paperclipai/adapter-claude-local/server";
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
  let paperclipHomeDir!: string;
  let previousPaperclipHome: string | undefined;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("anthropic-accounts");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    paperclipHomeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-anthropic-accounts-test-"),
    );
    previousPaperclipHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = paperclipHomeDir;
  });

  afterEach(async () => {
    await db.delete(anthropicAccountSwitches);
    await db.delete(anthropicActiveAccount);
    await db.delete(anthropicAccounts);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousPaperclipHome;
    if (paperclipHomeDir) {
      await fs.rm(paperclipHomeDir, { recursive: true, force: true });
    }
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

  describe("listHealthyCandidates", () => {
    it("returns oauth/api_key siblings under the 80% utilization threshold, sorted by lowest utilization, excluding the current account", async () => {
      const companyId = await seedCompany();
      const svc = anthropicAccountsService(db);
      const current = await svc.createAccount({ companyId, label: "Current", mode: "oauth" });
      const lowUsage = await svc.createAccount({ companyId, label: "Low", mode: "oauth" });
      const midUsage = await svc.createAccount({ companyId, label: "Mid", mode: "oauth" });
      const overLimit = await svc.createAccount({ companyId, label: "Over", mode: "oauth" });
      const noData = await svc.createAccount({ companyId, label: "Unknown", mode: "oauth" });

      await db
        .update(anthropicAccounts)
        .set({ lastUtilizationFiveHour: "20" })
        .where(eq(anthropicAccounts.id, lowUsage.id));
      await db
        .update(anthropicAccounts)
        .set({ lastUtilizationFiveHour: "65" })
        .where(eq(anthropicAccounts.id, midUsage.id));
      await db
        .update(anthropicAccounts)
        .set({ lastUtilizationFiveHour: "85" })
        .where(eq(anthropicAccounts.id, overLimit.id));
      // noData has lastUtilizationFiveHour=null → excluded (we don't know if it's healthy).

      const candidates = await svc.listHealthyCandidates(companyId, current.id);
      expect(candidates.map((c) => c.id)).toEqual([lowUsage.id, midUsage.id]);
      expect(candidates[0]).toMatchObject({
        id: lowUsage.id,
        label: "Low",
        mode: "oauth",
        lastUtilizationFiveHour: 20,
      });
      // The current account, the over-limit account, and the no-data account
      // are all excluded.
      expect(candidates.find((c) => c.id === current.id)).toBeUndefined();
      expect(candidates.find((c) => c.id === overLimit.id)).toBeUndefined();
      expect(candidates.find((c) => c.id === noData.id)).toBeUndefined();
    });

    it("excludes bedrock accounts (no subscription quota to compare against)", async () => {
      const companyId = await seedCompany();
      const svc = anthropicAccountsService(db);
      const current = await svc.createAccount({ companyId, label: "Current", mode: "oauth" });
      const bedrock = await svc.createAccount({ companyId, label: "AWS", mode: "bedrock" });
      // Even with low utilization stored, bedrock should not be a candidate.
      await db
        .update(anthropicAccounts)
        .set({ lastUtilizationFiveHour: "10" })
        .where(eq(anthropicAccounts.id, bedrock.id));

      const candidates = await svc.listHealthyCandidates(companyId, current.id);
      expect(candidates).toHaveLength(0);
    });

    it("only considers accounts in the same company", async () => {
      const companyA = await seedCompany("A");
      const companyB = await seedCompany("B");
      const svc = anthropicAccountsService(db);
      const currentA = await svc.createAccount({ companyId: companyA, label: "Current A", mode: "oauth" });
      const otherB = await svc.createAccount({ companyId: companyB, label: "B", mode: "oauth" });
      await db
        .update(anthropicAccounts)
        .set({ lastUtilizationFiveHour: "10" })
        .where(eq(anthropicAccounts.id, otherB.id));

      const candidates = await svc.listHealthyCandidates(companyA, currentA.id);
      expect(candidates).toHaveLength(0);
    });
  });

  describe("logSwitch", () => {
    it("inserts an audit row with runId, from/to account, and reason", async () => {
      const companyId = await seedCompany();
      const svc = anthropicAccountsService(db);
      const from = await svc.createAccount({ companyId, label: "From", mode: "oauth" });
      const to = await svc.createAccount({ companyId, label: "To", mode: "oauth" });

      await svc.logSwitch({
        runId: "run-xyz",
        fromAccountId: from.id,
        toAccountId: to.id,
        reason: "auto:rate_limit",
      });

      const rows = await db
        .select()
        .from(anthropicAccountSwitches)
        .where(eq(anthropicAccountSwitches.toAccountId, to.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        runId: "run-xyz",
        fromAccountId: from.id,
        toAccountId: to.id,
        reason: "auto:rate_limit",
      });
      expect(rows[0]!.switchedAt).toBeInstanceOf(Date);
    });

    it("accepts a null fromAccountId for system-initiated switches without a known prior account", async () => {
      const companyId = await seedCompany();
      const svc = anthropicAccountsService(db);
      const to = await svc.createAccount({ companyId, label: "To", mode: "oauth" });

      await svc.logSwitch({
        runId: null,
        fromAccountId: null,
        toAccountId: to.id,
        reason: "system:bootstrap",
      });

      const rows = await db
        .select()
        .from(anthropicAccountSwitches)
        .where(eq(anthropicAccountSwitches.toAccountId, to.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.fromAccountId).toBeNull();
      expect(rows[0]!.runId).toBeNull();
    });
  });

  describe("deleteAccount cleanup (MAS-285)", () => {
    async function dirExists(dir: string): Promise<boolean> {
      try {
        await fs.access(dir);
        return true;
      } catch {
        return false;
      }
    }

    it("removes the on-disk credential directory created by provisionOauthAccount", async () => {
      const companyId = await seedCompany();
      const svc = anthropicAccountsService(db);
      const account = await svc.createAccount({
        companyId,
        label: "OAuth",
        mode: "oauth",
      });
      await provisionOauthAccount(account.id);
      const dir = accountDir(account.id);
      // Drop a fake credentials file so we know rm actually removed contents.
      await fs.writeFile(
        path.join(dir, ".credentials.json"),
        JSON.stringify({ access_token: "fake" }),
        { mode: 0o600 },
      );
      expect(await dirExists(dir)).toBe(true);

      await svc.deleteAccount(account.id);

      expect(await dirExists(dir)).toBe(false);
      const remaining = await db
        .select()
        .from(anthropicAccounts)
        .where(eq(anthropicAccounts.id, account.id));
      expect(remaining).toHaveLength(0);
    });

    it("does not throw when no on-disk directory exists for the account", async () => {
      const companyId = await seedCompany();
      const svc = anthropicAccountsService(db);
      const account = await svc.createAccount({
        companyId,
        label: "Bedrock",
        mode: "bedrock",
      });
      // No provisionOauthAccount → no directory on disk; delete must still succeed.
      await expect(svc.deleteAccount(account.id)).resolves.toBeUndefined();
    });

    it("deletes the linked company_secrets row when apiKeySecretId is set", async () => {
      const companyId = await seedCompany();
      const svc = anthropicAccountsService(db);

      const [secret] = await db
        .insert(companySecrets)
        .values({
          companyId,
          key: "anthropic-api-key",
          name: "Anthropic API Key",
          provider: "local_encrypted",
          managedMode: "paperclip_managed",
          latestVersion: 1,
        })
        .returning();
      expect(secret).toBeDefined();

      const account = await svc.createAccount({
        companyId,
        label: "API Key",
        mode: "api_key",
        apiKeySecretId: secret!.id,
      });

      await svc.deleteAccount(account.id);

      const secretRows = await db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.id, secret!.id));
      expect(secretRows).toHaveLength(0);
      const accountRows = await db
        .select()
        .from(anthropicAccounts)
        .where(eq(anthropicAccounts.id, account.id));
      expect(accountRows).toHaveLength(0);
    });

    it("leaves company_secrets untouched when apiKeySecretId is null (oauth account)", async () => {
      const companyId = await seedCompany();
      const svc = anthropicAccountsService(db);

      const [unrelatedSecret] = await db
        .insert(companySecrets)
        .values({
          companyId,
          key: "unrelated",
          name: "Unrelated Secret",
          provider: "local_encrypted",
          managedMode: "paperclip_managed",
          latestVersion: 1,
        })
        .returning();

      const account = await svc.createAccount({
        companyId,
        label: "OAuth",
        mode: "oauth",
      });

      await svc.deleteAccount(account.id);

      const remaining = await db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.id, unrelatedSecret!.id));
      expect(remaining).toHaveLength(1);
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
