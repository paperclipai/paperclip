import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, companies, companySecrets, companySecretVersions, userSecretDefinitions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { writeConnectionCredential } from "../services/connection-credentials.js";
import { vaultProvider } from "../secrets/vault-provider.js";
import { HttpError } from "../errors.js";

// Connection credentials must route through the configured secret provider.
// When PAPERCLIP_SECRETS_PROVIDER=vault, a tool/AI/email/chat credential write
// creates a vault-backed secret — the value goes to Vault (the mocked provider),
// never to the local company_secrets store. These tests pin that routing for
// both the company-scoped and user-scoped (per_user) paths, plus fail-closed
// propagation of a provider error.

function preparedVaultVersion(path: string, version: number) {
  return {
    material: { scheme: "vault_kv_v2", source: "managed", mount: "kv", path, dataKey: "value", version },
    valueSha256: "value-sha-256",
    fingerprintSha256: "fingerprint-sha-256",
    externalRef: `kv/${path}`,
    providerVersionRef: String(version),
  };
}

describe("connection credential provider routing", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db: ReturnType<typeof createDb>;
  const previousProvider = process.env.PAPERCLIP_SECRETS_PROVIDER;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("connection-credentials-provider");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    process.env.PAPERCLIP_SECRETS_PROVIDER = "vault";
  }, 90_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(userSecretDefinitions);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousProvider === undefined) {
      delete process.env.PAPERCLIP_SECRETS_PROVIDER;
    } else {
      process.env.PAPERCLIP_SECRETS_PROVIDER = previousProvider;
    }
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Credential provider", issuePrefix: "CRED" });
    return companyId;
  }

  it("routes a company-scoped credential to the configured provider and keeps the value out of company_secrets", async () => {
    const companyId = await seedCompany();
    const createSecretSpy = vi
      .spyOn(vaultProvider, "createSecret")
      .mockResolvedValue(preparedVaultVersion("paperclip/company/conn-secret", 1) as never);

    await writeConnectionCredential(db, {
      companyId,
      connectionName: "Test connection",
      configPath: "authorization",
      label: "API key",
      value: "fixture-credential-value",
    });

    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(secret.provider).toBe("vault");
    // The raw value is written to the provider, not the local store.
    expect(createSecretSpy).toHaveBeenCalledWith(expect.objectContaining({ value: "fixture-credential-value" }));
    const [version] = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secret.id));
    expect(JSON.stringify(version)).not.toContain("fixture-credential-value");
    expect(version.material).toMatchObject({ scheme: "vault_kv_v2", source: "managed" });
  });

  it("routes a user-scoped (per_user) credential to the configured provider", async () => {
    const companyId = await seedCompany();
    const ownerUserId = randomUUID();
    const createSecretSpy = vi
      .spyOn(vaultProvider, "createSecret")
      .mockResolvedValue(preparedVaultVersion("paperclip/company/user-secret", 1) as never);

    await writeConnectionCredential(db, {
      companyId,
      connectionName: "Test connection",
      configPath: "authorization",
      label: "API key",
      value: "fixture-user-value",
      ownerUserId,
      definitionKey: "test_connection_authorization",
      actor: { userId: ownerUserId, agentId: null },
    });

    const [definition] = await db.select().from(userSecretDefinitions).where(eq(userSecretDefinitions.companyId, companyId));
    expect(definition.provider).toBe("vault");
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(secret.provider).toBe("vault");
    expect(secret.scope).toBe("user");
    expect(secret.ownerUserId).toBe(ownerUserId);
    expect(createSecretSpy).toHaveBeenCalledWith(expect.objectContaining({ value: "fixture-user-value" }));
  });

  it("propagates a provider error without falling back to local storage", async () => {
    const companyId = await seedCompany();
    vi.spyOn(vaultProvider, "createSecret").mockRejectedValue(
      new Error("vault unavailable"),
    );

    const error = await writeConnectionCredential(db, {
      companyId,
      connectionName: "Test connection",
      configPath: "authorization",
      label: "API key",
      value: "fixture-value",
    }).catch((caught: unknown) => caught);

    // Fail closed: the provider error surfaces as a 502 (no silent
    // local_encrypted fallback), and no local secret row is committed.
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(502);
    expect((error as HttpError).details).toMatchObject({ code: "provider_error" });

    const rows = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(rows).toHaveLength(0);
  });
});
