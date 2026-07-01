import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { awsSecretsManagerProvider } from "../secrets/aws-secrets-manager-provider.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { SecretProviderClientError } from "../secrets/types.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping secrets service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("secretService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-secrets-service-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("secrets-service");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(secretAccessEvents);
    await db.delete(userSecretDeclarations);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(userSecretDefinitions);
    await db.delete(companySecretProviderConfigs);
    await db.delete(companyMemberships);
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

  async function seedCompanyMember(
    companyId: string,
    userId: string,
    membershipRole: "owner" | "member" | "viewer" = "member",
  ) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it("rejects cross-company secret references during env normalization", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = secretService(db);
    const foreignSecret = await svc.create(companyB, {
      name: `foreign-${randomUUID()}`,
      provider: "local_encrypted",
      value: "secret-value",
    });

    await expect(
      svc.normalizeEnvBindingsForPersistence(companyA, {
        API_KEY: { type: "secret_ref", secretId: foreignSecret.id, version: "latest" },
      }),
    ).rejects.toThrow(/same company/i);
  });

  it("prevents duplicate bindings for a target config path", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const firstSecret = await svc.create(companyId, {
      name: `first-${randomUUID()}`,
      provider: "local_encrypted",
      value: "one",
    });
    const secondSecret = await svc.create(companyId, {
      name: `second-${randomUUID()}`,
      provider: "local_encrypted",
      value: "two",
    });

    await svc.createBinding({
      companyId,
      secretId: firstSecret.id,
      targetType: "agent",
      targetId: "agent-1",
      configPath: "env.API_KEY",
    });

    await expect(
      svc.createBinding({
        companyId,
        secretId: secondSecret.id,
        targetType: "agent",
        targetId: "agent-1",
        configPath: "env.API_KEY",
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it("syncs top-level secret refs idempotently", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const firstSecret = await svc.create(companyId, {
      name: `top-level-first-${randomUUID()}`,
      provider: "local_encrypted",
      value: "one",
    });
    const secondSecret = await svc.create(companyId, {
      name: `top-level-second-${randomUUID()}`,
      provider: "local_encrypted",
      value: "two",
    });
    const target = { targetType: "environment" as const, targetId: "env-1" };

    await svc.syncSecretRefsForTarget(companyId, target, [
      { secretId: firstSecret.id, configPath: "apiKey" },
    ]);
    await svc.syncSecretRefsForTarget(companyId, target, [
      { secretId: firstSecret.id, configPath: "apiKey" },
    ]);
    await svc.syncSecretRefsForTarget(companyId, target, [
      { secretId: secondSecret.id, configPath: "apiKey" },
    ]);

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, target.targetId));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      companyId,
      targetType: "environment",
      targetId: target.targetId,
      configPath: "apiKey",
      secretId: secondSecret.id,
    });
  });

  it("reports reference counts and resolves binding target labels", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `referenced-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "CodexCoder",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
      })
      .returning();

    await svc.syncEnvBindingsForTarget(
      companyId,
      { targetType: "agent", targetId: agent!.id },
      {
        OPENAI_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
      },
    );

    const listed = await svc.list(companyId);
    expect(listed.find((row) => row.id === secret.id)?.referenceCount).toBe(1);

    const bindings = await svc.listBindingReferences(companyId, secret.id);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.target).toMatchObject({
      type: "agent",
      id: agent!.id,
      label: "CodexCoder",
      href: "/agents/codexcoder",
      status: "idle",
    });
  });

  it("enforces binding context and records value-free access events", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `runtime-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    const env = {
      API_KEY: { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const },
    };

    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: "agent-1" }, env);

    await expect(
      svc.resolveEnvBindings(companyId, env, {
        consumerType: "agent",
        consumerId: "agent-2",
        actorType: "agent",
        actorId: "agent-2",
      }),
    ).rejects.toThrow(/not bound/i);

    const resolved = await svc.resolveEnvBindings(companyId, env, {
      consumerType: "agent",
      consumerId: "agent-1",
      actorType: "agent",
      actorId: "agent-1",
    });

    expect(resolved.env.API_KEY).toBe("runtime-secret");
    const events = await svc.listAccessEvents(companyId, secret.id);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.outcome).sort()).toEqual(["failure", "success"]);
    expect(JSON.stringify(events)).not.toContain("runtime-secret");
  });

  it("collects declared secret refs that have no binding without resolving values", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secretName = `unbound-${randomUUID()}`;
    const secret = await svc.create(companyId, {
      name: secretName,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    const env = {
      API_KEY: { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const },
      PLAIN_VALUE: "not-a-secret",
    };

    const missing = await svc.collectMissingRuntimeBindings(companyId, env, {
      consumerType: "agent",
      consumerId: "agent-1",
    });

    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      consumerType: "agent",
      consumerId: "agent-1",
      configPath: "env.API_KEY",
      envKey: "API_KEY",
      secretId: secret.id,
      secretName,
    });
    // Value-free validation: no access events recorded.
    expect(await svc.listAccessEvents(companyId, secret.id)).toHaveLength(0);

    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: "agent-1" }, env);

    const afterBinding = await svc.collectMissingRuntimeBindings(companyId, env, {
      consumerType: "agent",
      consumerId: "agent-1",
    });
    expect(afterBinding).toEqual([]);
  });

  it("denies runtime secret resolution outside the low-trust binding allowlist", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `low-trust-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    const env = {
      API_KEY: { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const },
    };

    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: "agent-1" }, env);
    const [binding] = await svc.listBindings(companyId, secret.id);
    expect(binding?.id).toBeTruthy();

    await expect(
      svc.resolveEnvBindings(companyId, env, {
        consumerType: "agent",
        consumerId: "agent-1",
        actorType: "agent",
        actorId: "agent-1",
        allowedBindingIds: ["11111111-1111-4111-8111-111111111111"],
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "binding_not_allowed" },
    });

    const resolved = await svc.resolveEnvBindings(companyId, env, {
      consumerType: "agent",
      consumerId: "agent-1",
      actorType: "agent",
      actorId: "agent-1",
      allowedBindingIds: [binding!.id],
    });
    expect(resolved.env.API_KEY).toBe("runtime-secret");
    expect(resolved.manifest[0]?.bindingId).toBe(binding!.id);
  });

  it("denies user secret resolution outside the low-trust declaration allowlist", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1", "owner");
    const svc = secretService(db);
    const definition = await svc.createUserSecretDefinition(companyId, {
      key: "github_token",
      name: "GitHub token",
      provider: "local_encrypted",
    });
    const env = {
      GITHUB_TOKEN: { type: "user_secret_ref" as const, key: "github_token", version: "latest" as const },
    };

    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: "agent-1" }, env);
    await svc.createCurrentUserSecretValue(companyId, "user-1", {
      definitionKey: "github_token",
      value: "user-one-secret",
    });
    const [declaration] = await db
      .select()
      .from(userSecretDeclarations)
      .where(eq(userSecretDeclarations.userSecretDefinitionId, definition.id));
    expect(declaration?.id).toBeTruthy();

    await expect(
      svc.resolveEnvBindings(companyId, env, {
        consumerType: "agent",
        consumerId: "agent-1",
        actorType: "agent",
        actorId: "agent-1",
        responsibleUserId: "user-1",
        allowedBindingIds: ["11111111-1111-4111-8111-111111111111"],
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "binding_not_allowed" },
    });

    const resolved = await svc.resolveEnvBindings(companyId, env, {
      consumerType: "agent",
      consumerId: "agent-1",
      actorType: "agent",
      actorId: "agent-1",
      responsibleUserId: "user-1",
      allowedBindingIds: [declaration!.id],
    });
    expect(resolved.env.GITHUB_TOKEN).toBe("user-one-secret");
    expect(resolved.manifest[0]?.bindingId).toBe(declaration!.id);
  });

  it("resolves routine env secret refs through routine bindings and records value-free access metadata", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `routine-secret-${randomUUID()}`,
      provider: "local_encrypted",
      value: "routine-super-secret",
    });
    const env = {
      ROUTINE_API_KEY: { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const },
    };
    await svc.syncEnvBindingsForTarget(companyId, { targetType: "routine", targetId: "routine-1" }, env);

    const resolved = await svc.resolveEnvBindings(companyId, env, {
      consumerType: "routine",
      consumerId: "routine-1",
      actorType: "agent",
      actorId: "agent-1",
    });

    expect(resolved.env.ROUTINE_API_KEY).toBe("routine-super-secret");
    expect(resolved.manifest).toEqual([
      expect.objectContaining({
        configPath: "env.ROUTINE_API_KEY",
        envKey: "ROUTINE_API_KEY",
        secretId: secret.id,
        outcome: "success",
      }),
    ]);

    const events = await svc.listAccessEvents(companyId, secret.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      companyId,
      secretId: secret.id,
      consumerType: "routine",
      consumerId: "routine-1",
      configPath: "env.ROUTINE_API_KEY",
      actorType: "agent",
      actorId: "agent-1",
      outcome: "success",
    });
    expect(JSON.stringify(events)).not.toContain("routine-super-secret");
  });

  it("resolves user secret refs through responsible-user values and records owner metadata", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1", "owner");
    await seedCompanyMember(companyId, "user-2", "member");
    const svc = secretService(db);
    const definition = await svc.createUserSecretDefinition(companyId, {
      key: "github_token",
      name: "GitHub token",
      provider: "local_encrypted",
    });
    const env = {
      GITHUB_TOKEN: { type: "user_secret_ref" as const, key: "github_token", version: "latest" as const },
    };

    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: "agent-1" }, env);
    const userOneSecret = await svc.createCurrentUserSecretValue(companyId, "user-1", {
      definitionKey: "github_token",
      value: "user-one-secret",
    });

    await expect(
      svc.resolveEnvBindings(companyId, env, {
        consumerType: "agent",
        consumerId: "agent-1",
        actorType: "agent",
        actorId: "agent-1",
        responsibleUserId: "user-2",
      }),
    ).rejects.toThrow(/not configured/i);
    await expect(
      svc.collectMissingRuntimeBindings(companyId, env, {
        consumerType: "agent",
        consumerId: "agent-1",
        responsibleUserId: "user-2",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        bindingType: "user_secret_ref",
        configPath: "env.GITHUB_TOKEN",
        envKey: "GITHUB_TOKEN",
        userSecretDefinitionId: definition.id,
        userSecretDefinitionKey: "github_token",
        responsibleUserId: "user-2",
        errorCode: "user_secret_missing",
      }),
    ]);

    const optionalEnv = {
      OPTIONAL_GITHUB_TOKEN: {
        type: "user_secret_ref" as const,
        key: "github_token",
        version: "latest" as const,
        required: false,
      },
    };
    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: "agent-optional" }, optionalEnv);
    await expect(
      svc.collectMissingRuntimeBindings(companyId, optionalEnv, {
        consumerType: "agent",
        consumerId: "agent-optional",
        responsibleUserId: "user-2",
      }),
    ).resolves.toEqual([]);
    await expect(
      svc.resolveEnvBindings(companyId, optionalEnv, {
        consumerType: "agent",
        consumerId: "agent-optional",
        actorType: "agent",
        actorId: "agent-optional",
        responsibleUserId: "user-2",
      }),
    ).resolves.toMatchObject({
      env: {},
      manifest: [],
    });

    await db
      .update(userSecretDefinitions)
      .set({ status: "disabled" })
      .where(eq(userSecretDefinitions.id, definition.id));
    await expect(
      svc.resolveEnvBindings(companyId, optionalEnv, {
        consumerType: "agent",
        consumerId: "agent-optional",
        actorType: "agent",
        actorId: "agent-optional",
        responsibleUserId: "user-2",
      }),
    ).resolves.toMatchObject({
      env: {},
      manifest: [],
    });
    await db
      .update(userSecretDefinitions)
      .set({ status: "active" })
      .where(eq(userSecretDefinitions.id, definition.id));

    const resolved = await svc.resolveEnvBindings(companyId, env, {
      consumerType: "agent",
      consumerId: "agent-1",
      actorType: "agent",
      actorId: "agent-1",
      responsibleUserId: "user-1",
    });

    expect(resolved.env.GITHUB_TOKEN).toBe("user-one-secret");
    expect(resolved.manifest[0]).toMatchObject({
      configPath: "env.GITHUB_TOKEN",
      envKey: "GITHUB_TOKEN",
      secretId: userOneSecret.id,
      secretKey: userOneSecret.key,
      outcome: "success",
    });
    expect((await svc.list(companyId)).map((secret) => secret.id)).not.toContain(userOneSecret.id);
    await expect(
      svc.resolveSecretValue(companyId, userOneSecret.id, "latest", {
        consumerType: "agent",
        consumerId: "agent-1",
        configPath: "env.GITHUB_TOKEN",
      }),
    ).rejects.toThrow(/User-scoped secrets/i);

    const events = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, userOneSecret.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      companyId,
      secretId: userOneSecret.id,
      userSecretDefinitionId: definition.id,
      secretScope: "user",
      responsibleUserId: "user-1",
      credentialOwnerUserId: "user-1",
      credentialSubjectType: "user",
      credentialSubjectId: "user-1",
      outcome: "success",
    });
    expect(JSON.stringify(events)).not.toContain("user-one-secret");
  });

  it("reports missing adapter-config user secret refs before runtime resolution", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1", "owner");
    const svc = secretService(db);
    const definition = await svc.createUserSecretDefinition(companyId, {
      key: "hermes_api_key",
      name: "Hermes API key",
      provider: "local_encrypted",
    });
    const adapterConfig = {
      apiBaseUrl: "http://127.0.0.1:9119/api",
      apiKey: { type: "user_secret_ref" as const, key: "hermes_api_key", version: "latest" as const },
    };
    await svc.syncUserSecretDeclarationsForTarget(companyId, {
      targetType: "agent",
      targetId: "agent-1",
    }, [
      {
        definitionKey: "hermes_api_key",
        configPath: "apiKey",
        envKey: "apiKey",
      },
    ]);

    await expect(
      svc.collectMissingAdapterConfigRuntimeBindings(
        companyId,
        adapterConfig,
        "hermes_gateway",
        {
          consumerType: "agent",
          consumerId: "agent-1",
          responsibleUserId: "user-1",
        },
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        bindingType: "user_secret_ref",
        configPath: "apiKey",
        envKey: "apiKey",
        userSecretDefinitionId: definition.id,
        userSecretDefinitionKey: "hermes_api_key",
        responsibleUserId: "user-1",
        errorCode: "user_secret_missing",
      }),
    ]);

    await expect(
      svc.collectMissingAdapterConfigRuntimeBindings(
        companyId,
        {
          ...adapterConfig,
          apiKey: {
            type: "user_secret_ref" as const,
            key: "hermes_api_key",
            version: "latest" as const,
            required: false,
          },
        },
        "hermes_gateway",
        {
          consumerType: "agent",
          consumerId: "agent-1",
          responsibleUserId: "user-1",
        },
      ),
    ).resolves.toEqual([]);
  });

  it("records stable redacted failure codes for routine env secret resolution", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `routine-failure-codes-${randomUUID()}`,
      provider: "local_encrypted",
      value: "routine-super-secret",
    });
    const env = {
      ROUTINE_API_KEY: { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const },
    };
    const context = {
      consumerType: "routine" as const,
      consumerId: "routine-1",
      actorType: "agent" as const,
      actorId: "agent-1",
    };
    await svc.syncEnvBindingsForTarget(companyId, { targetType: "routine", targetId: "routine-1" }, env);

    await expect(
      svc.resolveEnvBindings(companyId, env, { ...context, consumerId: "routine-2" }),
    ).rejects.toThrow(/not bound/i);

    await db.update(companySecrets).set({ status: "disabled" }).where(eq(companySecrets.id, secret.id));
    await expect(svc.resolveEnvBindings(companyId, env, context)).rejects.toThrow(/not active/i);

    await db.update(companySecrets).set({ status: "active" }).where(eq(companySecrets.id, secret.id));
    await expect(
      svc.resolveSecretValue(companyId, secret.id, 999, {
        ...context,
        configPath: "env.ROUTINE_API_KEY",
      }),
    ).rejects.toThrow(/version not found/i);

    await db
      .update(companySecretVersions)
      .set({ status: "disabled" })
      .where(eq(companySecretVersions.secretId, secret.id));
    await expect(svc.resolveEnvBindings(companyId, env, context)).rejects.toThrow(/version is not active/i);

    await db
      .update(companySecretVersions)
      .set({ status: "current" })
      .where(eq(companySecretVersions.secretId, secret.id));
    vi.spyOn(localEncryptedProvider, "resolveVersion").mockRejectedValueOnce(
      new Error("provider leaked value routine-super-secret"),
    );
    await expect(svc.resolveEnvBindings(companyId, env, context)).rejects.toThrow(/provider leaked value/i);

    await db.update(companySecrets).set({ status: "deleted" }).where(eq(companySecrets.id, secret.id));
    await expect(svc.resolveEnvBindings(companyId, env, context)).rejects.toThrow(/not found/i);

    const events = await svc.listAccessEvents(companyId, secret.id);
    expect(events.map((event) => event.errorCode).sort()).toEqual([
      "binding_missing",
      "provider_error",
      "secret_deleted",
      "secret_inactive",
      "version_inactive",
      "version_missing",
    ]);
    expect(JSON.stringify(events)).not.toContain("routine-super-secret");
    expect(JSON.stringify(events)).not.toContain("provider leaked value");
  });

  it("scopes env binding sync deletes to the env path prefix", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const runtimeSecret = await svc.create(companyId, {
      name: `runtime-ref-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    const envSecret = await svc.create(companyId, {
      name: `env-ref-${randomUUID()}`,
      provider: "local_encrypted",
      value: "env-secret",
    });

    await svc.createBinding({
      companyId,
      secretId: runtimeSecret.id,
      targetType: "agent",
      targetId: "agent-1",
      configPath: "runtime.token",
    });
    await svc.syncEnvBindingsForTarget(
      companyId,
      { targetType: "agent", targetId: "agent-1" },
      {
        API_KEY: { type: "secret_ref", secretId: envSecret.id, version: "latest" },
      },
    );
    await svc.syncEnvBindingsForTarget(
      companyId,
      { targetType: "agent", targetId: "agent-1" },
      {},
    );

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, "agent-1"));
    expect(bindings.map((binding) => binding.configPath)).toEqual(["runtime.token"]);
  });

  it("returns resolved secrets even when success metadata writes fail", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `metadata-write-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    const env = {
      API_KEY: { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const },
    };
    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: "agent-1" }, env);

    vi.spyOn(db, "update").mockImplementationOnce(
      () => ({
        set: () => ({
          where: () => Promise.reject(new Error("metadata write failed")),
        }),
      }) as ReturnType<typeof db.update>,
    );

    const resolved = await svc.resolveEnvBindings(companyId, env, {
      consumerType: "agent",
      consumerId: "agent-1",
      actorType: "agent",
      actorId: "agent-1",
    });

    expect(resolved.env.API_KEY).toBe("runtime-secret");
  });

  it("stores external references without requiring or persisting secret values", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });

    const secret = await svc.create(companyId, {
      name: `external-${randomUUID()}`,
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/test",
      providerVersionRef: "version-1",
    });

    expect(secret.managedMode).toBe("external_reference");
    expect(secret.externalRef).toBe("arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/test");

    const versions = await db
      .select()
      .from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, secret.id));
    expect(versions).toHaveLength(1);
    expect(versions[0]?.providerVersionRef).toBe("version-1");
    expect(JSON.stringify(versions[0])).not.toContain("runtime-secret");
    expect(JSON.stringify(versions[0])).not.toContain("sk-");

    await expect(
      svc.resolveSecretValue(companyId, secret.id, "latest", {
        consumerType: "system",
        consumerId: "system",
        configPath: "env.EXTERNAL_SECRET",
      }),
    ).rejects.toThrow(/not bound/i);
  });

  it("preserves the original resolution error when failure access logging fails", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `resolution-failure-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    await svc.createBinding({
      companyId,
      secretId: secret.id,
      targetType: "system",
      targetId: "system",
      configPath: "env.API_KEY",
    });
    vi.spyOn(localEncryptedProvider, "resolveVersion").mockRejectedValueOnce(
      new Error("provider resolution failed"),
    );

    await expect(
      svc.resolveSecretValue(companyId, secret.id, "latest", {
        consumerType: "system",
        consumerId: "system",
        configPath: "env.API_KEY",
        heartbeatRunId: randomUUID(),
      }),
    ).rejects.toThrow("provider resolution failed");
  });

  it("keeps one default provider vault per company provider", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);

    const first = await svc.createProviderConfig(companyId, {
      provider: "local_encrypted",
      displayName: "Local primary",
      isDefault: true,
      config: {},
    });
    const second = await svc.createProviderConfig(companyId, {
      provider: "local_encrypted",
      displayName: "Local secondary",
      isDefault: true,
      config: {},
    });

    const rows = await svc.listProviderConfigs(companyId);
    expect(rows.find((row) => row.id === first.id)?.isDefault).toBe(false);
    expect(rows.find((row) => row.id === second.id)?.isDefault).toBe(true);
  });

  it("does not set a disabled provider vault as default", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const vault = await svc.createProviderConfig(companyId, {
      provider: "local_encrypted",
      displayName: "Local disabled",
      config: {},
    });

    await svc.disableProviderConfig(vault.id);
    await expect(svc.setDefaultProviderConfig(vault.id)).rejects.toThrow(
      /ready or warning/i,
    );
  });

  it("removes provider vault config locally without deleting remote AWS secrets", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const vault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const secret = await svc.create(companyId, {
      name: `external-${randomUUID()}`,
      provider: "aws_secrets_manager",
      providerConfigId: vault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/external",
    });
    const deleteSpy = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockResolvedValue();

    const removed = await svc.removeProviderConfig(vault.id);

    expect(removed?.id).toBe(vault.id);
    await expect(svc.getProviderConfigById(vault.id)).resolves.toBeNull();
    const [persistedSecret] = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, secret.id));
    expect(persistedSecret?.providerConfigId).toBeNull();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("hides soft-deleted secrets and allows name/key reuse", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secretName = `reusable-${randomUUID()}`;
    const secret = await svc.create(companyId, {
      name: secretName,
      key: "reusable-key",
      provider: "local_encrypted",
      value: "first-value",
    });

    await svc.remove(secret.id);
    const listed = await svc.list(companyId);
    const recreated = await svc.create(companyId, {
      name: secretName,
      key: "reusable-key",
      provider: "local_encrypted",
      value: "second-value",
    });

    expect(listed.map((row) => row.id)).not.toContain(secret.id);
    expect(recreated.id).not.toBe(secret.id);
    expect(recreated.name).toBe(secretName);
    expect(recreated.key).toBe("reusable-key");
  });

  it("rejects bindings and env refs to soft-deleted external reference secrets", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const deleted = await svc.create(companyId, {
      name: "Deleted external",
      key: "deleted-external",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/deleted",
    });
    await svc.update(deleted.id, { status: "deleted" });

    await expect(
      svc.createBinding({
        companyId,
        secretId: deleted.id,
        targetType: "agent",
        targetId: "agent-1",
        configPath: "env.API_KEY",
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      svc.normalizeEnvBindingsForPersistence(companyId, {
        API_KEY: { type: "secret_ref", secretId: deleted.id, version: "latest" },
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects updates to already soft-deleted external reference secrets", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const deleted = await svc.create(companyId, {
      name: "Deleted patch target",
      key: "deleted-patch-target",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/deleted-patch-target",
    });
    await svc.update(deleted.id, { status: "deleted" });

    await expect(svc.update(deleted.id, { status: "active" })).rejects.toThrow(
      /not found/i,
    );
  });

  it("allows re-importing a remote secret after the prior external reference is soft-deleted", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const externalRef =
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/reimportable";
    const deleted = await svc.create(companyId, {
      name: "Deleted external",
      key: "deleted-external",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef,
    });

    await svc.update(deleted.id, { status: "deleted" });
    vi.spyOn(awsSecretsManagerProvider, "listRemoteSecrets").mockResolvedValue({
      secrets: [
        {
          externalRef,
          name: "prod/reimportable",
          providerVersionRef: null,
          metadata: { arn: externalRef },
        },
      ],
    });

    const preview = await svc.previewRemoteImport(companyId, {
      providerConfigId: awsVault.id,
    });
    const result = await svc.importRemoteSecrets(companyId, {
      providerConfigId: awsVault.id,
      secrets: [
        {
          externalRef,
          name: "Reimported external",
          key: "reimported-external",
        },
      ],
    });

    expect(preview.candidates[0]).toMatchObject({
      status: "ready",
      importable: true,
      conflicts: [],
    });
    expect(result).toMatchObject({ importedCount: 1, skippedCount: 0, errorCount: 0 });
  });

  it("ignores soft-deleted name and key conflicts during remote import", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const deleted = await svc.create(companyId, {
      name: "Deleted external",
      key: "deleted-external",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/deleted-old",
    });
    await svc.update(deleted.id, { status: "deleted" });
    vi.spyOn(awsSecretsManagerProvider, "listRemoteSecrets").mockResolvedValue({
      secrets: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/deleted-new",
          name: "Deleted external",
          providerVersionRef: null,
          metadata: {},
        },
      ],
    });

    const preview = await svc.previewRemoteImport(companyId, {
      providerConfigId: awsVault.id,
    });
    const result = await svc.importRemoteSecrets(companyId, {
      providerConfigId: awsVault.id,
      secrets: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/deleted-new",
          name: "Deleted external",
          key: "deleted-external",
        },
      ],
    });

    expect(preview.candidates[0]).toMatchObject({
      status: "ready",
      importable: true,
      conflicts: [],
    });
    expect(result).toMatchObject({ importedCount: 1, skippedCount: 0, errorCount: 0 });
  });

  it("rejects provider vaults from another company when creating a secret", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = secretService(db);
    const foreignVault = await svc.createProviderConfig(companyB, {
      provider: "local_encrypted",
      displayName: "Foreign vault",
      config: {},
    });

    await expect(
      svc.create(companyA, {
        name: `managed-${randomUUID()}`,
        provider: "local_encrypted",
        providerConfigId: foreignVault.id,
        value: "runtime-secret",
      }),
    ).rejects.toThrow(/same company/i);
  });

  it("blocks coming-soon provider vaults from secret selection", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const draftVault = await svc.createProviderConfig(companyId, {
      provider: "gcp_secret_manager",
      displayName: "GCP draft",
      config: { projectId: "paperclip-prod1" },
    });

    expect(draftVault.status).toBe("coming_soon");
    await expect(
      svc.create(companyId, {
        name: `draft-${randomUUID()}`,
        provider: "gcp_secret_manager",
        providerConfigId: draftVault.id,
        value: "runtime-secret",
      }),
    ).rejects.toThrow(/coming soon/i);
  });

  it("passes selected provider vault config through create, rotate, and resolve", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: {
        region: "us-east-1",
        namespace: "prod-use1",
        secretNamePrefix: "paperclip",
      },
    });

    const createSpy = vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/openai-api-key",
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/openai-api-key",
      providerVersionRef: "aws-version-1",
    });
    const createVersionSpy = vi.spyOn(awsSecretsManagerProvider, "createVersion").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/openai-api-key",
        versionId: "aws-version-2",
        source: "managed",
      },
      valueSha256: "value-sha-2",
      fingerprintSha256: "fingerprint-sha-2",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/openai-api-key",
      providerVersionRef: "aws-version-2",
    });
    const resolveSpy = vi.spyOn(awsSecretsManagerProvider, "resolveVersion").mockResolvedValue("resolved-secret");

    const secret = await svc.create(companyId, {
      name: `aws-managed-${randomUUID()}`,
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      value: "runtime-secret",
    });
    const rotated = await svc.rotate(secret.id, { value: "rotated-runtime-secret" });
    const resolved = await svc.resolveSecretValue(companyId, rotated.id, "latest");

    expect(resolved).toBe("resolved-secret");
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerConfig: expect.objectContaining({
        id: awsVault.id,
        provider: "aws_secrets_manager",
        config: expect.objectContaining({ region: "us-east-1", namespace: "prod-use1" }),
      }),
    }));
    expect(createVersionSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerConfig: expect.objectContaining({ id: awsVault.id }),
    }));
    expect(resolveSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerConfig: expect.objectContaining({ id: awsVault.id }),
      providerVersionRef: "aws-version-2",
    }));
    expect(JSON.stringify(resolveSpy.mock.calls[0]?.[0])).not.toContain("resolved-secret");
  });

  it("cleans up managed provider secrets when create persistence fails", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const prepared = {
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/create-rollback",
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/create-rollback",
      providerVersionRef: "aws-version-1",
    };
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue(prepared);
    const deleteSpy = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockResolvedValue();
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("db insert failed"));

    await expect(
      svc.create(companyId, {
        name: "Create Rollback",
        key: "create-rollback",
        provider: "aws_secrets_manager",
        providerConfigId: awsVault.id,
        value: "runtime-secret",
      }),
    ).rejects.toThrow("db insert failed");

    expect(deleteSpy).toHaveBeenCalledWith(expect.objectContaining({
      material: prepared.material,
      externalRef: prepared.externalRef,
      mode: "delete",
      providerConfig: expect.objectContaining({ id: awsVault.id }),
      context: {
        companyId,
        secretKey: "create-rollback",
        secretName: "Create Rollback",
        version: 1,
      },
    }));

    const persisted = await svc.getByName(companyId, "Create Rollback");
    expect(persisted).toBeNull();
    const versions = await db.select().from(companySecretVersions);
    expect(versions).toHaveLength(0);
  });

  it("keeps a local cleanup handle when create rollback cleanup fails", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const prepared = {
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/create-cleanup-handle",
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/create-cleanup-handle",
      providerVersionRef: "aws-version-1",
    };
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue(prepared);
    vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockRejectedValue(
      new Error("cleanup failed"),
    );
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("db activate failed"));

    await expect(
      svc.create(companyId, {
        name: "Create Cleanup Handle",
        key: "create-cleanup-handle",
        provider: "aws_secrets_manager",
        providerConfigId: awsVault.id,
        value: "runtime-secret",
      }),
    ).rejects.toThrow("db activate failed");

    const persisted = await svc.getByName(companyId, "Create Cleanup Handle");
    expect(persisted).toMatchObject({
      key: "create-cleanup-handle",
      status: "archived",
      externalRef: prepared.externalRef,
      latestVersion: 1,
    });

    const version = await db
      .select()
      .from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, persisted!.id))
      .then((rows) => rows[0] ?? null);
    expect(version).toMatchObject({
      version: 1,
      status: "disabled",
      material: prepared.material,
    });
  });

  it("archives managed provider versions when rotate persistence fails", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/rotate-rollback",
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/rotate-rollback",
      providerVersionRef: "aws-version-1",
    });
    const secret = await svc.create(companyId, {
      name: "Rotate Rollback",
      key: "rotate-rollback",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      value: "runtime-secret",
    });
    const prepared = {
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/rotate-rollback",
        versionId: "aws-version-2",
        source: "managed",
      },
      valueSha256: "value-sha-2",
      fingerprintSha256: "fingerprint-sha-2",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/rotate-rollback",
      providerVersionRef: "aws-version-2",
    };
    vi.spyOn(awsSecretsManagerProvider, "createVersion").mockResolvedValue(prepared);
    const deleteSpy = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockResolvedValue();
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("db rotate failed"));

    await expect(svc.rotate(secret.id, { value: "rotated-runtime-secret" })).rejects.toThrow(
      "db rotate failed",
    );

    expect(deleteSpy).toHaveBeenCalledWith(expect.objectContaining({
      material: prepared.material,
      externalRef: prepared.externalRef,
      mode: "archive",
      providerConfig: expect.objectContaining({ id: awsVault.id }),
      context: {
        companyId,
        secretKey: "rotate-rollback",
        secretName: "Rotate Rollback",
        version: 2,
      },
    }));
  });

  it("keeps a disabled version cleanup handle when rotate rollback cleanup fails", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/rotate-cleanup-handle",
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/rotate-cleanup-handle",
      providerVersionRef: "aws-version-1",
    });
    const secret = await svc.create(companyId, {
      name: "Rotate Cleanup Handle",
      key: "rotate-cleanup-handle",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      value: "runtime-secret",
    });
    const prepared = {
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/rotate-cleanup-handle",
        versionId: "aws-version-2",
        source: "managed",
      },
      valueSha256: "value-sha-2",
      fingerprintSha256: "fingerprint-sha-2",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/rotate-cleanup-handle",
      providerVersionRef: "aws-version-2",
    };
    vi.spyOn(awsSecretsManagerProvider, "createVersion").mockResolvedValue(prepared);
    vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockRejectedValue(
      new Error("cleanup failed"),
    );
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("db rotate failed"));

    await expect(svc.rotate(secret.id, { value: "rotated-runtime-secret" })).rejects.toThrow(
      "db rotate failed",
    );

    const persisted = await svc.getById(secret.id);
    expect(persisted?.latestVersion).toBe(1);

    const versions = await db
      .select()
      .from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, secret.id));
    expect(versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 1, status: "current" }),
      expect.objectContaining({
        version: 2,
        status: "disabled",
        material: prepared.material,
      }),
    ]));
  });

  it("rejects generic provider vault reassignment for managed secrets", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const firstVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS primary",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const secondVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS secondary",
      config: { region: "us-west-2", namespace: "prod-usw2" },
    });
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/vault-reassign",
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/vault-reassign",
      providerVersionRef: "aws-version-1",
    });
    const secret = await svc.create(companyId, {
      name: "Vault Reassign",
      key: "vault-reassign",
      provider: "aws_secrets_manager",
      providerConfigId: firstVault.id,
      value: "runtime-secret",
    });

    await expect(svc.update(secret.id, { providerConfigId: secondVault.id })).rejects.toThrow(
      /managed secrets cannot change provider vault/i,
    );
    const persisted = await svc.getById(secret.id);
    expect(persisted?.providerConfigId).toBe(firstVault.id);
  });

  it("rejects rotation for non-active secrets", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `disabled-rotation-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });

    await svc.update(secret.id, { status: "disabled" });
    await expect(svc.rotate(secret.id, { value: "rotated-runtime-secret" })).rejects.toThrow(
      /non-active/i,
    );

    const stored = await db
      .select({ latestVersion: companySecrets.latestVersion })
      .from(companySecrets)
      .where(eq(companySecrets.id, secret.id))
      .then((rows) => rows[0]);
    expect(stored?.latestVersion).toBe(1);
  });

  it("previews AWS remote import candidates with duplicate and collision enrichment", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const duplicate = await svc.create(companyId, {
      name: "Existing duplicate",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/duplicate",
    });
    const nameConflict = await svc.create(companyId, {
      name: "Prod Conflict",
      provider: "local_encrypted",
      value: "runtime-secret",
    });

    const listSpy = vi.spyOn(awsSecretsManagerProvider, "listRemoteSecrets").mockResolvedValue({
      nextToken: "next-page",
      secrets: [
        {
          externalRef: duplicate.externalRef!,
          name: "prod/duplicate",
          providerVersionRef: null,
          metadata: { arn: duplicate.externalRef },
        },
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/conflict",
          name: nameConflict.name,
          providerVersionRef: null,
          metadata: { arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/conflict" },
        },
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/ready",
          name: "prod/ready",
          providerVersionRef: null,
          metadata: { arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/ready" },
        },
      ],
    });

    const preview = await svc.previewRemoteImport(companyId, {
      providerConfigId: awsVault.id,
      query: "prod",
      pageSize: 25,
    });

    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerConfig: expect.objectContaining({ id: awsVault.id }),
      query: "prod",
      pageSize: 25,
    }));
    expect(preview.nextToken).toBe("next-page");
    expect(preview.candidates.map((candidate) => candidate.status)).toEqual([
      "duplicate",
      "conflict",
      "ready",
    ]);
    expect(preview.candidates[0]?.conflicts[0]).toMatchObject({
      type: "exact_reference",
      existingSecretId: duplicate.id,
    });
    expect(preview.candidates[1]?.conflicts[0]).toMatchObject({
      type: "name",
      existingSecretId: nameConflict.id,
    });
    expect(preview.candidates[2]).toMatchObject({
      importable: true,
      name: "prod/ready",
      key: "prod-ready",
    });
    expect(preview.candidates[2]?.providerMetadata).toBeNull();
  });

  it("sanitizes AWS remote import preview provider errors before crossing the service boundary", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const rawProviderMessage =
      "AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/prod/Paperclip is not authorized to perform secretsmanager:ListSecrets";

    vi.spyOn(awsSecretsManagerProvider, "listRemoteSecrets").mockRejectedValueOnce(
      new SecretProviderClientError({
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "listSecrets",
        message: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        rawMessage: rawProviderMessage,
      }),
    );

    let thrown: unknown;
    try {
      await svc.previewRemoteImport(companyId, { providerConfigId: awsVault.id });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      status: 403,
      message: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
      details: { code: "access_denied" },
    });
    expect(JSON.stringify(thrown)).not.toContain("arn:aws");
    expect(JSON.stringify(thrown)).not.toContain("123456789012");
    expect(thrown instanceof Error ? thrown.message : String(thrown)).not.toContain("arn:aws");
  });

  it("previews AWS provider vault discovery from draft config without persisting a provider vault", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const discoverSpy = vi.spyOn(awsSecretsManagerProvider, "discoverProviderConfigs").mockResolvedValue({
      provider: "aws_secrets_manager",
      nextToken: null,
      sampledSecretCount: 1,
      skippedForeignPaperclipSampleCount: 0,
      candidates: [
        {
          provider: "aws_secrets_manager",
          displayName: "AWS production",
          config: {
            region: "us-east-1",
            namespace: "prod-use1",
            secretNamePrefix: "paperclip",
            kmsKeyId: null,
            ownerTag: "platform",
            environmentTag: "production",
          },
          sampleCount: 1,
          samples: [
            { name: "paperclip/prod-use1/company-1/openai", hasKmsKey: false, tagKeys: ["paperclip:environment"] },
          ],
          signals: {
            namespace: "prod-use1",
            secretNamePrefix: "paperclip",
            environmentTag: "production",
            ownerTag: "platform",
            kmsKeyId: null,
            hasKmsKey: false,
            sampleCount: 1,
            paperclipManagedSampleCount: 0,
            skippedForeignPaperclipSampleCount: 0,
          },
          warnings: [],
        },
      ],
      warnings: [],
    });

    const preview = await svc.previewProviderConfigDiscovery(companyId, {
      provider: "aws_secrets_manager",
      config: { region: "us-east-1" },
      query: "openai",
      pageSize: 25,
    });

    expect(discoverSpy).toHaveBeenCalledWith({
      companyId,
      providerConfig: {
        id: `discovery-preview-${companyId}`,
        provider: "aws_secrets_manager",
        status: "ready",
        config: { region: "us-east-1" },
      },
      query: "openai",
      nextToken: undefined,
      pageSize: 25,
    });
    expect(preview.candidates[0]?.config).toMatchObject({
      region: "us-east-1",
      namespace: "prod-use1",
    });
    expect(JSON.stringify(preview)).not.toContain("runtime-secret");
    const persistedVaults = await db.select().from(companySecretProviderConfigs);
    expect(persistedVaults).toHaveLength(0);
  });

  it("sanitizes AWS provider vault discovery errors before crossing the service boundary", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const rawProviderMessage =
      "AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/prod/Paperclip is not authorized to perform secretsmanager:ListSecrets";

    vi.spyOn(awsSecretsManagerProvider, "discoverProviderConfigs").mockRejectedValueOnce(
      new SecretProviderClientError({
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "discoverProviderConfigs",
        message: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        rawMessage: rawProviderMessage,
      }),
    );

    let thrown: unknown;
    try {
      await svc.previewProviderConfigDiscovery(companyId, {
        provider: "aws_secrets_manager",
        config: { region: "us-east-1" },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      status: 403,
      message: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
      details: {
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "secret_provider_config.discovery.preview",
        providerConfigId: "discovery-preview",
        providerVaultContext: "draft_config",
        region: "us-east-1",
        credentialPath: "Paperclip server runtime/provider credential path",
        requiredCapability: "secretsmanager:ListSecrets",
        actionableMessage:
          "AWS discovery preview needs secretsmanager:ListSecrets in the selected region for the Paperclip server runtime/provider credential path.",
        safeAlternative:
          "If the operator already knows the exact AWS Secrets Manager ARN, paste/link that ARN instead of using discovery. Exact-resource DescribeSecret and runtime read permissions are still required.",
      },
    });
    expect(JSON.stringify(thrown)).not.toContain("arn:aws");
    expect(JSON.stringify(thrown)).not.toContain("123456789012");
    expect(thrown instanceof Error ? thrown.message : String(thrown)).not.toContain("arn:aws");
  });

  it("imports AWS remote references row-by-row without fetching plaintext", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const duplicate = await svc.create(companyId, {
      name: "Existing duplicate",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/duplicate",
    });

    const resolveSpy = vi.spyOn(awsSecretsManagerProvider, "resolveVersion");
    const result = await svc.importRemoteSecrets(
      companyId,
      {
        providerConfigId: awsVault.id,
        secrets: [
          {
            externalRef: duplicate.externalRef!,
            name: "Existing duplicate",
            key: "existing-duplicate",
          },
          {
            externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
            name: "OpenAI API key",
            key: "openai-api-key",
            description: "  Operator-entered production OpenAI key  ",
            providerMetadata: { arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai" },
          },
        ],
      },
      { userId: "user-1" },
    );

    expect(result.importedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.results.map((row) => row.status)).toEqual(["skipped", "imported"]);
    expect(result.results[0]).toMatchObject({
      reason: "exact_reference_duplicate",
      conflicts: [expect.objectContaining({ type: "exact_reference", existingSecretId: duplicate.id })],
    });
    expect(resolveSpy).not.toHaveBeenCalled();

    const imported = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.key, "openai-api-key"))
      .then((rows) => rows[0]);
    expect(imported).toMatchObject({
      companyId,
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
      createdByUserId: "user-1",
      providerMetadata: null,
      description: "Operator-entered production OpenAI key",
    });

    const versions = await db
      .select()
      .from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, imported!.id));
    expect(versions).toHaveLength(1);
    expect(JSON.stringify(versions[0])).not.toContain("runtime-secret");
    expect(JSON.stringify(versions[0])).not.toContain("sk-");
  });

  it("sanitizes AWS remote import row provider errors", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const rawProviderMessage =
      "AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/prod/Paperclip is not authorized to perform secretsmanager:DescribeSecret on arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai";
    vi.spyOn(awsSecretsManagerProvider, "linkExternalSecret").mockRejectedValueOnce(
      new SecretProviderClientError({
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "linkExternalSecret",
        message: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        rawMessage: rawProviderMessage,
      }),
    );

    const result = await svc.importRemoteSecrets(companyId, {
      providerConfigId: awsVault.id,
      secrets: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
          name: "OpenAI API key",
          key: "openai-api-key",
        },
      ],
    });

    expect(result).toMatchObject({
      importedCount: 0,
      skippedCount: 0,
      errorCount: 1,
      results: [
        expect.objectContaining({
          status: "error",
          reason: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        }),
      ],
    });
    expect(JSON.stringify(result)).not.toContain(rawProviderMessage);
    expect(JSON.stringify(result.results[0]?.reason)).not.toContain("arn:aws");
    expect(JSON.stringify(result.results[0]?.reason)).not.toContain("123456789012");
  });

  it("rejects Paperclip-managed AWS namespace refs during preview and import commit", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });

    vi.spyOn(awsSecretsManagerProvider, "listRemoteSecrets").mockResolvedValue({
      secrets: [
        {
          externalRef:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-b/openai",
          name: "paperclip/prod-use1/company-b/openai",
          providerVersionRef: null,
          metadata: {
            arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-b/openai",
            description: "must not leak",
            tags: [{ Key: "paperclip:company-id", Value: "company-b" }],
          },
        },
      ],
    });

    const preview = await svc.previewRemoteImport(companyId, {
      providerConfigId: awsVault.id,
    });

    expect(preview.candidates[0]).toMatchObject({
      status: "conflict",
      importable: false,
      conflicts: [expect.objectContaining({ type: "provider_guardrail" })],
      providerMetadata: null,
    });
    expect(JSON.stringify(preview)).not.toContain("must not leak");
    expect(JSON.stringify(preview)).not.toContain("paperclip:company-id");

    const result = await svc.importRemoteSecrets(companyId, {
      providerConfigId: awsVault.id,
      secrets: [
        {
          externalRef:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-b/openai",
          name: "Foreign managed secret",
          key: "foreign-managed-secret",
          providerMetadata: {
            description: "client-submitted metadata must not persist",
            tags: [{ Key: "paperclip:company-id", Value: "company-b" }],
          },
        },
      ],
    });

    expect(result).toMatchObject({
      importedCount: 0,
      skippedCount: 0,
      errorCount: 1,
      results: [expect.objectContaining({ status: "error" })],
    });
    expect(result.results[0]?.reason).toMatch(/Paperclip-managed namespace/i);
    const imported = await db.select().from(companySecrets).where(eq(companySecrets.key, "foreign-managed-secret"));
    expect(imported).toHaveLength(0);
  });

  it("skips duplicate AWS remote imports for the same provider vault and canonical ref", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });

    const first = await svc.importRemoteSecrets(companyId, {
      providerConfigId: awsVault.id,
      secrets: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
          name: "OpenAI API key",
          key: "openai-api-key",
        },
      ],
    });
    const second = await svc.importRemoteSecrets(companyId, {
      providerConfigId: awsVault.id,
      secrets: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
          name: "OpenAI API key duplicate",
          key: "openai-api-key-duplicate",
        },
      ],
    });

    expect(first.importedCount).toBe(1);
    expect(second).toMatchObject({
      importedCount: 0,
      skippedCount: 1,
      errorCount: 0,
      results: [expect.objectContaining({ reason: "exact_reference_duplicate" })],
    });
    const imported = await db.select().from(companySecrets).where(eq(companySecrets.providerConfigId, awsVault.id));
    expect(imported).toHaveLength(1);
  });

  it("rejects remote import for disabled or cross-company provider vaults", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = secretService(db);
    const disabledVault = await svc.createProviderConfig(companyA, {
      provider: "aws_secrets_manager",
      displayName: "AWS disabled",
      status: "disabled",
      config: { region: "us-east-1" },
    });
    const foreignVault = await svc.createProviderConfig(companyB, {
      provider: "aws_secrets_manager",
      displayName: "AWS foreign",
      config: { region: "us-east-1" },
    });

    await expect(
      svc.previewRemoteImport(companyA, { providerConfigId: disabledVault.id }),
    ).rejects.toThrow(/disabled/i);
    await expect(
      svc.previewRemoteImport(companyA, { providerConfigId: foreignVault.id }),
    ).rejects.toThrow(/same company/i);
  });

  it("rejects externalRef overrides on managed secrets", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `managed-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });

    await expect(
      svc.update(secret.id, {
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod/company-b/openai-api-key",
      }),
    ).rejects.toThrow(/Managed secrets cannot override externalRef/i);

    await expect(
      svc.rotate(secret.id, {
        value: "rotated-runtime-secret",
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod/company-b/openai-api-key",
      }),
    ).rejects.toThrow(/Managed secrets cannot override externalRef/i);
  });

  it("rejects generic update retargeting for external reference secrets", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const secret = await svc.create(companyId, {
      name: `external-${randomUUID()}`,
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/original",
    });

    await expect(
      svc.update(secret.id, {
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/repointed",
      }),
    ).rejects.toThrow(/cannot be retargeted/i);

    const persisted = await svc.getById(secret.id);
    expect(persisted?.externalRef).toBe(
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/original",
    );
  });

  it("rejects generic soft deletion for managed secrets", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `managed-delete-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });

    await expect(svc.update(secret.id, { status: "deleted" })).rejects.toThrow(
      /DELETE \/secrets\/:id/i,
    );

    const persisted = await svc.getById(secret.id);
    expect(persisted?.status).toBe("active");
  });

  it("passes managed AWS secret context into provider delete during removal", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const externalRef =
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key";

    const secret = await db
      .insert(companySecrets)
      .values({
        companyId,
        key: "openai-api-key",
        name: "OpenAI API Key",
        provider: "aws_secrets_manager",
        managedMode: "paperclip_managed",
        externalRef,
        latestVersion: 1,
        status: "active",
      })
      .returning()
      .then((rows) => rows[0]);

    await db.insert(companySecretVersions).values({
      secretId: secret.id,
      version: 1,
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: externalRef,
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      providerVersionRef: "aws-version-1",
      status: "current",
    });

    const deleteSpy = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockResolvedValue();

    const removed = await svc.remove(secret.id);
    const persisted = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, secret.id))
      .then((rows) => rows[0] ?? null);

    expect(removed?.id).toBe(secret.id);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: externalRef,
        versionId: "aws-version-1",
        source: "managed",
      },
      externalRef,
      context: {
        companyId,
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 1,
      },
      mode: "delete",
      providerConfig: null,
    });
    expect(persisted).toBeNull();
  });

  it("renames name and key during removal before provider deletion", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const externalRef =
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/remove-failure";
    const secret = await db
      .insert(companySecrets)
      .values({
        companyId,
        key: "remove-failure",
        name: "Remove Failure",
        provider: "aws_secrets_manager",
        managedMode: "paperclip_managed",
        externalRef,
        latestVersion: 1,
        status: "active",
      })
      .returning()
      .then((rows) => rows[0]);

    await db.insert(companySecretVersions).values({
      secretId: secret.id,
      version: 1,
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: externalRef,
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      providerVersionRef: "aws-version-1",
      status: "current",
    });
    vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockRejectedValueOnce(
      new Error("provider delete failed"),
    );

    await expect(svc.remove(secret.id)).rejects.toThrow("provider delete failed");
    const persisted = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, secret.id))
      .then((rows) => rows[0] ?? null);
    const recreated = await svc.create(companyId, {
      name: "Remove Failure",
      key: "remove-failure",
      provider: "local_encrypted",
      value: "replacement",
    });

    expect(persisted).toMatchObject({
      status: "deleted",
      key: `remove-failure__deleted__${secret.id}`,
      name: `Remove Failure__deleted__${secret.id}`,
    });
    expect(recreated.id).not.toBe(secret.id);
  });

  it("treats missing provider secrets as already removed during removal retry", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const externalRef =
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/retry-delete";
    const secretId = randomUUID();
    await db.insert(companySecrets).values({
      id: secretId,
      companyId,
      key: `retry-delete__deleted__${secretId}`,
      name: `Retry Delete__deleted__${secretId}`,
      provider: "aws_secrets_manager",
      managedMode: "paperclip_managed",
      externalRef,
      latestVersion: 1,
      status: "deleted",
      deletedAt: new Date(),
    });
    await db.insert(companySecretVersions).values({
      secretId,
      version: 1,
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: externalRef,
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      providerVersionRef: "aws-version-1",
      status: "current",
    });
    const deleteSpy = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockRejectedValueOnce(
      new SecretProviderClientError({
        code: "not_found",
        provider: "aws_secrets_manager",
        operation: "delete_secret",
        message: "Secret not found.",
      }),
    );

    await expect(svc.remove(secretId)).resolves.toMatchObject({ id: secretId });
    const persisted = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, secretId))
      .then((rows) => rows[0] ?? null);

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(persisted).toBeNull();
  });

  it("removes DB rows even when the attached provider vault is disabled", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const vault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS disabled later",
      config: {
        region: "us-east-1",
        namespace: "prod",
      },
    });
    const externalRef =
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod/company-1/openai-api-key";
    const secret = await db
      .insert(companySecrets)
      .values({
        companyId,
        key: "openai-api-key",
        name: "OpenAI API Key",
        provider: "aws_secrets_manager",
        providerConfigId: vault.id,
        managedMode: "paperclip_managed",
        externalRef,
        latestVersion: 1,
        status: "active",
      })
      .returning()
      .then((rows) => rows[0]);

    await db.insert(companySecretVersions).values({
      secretId: secret.id,
      version: 1,
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: externalRef,
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      providerVersionRef: "aws-version-1",
      status: "current",
    });
    await svc.disableProviderConfig(vault.id);
    const deleteSpy = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockResolvedValue();

    await expect(svc.remove(secret.id)).resolves.toMatchObject({ id: secret.id });
    const persisted = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, secret.id))
      .then((rows) => rows[0] ?? null);

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(persisted).toBeNull();
  });

  it("refuses to resolve secrets once they are disabled or archived", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `managed-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });

    await svc.update(secret.id, { status: "disabled" });
    await expect(svc.resolveSecretValue(companyId, secret.id, "latest")).rejects.toThrow(
      /not active/i,
    );

    await svc.update(secret.id, { status: "archived" });
    await expect(svc.resolveSecretValue(companyId, secret.id, "latest")).rejects.toThrow(
      /not active/i,
    );
  });

  it("records audited ephemeral secret access without requiring a persisted binding", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `ephemeral-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    await seedCompanyMember(companyId, "user-1");

    const resolved = await svc.resolveSecretValueForEphemeralAccess(companyId, secret.id, "latest", {
      consumerType: "system",
      consumerId: "environment-probe-config",
      configPath: "apiKey",
      actorType: "user",
      actorId: "user-1",
    });

    expect(resolved).toBe("runtime-secret");
    const events = await svc.listAccessEvents(companyId, secret.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      companyId,
      secretId: secret.id,
      consumerType: "system",
      consumerId: "environment-probe-config",
      configPath: "apiKey",
      actorType: "user",
      actorId: "user-1",
      outcome: "success",
    });
    expect(JSON.stringify(events)).not.toContain("runtime-secret");
  });

  it("preserves local implicit board authorization for ephemeral secret access", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `ephemeral-local-board-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });

    const resolved = await svc.resolveSecretValueForEphemeralAccess(companyId, secret.id, "latest", {
      consumerType: "system",
      consumerId: "environment-probe-config",
      configPath: "apiKey",
      actorType: "user",
      actorId: "local-board",
      actorSource: "local_implicit",
    });

    expect(resolved).toBe("runtime-secret");
  });

  it("preserves agent jwt source for ephemeral secret authorization", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `ephemeral-agent-jwt-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "JWT Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const resolved = await svc.resolveSecretValueForEphemeralAccess(companyId, secret.id, "latest", {
      consumerType: "system",
      consumerId: "environment-probe-config",
      configPath: "apiKey",
      actorType: "agent",
      actorId: agentId,
      actorSource: "agent_jwt",
    });

    expect(resolved).toBe("runtime-secret");
  });

  it("rejects ephemeral secret access for actors without secret-read authorization", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `ephemeral-denied-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });

    await expect(
      svc.resolveSecretValueForEphemeralAccess(companyId, secret.id, "latest", {
        consumerType: "system",
        consumerId: "environment-probe-config",
        configPath: "apiKey",
        actorType: "user",
        actorId: "user-without-membership",
      }),
    ).rejects.toThrow(/active member|secrets:read|forbidden/i);
  });
});
