import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { oauthConnections } from "@paperclipai/db/schema/oauth";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { ProviderRegistry } from "../../oauth/registry.js";
import { secretService } from "../secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping oauth_token resolver tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("resolveAdapterConfigForRuntime — oauth_token bindings", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(
    os.tmpdir(),
    `paperclip-secrets-oauth-binding-${randomUUID()}`,
  );

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(
      secretsTmpDir,
      "master.key",
    );
    const started = await startEmbeddedPostgresTestDatabase("secrets-oauth-binding");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(oauthConnections);
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

  function makeOauthDeps() {
    return { registry: new ProviderRegistry({ env: {} }) };
  }

  async function seedConnection(input: {
    companyId: string;
    accessSecretId: string;
    status: "active" | "expired" | "revoked" | "error";
    accessTokenExpiresAt?: Date;
  }) {
    const connectionId = randomUUID();
    await db.insert(oauthConnections).values({
      id: connectionId,
      companyId: input.companyId,
      providerId: "github",
      status: input.status,
      accessTokenSecretId: input.accessSecretId,
      refreshTokenSecretId: null,
      accountId: "acct-42",
      accountLabel: "Octo",
      scopes: ["repo"],
      accessTokenExpiresAt:
        input.accessTokenExpiresAt ?? new Date(Date.now() + 3600_000),
      lastError: null,
      lastErrorAt: null,
      lastRefreshedAt: new Date(),
      refreshAttemptCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return connectionId;
  }

  it("resolves an oauth_token binding to the access-token plaintext", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db, makeOauthDeps());
    const accessSecret = await svc.upsertSecretByName(companyId, {
      name: `oauth:github:acct-42:access-${randomUUID()}`,
      value: "ACCESS-PLAINTEXT-XYZ",
    });
    const connectionId = await seedConnection({
      companyId,
      accessSecretId: accessSecret.id,
      status: "active",
    });

    const result = await svc.resolveAdapterConfigForRuntime(companyId, {
      env: {
        GITHUB_TOKEN: { type: "oauth_token", connectionId, field: "access" },
      },
    });

    expect((result.config.env as Record<string, string>).GITHUB_TOKEN).toBe(
      "ACCESS-PLAINTEXT-XYZ",
    );
    expect(result.oauthConnectionIds).toEqual([connectionId]);
    expect(result.secretKeys.has("GITHUB_TOKEN")).toBe(true);
  });

  it("rejects an oauth_token binding for a missing connection", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db, makeOauthDeps());
    const missingId = randomUUID();

    await expect(
      svc.resolveAdapterConfigForRuntime(companyId, {
        env: {
          GITHUB_TOKEN: { type: "oauth_token", connectionId: missingId, field: "access" },
        },
      }),
    ).rejects.toMatchObject({ errorCode: "oauth_connection_missing" });
  });

  it("rejects an oauth_token binding when the connection is revoked", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db, makeOauthDeps());
    const accessSecret = await svc.upsertSecretByName(companyId, {
      name: `oauth:github:acct-42:access-${randomUUID()}`,
      value: "ACCESS-PLAINTEXT-XYZ",
    });
    const connectionId = await seedConnection({
      companyId,
      accessSecretId: accessSecret.id,
      status: "revoked",
    });

    await expect(
      svc.resolveAdapterConfigForRuntime(companyId, {
        env: {
          GITHUB_TOKEN: { type: "oauth_token", connectionId, field: "access" },
        },
      }),
    ).rejects.toMatchObject({ errorCode: "oauth_connection_revoked" });
  });

  it("rejects a cross-company oauth_token binding (treated as missing)", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = secretService(db, makeOauthDeps());
    const accessSecret = await svc.upsertSecretByName(companyB, {
      name: `oauth:github:acct-42:access-${randomUUID()}`,
      value: "ACCESS-PLAINTEXT-XYZ",
    });
    const connectionId = await seedConnection({
      companyId: companyB,
      accessSecretId: accessSecret.id,
      status: "active",
    });

    await expect(
      svc.resolveAdapterConfigForRuntime(companyA, {
        env: {
          GITHUB_TOKEN: { type: "oauth_token", connectionId, field: "access" },
        },
      }),
    ).rejects.toMatchObject({ errorCode: "oauth_connection_missing" });
  });

  it("rejects an expired oauth_token when no refresh secret is on file", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db, makeOauthDeps());
    const accessSecret = await svc.upsertSecretByName(companyId, {
      name: `oauth:github:acct-42:access-${randomUUID()}`,
      value: "EXPIRED-PLAINTEXT",
    });
    const connectionId = await seedConnection({
      companyId,
      accessSecretId: accessSecret.id,
      status: "active",
      accessTokenExpiresAt: new Date(Date.now() - 60_000), // expired 1 minute ago
    });

    await expect(
      svc.resolveAdapterConfigForRuntime(companyId, {
        env: {
          GITHUB_TOKEN: { type: "oauth_token", connectionId, field: "access" },
        },
      }),
    ).rejects.toMatchObject({ errorCode: "oauth_access_token_expired" });
  });

  it("throws unprocessable when oauthDeps is not wired", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db); // no oauthDeps
    const connectionId = randomUUID();

    await expect(
      svc.resolveAdapterConfigForRuntime(companyId, {
        env: {
          GITHUB_TOKEN: { type: "oauth_token", connectionId, field: "access" },
        },
      }),
    ).rejects.toThrow(/oauth_token bindings require server OAuth wiring/i);
  });
});
