import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
    `Skipping oauth_token lazy-refresh tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("resolveAdapterConfigForRuntime — lazy refresh", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(
    os.tmpdir(),
    `paperclip-secrets-oauth-lazy-${randomUUID()}`,
  );

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(
      secretsTmpDir,
      "master.key",
    );
    const started = await startEmbeddedPostgresTestDatabase("secrets-oauth-lazy");
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

  async function seedConnection(input: {
    companyId: string;
    accessSecretId: string;
    refreshSecretId: string | null;
    expiresAt: Date | null;
    status?: "active" | "expired" | "revoked" | "error";
  }) {
    const connectionId = randomUUID();
    await db.insert(oauthConnections).values({
      id: connectionId,
      companyId: input.companyId,
      providerId: "github",
      status: input.status ?? "active",
      accessTokenSecretId: input.accessSecretId,
      refreshTokenSecretId: input.refreshSecretId,
      accountId: "acct-42",
      accountLabel: "Octo",
      scopes: ["repo"],
      accessTokenExpiresAt: input.expiresAt,
      lastError: null,
      lastErrorAt: null,
      lastRefreshedAt: new Date(),
      refreshAttemptCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return connectionId;
  }

  it("calls refreshFn when access token expires inside the lazy window", async () => {
    const companyId = await seedCompany();
    const refreshFn = vi
      .fn()
      .mockResolvedValue({ outcome: "success", accessToken: "FRESH-TOKEN" });
    const svc = secretService(db, {
      registry: new ProviderRegistry({ env: {} }),
      refreshFn,
    });
    const accessSecret = await svc.upsertSecretByName(companyId, {
      name: `oauth:github:acct-42:access-${randomUUID()}`,
      value: "STALE-TOKEN",
    });
    const refreshSecret = await svc.upsertSecretByName(companyId, {
      name: `oauth:github:acct-42:refresh-${randomUUID()}`,
      value: "REFRESH-TOKEN",
    });
    const connectionId = await seedConnection({
      companyId,
      accessSecretId: accessSecret.id,
      refreshSecretId: refreshSecret.id,
      // Expires in 30s — inside the 60s lazy window.
      expiresAt: new Date(Date.now() + 30_000),
    });

    const result = await svc.resolveAdapterConfigForRuntime(companyId, {
      env: {
        GITHUB_TOKEN: { type: "oauth_token", connectionId, field: "access" },
      },
    });

    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(refreshFn.mock.calls[0]?.[0]?.connectionId).toBe(connectionId);
    expect((result.config.env as Record<string, string>).GITHUB_TOKEN).toBe(
      "FRESH-TOKEN",
    );
    expect(result.oauthConnectionIds).toEqual([connectionId]);
  });

  it("skips refresh when access token expires far in the future", async () => {
    const companyId = await seedCompany();
    const refreshFn = vi.fn();
    const svc = secretService(db, {
      registry: new ProviderRegistry({ env: {} }),
      refreshFn,
    });
    const accessSecret = await svc.upsertSecretByName(companyId, {
      name: `oauth:github:acct-42:access-${randomUUID()}`,
      value: "FRESH-ENOUGH-TOKEN",
    });
    const refreshSecret = await svc.upsertSecretByName(companyId, {
      name: `oauth:github:acct-42:refresh-${randomUUID()}`,
      value: "REFRESH-TOKEN",
    });
    const connectionId = await seedConnection({
      companyId,
      accessSecretId: accessSecret.id,
      refreshSecretId: refreshSecret.id,
      // Expires in 1h — well outside the lazy window.
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const result = await svc.resolveAdapterConfigForRuntime(companyId, {
      env: {
        GITHUB_TOKEN: { type: "oauth_token", connectionId, field: "access" },
      },
    });

    expect(refreshFn).not.toHaveBeenCalled();
    expect((result.config.env as Record<string, string>).GITHUB_TOKEN).toBe(
      "FRESH-ENOUGH-TOKEN",
    );
  });

  it("falls back to the existing access secret on transient refresh failure when token is still valid", async () => {
    const companyId = await seedCompany();
    const refreshFn = vi
      .fn()
      .mockResolvedValue({ outcome: "transient", error: "network_blip" });
    const svc = secretService(db, {
      registry: new ProviderRegistry({ env: {} }),
      refreshFn,
    });
    const accessSecret = await svc.upsertSecretByName(companyId, {
      name: `oauth:github:acct-42:access-${randomUUID()}`,
      value: "STALE-TOKEN",
    });
    const refreshSecret = await svc.upsertSecretByName(companyId, {
      name: `oauth:github:acct-42:refresh-${randomUUID()}`,
      value: "REFRESH-TOKEN",
    });
    const connectionId = await seedConnection({
      companyId,
      accessSecretId: accessSecret.id,
      refreshSecretId: refreshSecret.id,
      // Expires in 30s — inside the lazy window, but still positive.
      expiresAt: new Date(Date.now() + 30_000),
    });

    const result = await svc.resolveAdapterConfigForRuntime(companyId, {
      env: {
        GITHUB_TOKEN: { type: "oauth_token", connectionId, field: "access" },
      },
    });

    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect((result.config.env as Record<string, string>).GITHUB_TOKEN).toBe(
      "STALE-TOKEN",
    );
  });

  it("propagates revoked outcome from refreshFn as oauth_connection_revoked", async () => {
    const companyId = await seedCompany();
    const refreshFn = vi.fn().mockResolvedValue({ outcome: "revoked" });
    const svc = secretService(db, {
      registry: new ProviderRegistry({ env: {} }),
      refreshFn,
    });
    const accessSecret = await svc.upsertSecretByName(companyId, {
      name: `oauth:github:acct-42:access-${randomUUID()}`,
      value: "STALE-TOKEN",
    });
    const refreshSecret = await svc.upsertSecretByName(companyId, {
      name: `oauth:github:acct-42:refresh-${randomUUID()}`,
      value: "REFRESH-TOKEN",
    });
    const connectionId = await seedConnection({
      companyId,
      accessSecretId: accessSecret.id,
      refreshSecretId: refreshSecret.id,
      expiresAt: new Date(Date.now() + 30_000),
    });

    await expect(
      svc.resolveAdapterConfigForRuntime(companyId, {
        env: {
          GITHUB_TOKEN: { type: "oauth_token", connectionId, field: "access" },
        },
      }),
    ).rejects.toMatchObject({ errorCode: "oauth_connection_revoked" });
  });

  it("does not call refreshFn when refreshTokenSecretId is null", async () => {
    const companyId = await seedCompany();
    const refreshFn = vi.fn();
    const svc = secretService(db, {
      registry: new ProviderRegistry({ env: {} }),
      refreshFn,
    });
    const accessSecret = await svc.upsertSecretByName(companyId, {
      name: `oauth:github:acct-42:access-${randomUUID()}`,
      value: "PLAIN-TOKEN",
    });
    const connectionId = await seedConnection({
      companyId,
      accessSecretId: accessSecret.id,
      refreshSecretId: null,
      expiresAt: new Date(Date.now() + 30_000), // would normally trigger refresh
    });

    const result = await svc.resolveAdapterConfigForRuntime(companyId, {
      env: {
        GITHUB_TOKEN: { type: "oauth_token", connectionId, field: "access" },
      },
    });

    expect(refreshFn).not.toHaveBeenCalled();
    expect((result.config.env as Record<string, string>).GITHUB_TOKEN).toBe(
      "PLAIN-TOKEN",
    );
  });
});
