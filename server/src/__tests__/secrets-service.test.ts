import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
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
});
