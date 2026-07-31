import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecrets,
  companySecretVersions,
  createDb,
  plugins,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  createPluginSecretsHandler,
  extractSecretRefBindingsFromConfig,
} from "../services/plugin-secrets-handler.js";
import { secretService } from "../services/secrets.js";

const pluginId = "11111111-1111-4111-8111-111111111111";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin secret handler integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("extractSecretRefBindingsFromConfig", () => {
  it("ignores UUID strings outside schema-declared secret fields", () => {
    const externalProjectId = "77777777-7777-4777-8777-777777777777";

    expect(extractSecretRefBindingsFromConfig(
      { externalProjectId },
      { type: "object", properties: { externalProjectId: { type: "string" } } },
    )).toEqual([]);
  });

  it("rejects legacy UUID strings at schema-declared secret fields", () => {
    const secretId = "77777777-7777-4777-8777-777777777777";

    expect(() => extractSecretRefBindingsFromConfig(
      { token: secretId },
      { type: "object", properties: { token: { format: "secret-ref" } } },
    )).toThrow(/must use.*secret_ref/i);
  });
});

describe("createPluginSecretsHandler fail-closed guards", () => {
  it("requires company context before touching the database", async () => {
    const db = { select: vi.fn(() => { throw new Error("db should not be touched"); }) };
    const handler = createPluginSecretsHandler({ db: db as never, pluginId });

    await expect(
      handler.resolve({ secretRef: { type: "secret_ref", secretId: randomUUID() } }),
    ).rejects.toThrow(/companyId is required/i);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("rejects legacy string refs before provider resolution", async () => {
    const db = { select: vi.fn(() => { throw new Error("db should not be touched"); }) };
    const handler = createPluginSecretsHandler({ db: db as never, pluginId });

    await expect(
      handler.resolve({ companyId: randomUUID(), secretRef: randomUUID() }),
    ).rejects.toThrow(/use \{ type: "secret_ref"/i);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describeEmbeddedPostgres("createPluginSecretsHandler shared vault integration", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-plugin-secrets-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("plugin-secrets-handler");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(plugins);
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

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `P${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function seedPlugin() {
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.plugin-secrets-test",
      packageName: "@paperclipai/plugin-secrets-test",
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.plugin-secrets-test",
        apiVersion: 1,
        version: "0.0.1",
        displayName: "Plugin Secrets Test",
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
  }

  it("resolves bound plugin refs through secretService and emits plugin_worker access events", async () => {
    await seedPlugin();
    const companyId = await seedCompany("Plugin Co");
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `plugin-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "resolved-plugin-secret",
    });
    await svc.syncSecretRefsForTarget(companyId, { targetType: "plugin", targetId: pluginId }, [
      { secretId: secret.id, configPath: "apiKey" },
    ], { replaceAll: true });

    const handler = createPluginSecretsHandler({ db, pluginId });
    await expect(
      handler.resolve({
        companyId,
        secretRef: { type: "secret_ref", secretId: secret.id, version: "latest" },
      }),
    ).resolves.toBe("resolved-plugin-secret");

    const events = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, secret.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      companyId,
      secretId: secret.id,
      consumerType: "plugin_worker",
      consumerId: pluginId,
      configPath: "apiKey",
      pluginId,
      outcome: "success",
      errorCode: null,
    });
  });

  it("fails closed for cross-company resolve before secret provider access", async () => {
    await seedPlugin();
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = secretService(db);
    const foreignSecret = await svc.create(companyB, {
      name: `foreign-plugin-secret-${randomUUID()}`,
      provider: "local_encrypted",
      value: "foreign-value",
    });
    await svc.syncSecretRefsForTarget(companyB, { targetType: "plugin", targetId: pluginId }, [
      { secretId: foreignSecret.id, configPath: "apiKey" },
    ], { replaceAll: true });

    const handler = createPluginSecretsHandler({ db, pluginId });
    await expect(
      handler.resolve({
        companyId: companyA,
        secretRef: { type: "secret_ref", secretId: foreignSecret.id, version: "latest" },
      }),
    ).rejects.toThrow(/not bound/i);

    const events = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, foreignSecret.id));
    expect(events).toHaveLength(0);
  });
});
