import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function expectStillPending(promise: Promise<unknown>) {
  const state = await Promise.race([
    promise.then(() => "settled", () => "settled"),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 40)),
  ]);
  expect(state).toBe("pending");
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent secret binding tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service secret binding sync", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let contenderDb!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-secret-bindings-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("agent-secret-bindings");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    contenderDb = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
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

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgentOwnedSecret() {
    const companyId = await seedCompany();
    const owner = await agentService(db).create(companyId, {
      name: `Owner-${randomUUID()}`,
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: { env: {} },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    const secret = await secretService(db).create(
      companyId,
      {
        name: `owner-race-${randomUUID()}`,
        provider: "local_encrypted",
        value: `race-value-${randomUUID()}`,
      },
      { userId: null, agentId: owner.id },
    );
    return { companyId, owner, secret };
  }

  it("serializes owner delete after a winning adapter binding so binding and config survive", async () => {
    const { companyId, owner, secret } = await seedAgentOwnedSecret();
    const bindingCommitted = deferred<void>();
    const releaseBinding = deferred<void>();
    const bindingPromise = db.transaction(async (tx) => {
      const updated = await agentService(tx as unknown as ReturnType<typeof createDb>).update(owner.id, {
        adapterConfig: {
          env: {
            RACE_SECRET: { type: "secret_ref", secretId: secret.id, version: "latest" },
          },
        },
      });
      bindingCommitted.resolve();
      await releaseBinding.promise;
      return updated;
    });

    await bindingCommitted.promise;
    const deletePromise = secretService(contenderDb).removeOwnedUnboundCompanySecret({
      secretId: secret.id,
      companyId,
      agentId: owner.id,
    });
    await expectStillPending(deletePromise);
    releaseBinding.resolve();
    await bindingPromise;
    await expect(deletePromise).rejects.toMatchObject({
      status: 403,
      message: "Secret is still bound and cannot be deleted",
    });

    const [persistedSecret, persistedOwner, bindings] = await Promise.all([
      secretService(db).getById(secret.id),
      agentService(db).getById(owner.id),
      db.select().from(companySecretBindings).where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, owner.id),
      )),
    ]);
    expect(persistedSecret?.status).toBe("active");
    expect(persistedOwner?.adapterConfig).toMatchObject({
      env: { RACE_SECRET: { type: "secret_ref", secretId: secret.id, version: "latest" } },
    });
    expect(bindings).toEqual([expect.objectContaining({
      secretId: secret.id,
      configPath: "env.RACE_SECRET",
    })]);
  });

  it("serializes a winning owner delete so a later adapter binding and config both roll back", async () => {
    const { companyId, owner, secret } = await seedAgentOwnedSecret();
    const deleteCommitted = deferred<void>();
    const releaseDelete = deferred<void>();
    const deletePromise = db.transaction(async (tx) => {
      const removed = await secretService(tx as unknown as ReturnType<typeof createDb>)
        .removeOwnedUnboundCompanySecret({
          secretId: secret.id,
          companyId,
          agentId: owner.id,
        });
      deleteCommitted.resolve();
      await releaseDelete.promise;
      return removed;
    });

    await deleteCommitted.promise;
    const bindingPromise = agentService(contenderDb).update(owner.id, {
      adapterConfig: {
        env: {
          RACE_SECRET: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
    });
    await expectStillPending(bindingPromise);
    releaseDelete.resolve();
    await expect(deletePromise).resolves.toMatchObject({ id: secret.id });
    await expect(bindingPromise).rejects.toMatchObject({
      status: 404,
      message: "Secret not found",
    });

    const [persistedSecret, persistedOwner, bindings] = await Promise.all([
      secretService(db).getById(secret.id),
      agentService(db).getById(owner.id),
      db.select().from(companySecretBindings).where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, owner.id),
      )),
    ]);
    expect(persistedSecret).toBeNull();
    expect(persistedOwner?.adapterConfig).toMatchObject({ env: {} });
    expect(bindings).toHaveLength(0);
  });

  it("creates agent secret bindings when a new agent persists secret_ref env", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `anthropic-${randomUUID()}`,
      provider: "local_encrypted",
      value: "sk-ant-123",
    });

    const created = await agentService(db).create(companyId, {
      name: "Claude Novita",
      role: "engineer",
      status: "pending_approval",
      adapterType: "claude_local",
      adapterConfig: {
        env: {
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "env.ANTHROPIC_API_KEY",
      versionSelector: "latest",
      required: true,
    });
  });

  it("stores approved class-3 env lease metadata on agent secret bindings", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `slack-${randomUUID()}`,
      provider: "local_encrypted",
      value: "slack-test-token",
    });

    const created = await agentService(db).create(companyId, {
      name: "Slack Briefing",
      role: "briefing",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          SLACK_BOT_TOKEN: {
            type: "secret_ref",
            secretId: secret.id,
            version: "latest",
            projectionClass: "class_3_static_lease",
            projectionAllowlistKey: "slack.bot_token",
          },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "env.SLACK_BOT_TOKEN",
      projectionClass: "class_3_static_lease",
      projectionAllowlistKey: "slack.bot_token",
    });
  });

  it("persists and reads back the three exact AWS class-3 preflight refs without serializing their sentinels", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const sentinels = [
      `aws-access-${randomUUID()}`,
      `aws-secret-${randomUUID()}`,
      `aws-session-${randomUUID()}`,
    ];
    const [accessKey, secretAccessKey, sessionToken] = await Promise.all(
      sentinels.map((value, index) => secrets.create(companyId, {
        name: `aws-preflight-${index}-${randomUUID()}`,
        provider: "local_encrypted",
        value,
      })),
    );
    const expectedEnv = {
      AWS_ACCESS_KEY_ID: {
        type: "secret_ref",
        secretId: accessKey.id,
        version: "latest",
        projectionClass: "class_3_static_lease",
        projectionAllowlistKey: "aws.games_logging_preflight.access_key_id",
      },
      AWS_SECRET_ACCESS_KEY: {
        type: "secret_ref",
        secretId: secretAccessKey.id,
        version: "latest",
        projectionClass: "class_3_static_lease",
        projectionAllowlistKey: "aws.games_logging_preflight.secret_access_key",
      },
      AWS_SESSION_TOKEN: {
        type: "secret_ref",
        secretId: sessionToken.id,
        version: "latest",
        projectionClass: "class_3_static_lease",
        projectionAllowlistKey: "aws.games_logging_preflight.session_token",
      },
    };

    const created = await agentService(db).create(companyId, {
      name: "AWS Games Logging Preflight",
      role: "operator",
      adapterType: "codex_local",
      adapterConfig: { env: expectedEnv },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    const reloaded = await agentService(db).getById(created.id);
    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));

    expect(reloaded?.adapterConfig).toMatchObject({ env: expectedEnv });
    expect(bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        secretId: accessKey.id,
        configPath: "env.AWS_ACCESS_KEY_ID",
        projectionClass: "class_3_static_lease",
        projectionAllowlistKey: "aws.games_logging_preflight.access_key_id",
      }),
      expect.objectContaining({
        secretId: secretAccessKey.id,
        configPath: "env.AWS_SECRET_ACCESS_KEY",
        projectionClass: "class_3_static_lease",
        projectionAllowlistKey: "aws.games_logging_preflight.secret_access_key",
      }),
      expect.objectContaining({
        secretId: sessionToken.id,
        configPath: "env.AWS_SESSION_TOKEN",
        projectionClass: "class_3_static_lease",
        projectionAllowlistKey: "aws.games_logging_preflight.session_token",
      }),
    ]));
    expect(bindings).toHaveLength(3);

    const capturedOutput = JSON.stringify({ adapterConfig: reloaded?.adapterConfig, bindings });
    for (const sentinel of sentinels) {
      expect(capturedOutput).not.toContain(sentinel);
    }
  });

  it("rejects class-3 env lease bindings outside the enumerated allowlist", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `github-${randomUUID()}`,
      provider: "local_encrypted",
      value: "github-test-token",
    });

    await expect(
      agentService(db).create(companyId, {
        name: "Unlisted Static Lease",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {
          env: {
            GITHUB_TOKEN: {
              type: "secret_ref",
              secretId: secret.id,
              version: "latest",
              projectionClass: "class_3_static_lease",
              projectionAllowlistKey: "github.token",
            },
          },
        },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "class_3_static_lease_not_allowed" },
    });

    const persistedAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId));
    expect(persistedAgents).toHaveLength(0);
  });

  it("rejects missing, swapped, and fourth AWS-looking class-3 env refs before binding", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `aws-rejection-${randomUUID()}`,
      provider: "local_encrypted",
      value: `aws-sentinel-${randomUUID()}`,
    });
    const cases = [
      {
        env: {
          AWS_ACCESS_KEY_ID: {
            type: "secret_ref" as const,
            secretId: secret.id,
            version: "latest" as const,
            projectionClass: "class_3_static_lease" as const,
          },
        },
        code: "class_3_static_lease_allowlist_required",
      },
      {
        env: {
          AWS_ACCESS_KEY_ID: {
            type: "secret_ref" as const,
            secretId: secret.id,
            version: "latest" as const,
            projectionClass: "class_3_static_lease" as const,
            projectionAllowlistKey: "aws.games_logging_preflight.secret_access_key",
          },
        },
        code: "class_3_static_lease_not_allowed",
      },
      {
        env: {
          AWS_REGION: {
            type: "secret_ref" as const,
            secretId: secret.id,
            version: "latest" as const,
            projectionClass: "class_3_static_lease" as const,
            projectionAllowlistKey: "aws.games_logging_preflight.access_key_id",
          },
        },
        code: "class_3_static_lease_not_allowed",
      },
    ];

    for (const candidate of cases) {
      await expect(
        agentService(db).create(companyId, {
          name: "Rejected AWS Static Lease",
          role: "operator",
          adapterType: "codex_local",
          adapterConfig: { env: candidate.env },
          runtimeConfig: {},
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
        }),
      ).rejects.toMatchObject({ status: 422, details: { code: candidate.code } });
    }

    const persistedAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId));
    const persistedBindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.companyId, companyId));
    expect(persistedAgents).toHaveLength(0);
    expect(persistedBindings).toHaveLength(0);
  });

  it("converts Hermes gateway apiKey strings into persisted secret refs", async () => {
    const companyId = await seedCompany();
    const literalApiKey = `hermes-key-${randomUUID()}`;

    const created = await agentService(db).create(companyId, {
      name: "Hermes Gateway",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_gateway",
      adapterConfig: {
        apiBaseUrl: "https://hermes.example",
        apiKey: literalApiKey,
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const persistedRows = await db
      .select()
      .from(agents)
      .where(eq(agents.id, created.id));
    const persistedConfig = persistedRows[0]?.adapterConfig as Record<string, unknown>;
    expect(JSON.stringify(persistedConfig)).not.toContain(literalApiKey);
    expect(persistedConfig.apiKey).toMatchObject({
      type: "secret_ref",
      version: "latest",
    });

    const secretId = (persistedConfig.apiKey as { secretId: string }).secretId;
    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId,
      configPath: "apiKey",
      versionSelector: "latest",
      required: true,
    });

    const resolved = await secretService(db).resolveAdapterConfigForRuntime(
      companyId,
      persistedConfig,
      {
        consumerType: "agent",
        consumerId: created.id,
      },
      { adapterType: "hermes_gateway" },
    );
    expect(resolved.config.apiKey).toBe(literalApiKey);
    expect(JSON.stringify(persistedConfig)).not.toContain(literalApiKey);
  });

  it("replaces agent secret bindings when adapterConfig env changes", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const oldSecret = await secrets.create(companyId, {
      name: `old-${randomUUID()}`,
      provider: "local_encrypted",
      value: "old-value",
    });
    const nextSecret = await secrets.create(companyId, {
      name: `next-${randomUUID()}`,
      provider: "local_encrypted",
      value: "next-value",
    });

    const created = await agentService(db).create(companyId, {
      name: "Binding Swapper",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          OLD_KEY: { type: "secret_ref", secretId: oldSecret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await agentService(db).update(created.id, {
      adapterConfig: {
        env: {
          NEW_KEY: { type: "secret_ref", secretId: nextSecret.id, version: "latest" },
        },
      },
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId: nextSecret.id,
      configPath: "env.NEW_KEY",
    });
  });

  it("backfills missing secret bindings when a legacy pending agent is approved", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `legacy-${randomUUID()}`,
      provider: "local_encrypted",
      value: "legacy-value",
    });
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Legacy Pending Agent",
      role: "engineer",
      status: "pending_approval",
      adapterType: "claude_local",
      adapterConfig: {
        env: {
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      permissions: {},
    });

    const beforeBindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, agentId));
    expect(beforeBindings).toHaveLength(0);

    const approved = await agentService(db).activatePendingApproval(agentId);

    expect(approved).toMatchObject({
      activated: true,
      agent: {
        id: agentId,
        status: "idle",
      },
    });

    const afterBindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, agentId),
      ));

    expect(afterBindings).toHaveLength(1);
    expect(afterBindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "env.ANTHROPIC_API_KEY",
    });
  });

  it("rolls back create when binding sync fails", async () => {
    const companyId = await seedCompany();
    const missingSecretId = randomUUID();

    await expect(
      agentService(db).create(companyId, {
        name: "Broken Create",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {
          env: {
            ANTHROPIC_API_KEY: { type: "secret_ref", secretId: missingSecretId, version: "latest" },
          },
        },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      }),
    ).rejects.toBeTruthy();

    const persistedAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId));
    expect(persistedAgents).toHaveLength(0);
  });

  it("rolls back adapterConfig updates when binding sync fails", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const validSecret = await secrets.create(companyId, {
      name: `valid-${randomUUID()}`,
      provider: "local_encrypted",
      value: "valid-value",
    });
    const created = await agentService(db).create(companyId, {
      name: "Transactional Update",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          API_KEY: { type: "secret_ref", secretId: validSecret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await expect(
      agentService(db).update(created.id, {
        adapterConfig: {
          env: {
            API_KEY: { type: "secret_ref", secretId: randomUUID(), version: "latest" },
          },
        },
      }),
    ).rejects.toBeTruthy();

    const reloaded = await agentService(db).getById(created.id);
    expect(reloaded?.adapterConfig).toMatchObject({
      env: {
        API_KEY: { type: "secret_ref", secretId: validSecret.id, version: "latest" },
      },
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.secretId).toBe(validSecret.id);
  });

  it("keeps pending approval status when activation binding sync fails", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Broken Pending Agent",
      role: "engineer",
      status: "pending_approval",
      adapterType: "claude_local",
      adapterConfig: {
        env: {
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: randomUUID(), version: "latest" },
        },
      },
      runtimeConfig: {},
      permissions: {},
    });

    await expect(agentService(db).activatePendingApproval(agentId)).rejects.toBeTruthy();

    const reloaded = await agentService(db).getById(agentId);
    expect(reloaded?.status).toBe("pending_approval");
  });
});
