import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";
import { createPluginSecretsHandler } from "../services/plugin-secrets-handler.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin secrets handler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// ---------------------------------------------------------------------------
// Unit tests (no DB required)
// ---------------------------------------------------------------------------

describe("createPluginSecretsHandler — format validation", () => {
  it("rejects an empty secretRef", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });
    await expect(
      handler.resolve({ secretRef: "" }),
    ).rejects.toMatchObject({ name: "InvalidSecretRefError" });
  });

  it("rejects a non-UUID secretRef", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });
    await expect(
      handler.resolve({ secretRef: "not-a-uuid" }),
    ).rejects.toMatchObject({ name: "InvalidSecretRefError" });
  });

  it("rejects when no company scope is in the context", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });
    // No context at all — treated as not-found (same error shape)
    await expect(
      handler.resolve({ secretRef: "77777777-7777-4777-8777-777777777777" }),
    ).rejects.toMatchObject({ name: "InvalidSecretRefError" });
  });

  it("rejects when context has no invocationScope", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });
    await expect(
      handler.resolve({ secretRef: "77777777-7777-4777-8777-777777777777" }, {}),
    ).rejects.toMatchObject({ name: "InvalidSecretRefError" });
  });

  it("error message for invalid ref does not include resolved value context", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });
    const err = await handler.resolve({ secretRef: "bad-ref" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message.toLowerCase()).not.toContain("password");
    expect(err.message.toLowerCase()).not.toContain("secret value");
  });

  it("rate-limit trips after 30 resolutions per minute", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "22222222-2222-4222-8222-222222222222",
    });
    const ref = "77777777-7777-4777-8777-777777777777";
    // All 30 will get InvalidSecretRefError (no DB), not RateLimitExceededError
    for (let i = 0; i < 30; i++) {
      await handler.resolve({ secretRef: ref }).catch(() => {});
    }
    // 31st must be rate-limited
    await expect(
      handler.resolve({ secretRef: ref }),
    ).rejects.toMatchObject({ name: "RateLimitExceededError" });
  });
});

// ---------------------------------------------------------------------------
// Integration tests (requires embedded Postgres)
// ---------------------------------------------------------------------------

describeEmbeddedPostgres("createPluginSecretsHandler — DB integration", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-plugin-secrets-handler-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("plugin-secrets-handler-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
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

  it("same-company resolve returns the secret value", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `my-secret-${randomUUID()}`,
      provider: "local_encrypted",
      value: "hunter2",
    });

    const handler = createPluginSecretsHandler({ db, pluginId: randomUUID() });
    const result = await handler.resolve(
      { secretRef: secret.id },
      { invocationScope: { companyId } },
    );
    expect(result).toBe("hunter2");
  });

  it("cross-company resolve rejects with the not-found-shaped error (no existence oracle)", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = secretService(db);
    const secretOfA = await svc.create(companyA, {
      name: `a-secret-${randomUUID()}`,
      provider: "local_encrypted",
      value: "a-value",
    });

    const handler = createPluginSecretsHandler({ db, pluginId: randomUUID() });
    const err = await handler.resolve(
      { secretRef: secretOfA.id },
      { invocationScope: { companyId: companyB } },
    ).catch((e) => e);

    // Same error shape as not-found — do not leak that the secret exists for A
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("InvalidSecretRefError");
    expect(err.message).not.toContain("a-value");
    expect(err.message).not.toContain(companyA);
  });

  it("resolving a non-existent UUID rejects with InvalidSecretRefError", async () => {
    const companyId = await seedCompany();
    const handler = createPluginSecretsHandler({ db, pluginId: randomUUID() });
    await expect(
      handler.resolve(
        { secretRef: randomUUID() },
        { invocationScope: { companyId } },
      ),
    ).rejects.toMatchObject({ name: "InvalidSecretRefError" });
  });

  it("resolved value never appears in any thrown error message", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = secretService(db);
    const secretOfA = await svc.create(companyA, {
      name: `sensitive-${randomUUID()}`,
      provider: "local_encrypted",
      value: "super-sensitive-payload",
    });

    const handler = createPluginSecretsHandler({ db, pluginId: randomUUID() });
    const err = await handler.resolve(
      { secretRef: secretOfA.id },
      { invocationScope: { companyId: companyB } },
    ).catch((e) => e);

    expect(String(err)).not.toContain("super-sensitive-payload");
    expect(JSON.stringify(err)).not.toContain("super-sensitive-payload");
  });
});
