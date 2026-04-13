import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { formatLocalEncryptedMasterKey } from "../secrets/local-encrypted-provider.ts";
import { secretService } from "../services/secrets.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres secrets rekey tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const originalMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
const originalMasterKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;

function useMasterKey(key: Buffer): void {
  process.env.PAPERCLIP_SECRETS_MASTER_KEY = formatLocalEncryptedMasterKey(key);
  delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
}

function restoreMasterKeyEnv(): void {
  if (originalMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  else process.env.PAPERCLIP_SECRETS_MASTER_KEY = originalMasterKey;

  if (originalMasterKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = originalMasterKeyFile;
}

async function seedCompany(db: ReturnType<typeof createDb>): Promise<string> {
  const companyId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "Paperclip",
    issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  return companyId;
}

describeEmbeddedPostgres("secretService.rekeyLocalEncryptedMasterKey", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-secrets-rekey-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companies);
    restoreMasterKeyEnv();
  });

  afterAll(async () => {
    restoreMasterKeyEnv();
    await tempDb?.cleanup();
  });

  it("re-encrypts existing versions with the new key while preserving secret history", async () => {
    const oldKey = Buffer.alloc(32, 17);
    const newKey = Buffer.alloc(32, 42);
    useMasterKey(oldKey);

    const svc = secretService(db);
    const companyId = await seedCompany(db);
    const first = await svc.create(
      companyId,
      {
        name: "fake_api_token",
        provider: "local_encrypted",
        value: "fake-value-v1",
      },
      { userId: "test", agentId: null },
    );
    await svc.rotate(
      first.id,
      { value: "fake-value-v2" },
      { userId: "test", agentId: null },
    );
    const second = await svc.create(
      companyId,
      {
        name: "fake_webhook_secret",
        provider: "local_encrypted",
        value: "fake-webhook-value",
      },
      { userId: "test", agentId: null },
    );

    expect(await svc.resolveSecretValue(companyId, first.id, 1)).toBe("fake-value-v1");
    expect(await svc.resolveSecretValue(companyId, first.id, "latest")).toBe("fake-value-v2");
    expect(await svc.resolveSecretValue(companyId, second.id, "latest")).toBe("fake-webhook-value");

    const dryRun = await svc.rekeyLocalEncryptedMasterKey({
      oldMasterKey: oldKey,
      newMasterKey: newKey,
      dryRun: true,
      actorId: "test",
    });
    expect(dryRun).toMatchObject({
      dryRun: true,
      provider: "local_encrypted",
      companyCount: 1,
      secretCount: 2,
      versionCount: 3,
    });
    expect(await svc.resolveSecretValue(companyId, first.id, 1)).toBe("fake-value-v1");
    expect(await db.select().from(activityLog)).toHaveLength(0);

    const applied = await svc.rekeyLocalEncryptedMasterKey({
      oldMasterKey: oldKey,
      newMasterKey: newKey,
      dryRun: false,
      actorId: "test",
    });
    expect(applied).toMatchObject({
      dryRun: false,
      companyCount: 1,
      secretCount: 2,
      versionCount: 3,
    });

    await expect(svc.resolveSecretValue(companyId, first.id, "latest")).rejects.toThrow();
    useMasterKey(newKey);
    expect(await svc.resolveSecretValue(companyId, first.id, 1)).toBe("fake-value-v1");
    expect(await svc.resolveSecretValue(companyId, first.id, "latest")).toBe("fake-value-v2");
    expect(await svc.resolveSecretValue(companyId, second.id, "latest")).toBe("fake-webhook-value");

    const [persistedFirst] = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, first.id));
    expect(persistedFirst?.latestVersion).toBe(2);

    const logs = await db.select().from(activityLog);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      companyId,
      actorType: "system",
      actorId: "test",
      action: "secret.local_master_key_rekeyed",
      entityType: "local_encrypted_master_key",
      entityId: companyId,
    });
    expect(logs[0]?.details).toMatchObject({
      provider: "local_encrypted",
      secretCount: 2,
      versionCount: 3,
    });
  });

  it("does not mutate encrypted material when the old key cannot decrypt all versions", async () => {
    const oldKey = Buffer.alloc(32, 7);
    const wrongOldKey = Buffer.alloc(32, 8);
    const newKey = Buffer.alloc(32, 9);
    useMasterKey(oldKey);

    const svc = secretService(db);
    const companyId = await seedCompany(db);
    const secret = await svc.create(
      companyId,
      {
        name: "fake_service_token",
        provider: "local_encrypted",
        value: "fake-service-value",
      },
      { userId: "test", agentId: null },
    );
    const [before] = await db
      .select()
      .from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, secret.id));

    await expect(
      svc.rekeyLocalEncryptedMasterKey({
        oldMasterKey: wrongOldKey,
        newMasterKey: newKey,
        dryRun: false,
        actorId: "test",
      }),
    ).rejects.toThrow(/Could not decrypt local_encrypted secret version/);

    const [after] = await db
      .select()
      .from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, secret.id));
    expect(after?.material).toEqual(before?.material);
    expect(await svc.resolveSecretValue(companyId, secret.id, "latest")).toBe("fake-service-value");
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });
});
