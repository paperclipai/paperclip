import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { secretRoutes } from "../routes/secrets.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres secret binding revoke tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("DELETE /secrets/:secretId/bindings/:bindingId", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-secret-binding-revoke-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("secret-binding-revoke");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(name = "Revoke Co") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  function createApp(companyIds: string[] = []) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds,
        memberships: companyIds.map((companyId) => ({
          companyId,
          status: "active",
          membershipRole: "admin",
        })),
      };
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedBoundAgent(companyId: string, envKey = "SUPABASE_KEECE_TOKEN") {
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `supabase-${randomUUID()}`,
      provider: "local_encrypted",
      value: "sbp_live_value",
    });
    const agent = await agentService(db).create(companyId, {
      name: "Bound Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          [envKey]: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    const [binding] = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, agent.id),
      ));
    return { secret, agent, binding, envKey };
  }

  it("removes the secret ref from adapterConfig and drops the binding row", async () => {
    const companyId = await seedCompany();
    const { secret, agent, binding, envKey } = await seedBoundAgent(companyId);

    const res = await request(createApp([companyId])).delete(
      `/api/secrets/${secret.id}/bindings/${binding.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const reloaded = await agentService(db).getById(agent.id);
    expect(reloaded?.adapterConfig).toMatchObject({ env: {} });
    expect(JSON.stringify(reloaded?.adapterConfig)).not.toContain(envKey);

    const remainingBindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.id, binding.id));
    expect(remainingBindings).toHaveLength(0);

    expect(await db.select().from(secretAccessEvents)).toEqual([
      expect.objectContaining({
        secretId: secret.id,
        consumerType: "agent",
        consumerId: agent.id,
        configPath: `env.${envKey}`,
        outcome: "revoked",
      }),
    ]);
  });

  it("refuses to revoke when the config path no longer holds this binding's secret (stale binding)", async () => {
    const companyId = await seedCompany();
    const { secret, agent, binding, envKey } = await seedBoundAgent(companyId);
    const otherSecret = await secretService(db).create(companyId, {
      name: `other-${randomUUID()}`,
      provider: "local_encrypted",
      value: "other-value",
    });

    // Bypass agentService.update's binding resync to model the binding row
    // (company_secret_bindings) going stale relative to adapterConfig — the
    // scenario a concurrent config write produces mid-request, since a normal
    // update would delete-and-recreate this exact binding row instead.
    const current = await agentService(db).getById(agent.id);
    await db
      .update(agents)
      .set({
        adapterConfig: {
          ...(current?.adapterConfig as Record<string, unknown>),
          env: {
            [envKey]: { type: "secret_ref", secretId: otherSecret.id, version: "latest" },
          },
        },
      })
      .where(eq(agents.id, agent.id));

    const res = await request(createApp([companyId])).delete(
      `/api/secrets/${secret.id}/bindings/${binding.id}`,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("secret_binding_stale");

    const reloaded = await agentService(db).getById(agent.id);
    expect(
      (reloaded?.adapterConfig as { env?: Record<string, unknown> } | undefined)?.env?.[envKey],
    ).toMatchObject({ secretId: otherSecret.id });
  });

  it("keeps the binding gone after a later unrelated adapterConfig write (replaceAll re-derivation trap)", async () => {
    const companyId = await seedCompany();
    const { secret, agent, binding } = await seedBoundAgent(companyId);

    const res = await request(createApp([companyId])).delete(
      `/api/secrets/${secret.id}/bindings/${binding.id}`,
    );
    expect(res.status).toBe(200);

    const afterRevoke = await agentService(db).getById(agent.id);
    await agentService(db).update(agent.id, {
      adapterConfig: { ...(afterRevoke?.adapterConfig as Record<string, unknown>), unrelatedFlag: true },
    });

    const remainingBindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, agent.id),
      ));
    expect(remainingBindings).toHaveLength(0);
  });

  it("no longer projects the secret value into the target's runtime env after revoke", async () => {
    const companyId = await seedCompany();
    const { secret, agent, binding, envKey } = await seedBoundAgent(companyId);

    await request(createApp([companyId])).delete(
      `/api/secrets/${secret.id}/bindings/${binding.id}`,
    );

    const reloaded = await agentService(db).getById(agent.id);
    const resolved = await secretService(db).resolveAdapterConfigForRuntime(
      companyId,
      reloaded?.adapterConfig,
      { consumerType: "agent", consumerId: agent.id },
      { adapterType: "codex_local" },
    );
    expect(JSON.stringify(resolved.config)).not.toContain("sbp_live_value");
    expect((resolved.config as { env?: Record<string, unknown> }).env?.[envKey]).toBeUndefined();
  });

  it("rejects revoking a binding that belongs to another company", async () => {
    const companyId = await seedCompany("Owner Co");
    const otherCompanyId = await seedCompany("Other Co");
    const { secret, binding } = await seedBoundAgent(companyId);

    const res = await request(createApp([otherCompanyId])).delete(
      `/api/secrets/${secret.id}/bindings/${binding.id}`,
    );
    expect(res.status).toBe(404);

    const stillThere = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.id, binding.id));
    expect(stillThere).toHaveLength(1);
  });

  it("names the target type honestly instead of silently no-op'ing unsupported bindings", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `project-${randomUUID()}`,
      provider: "local_encrypted",
      value: "project-value",
    });
    const binding = await secrets.createBinding({
      companyId,
      secretId: secret.id,
      targetType: "project",
      targetId: randomUUID(),
      configPath: "env.PROJECT_KEY",
    });

    const res = await request(createApp([companyId])).delete(
      `/api/secrets/${secret.id}/bindings/${binding.id}`,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("binding_target_unsupported");

    const stillThere = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.id, binding.id));
    expect(stillThere).toHaveLength(1);
  });
});
