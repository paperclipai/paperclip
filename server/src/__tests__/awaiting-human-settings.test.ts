import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companyAwaitingHumanSettings,
  companySecretVersions,
  companySecrets,
  companies,
  createDb,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { awaitingHumanSettingsService } from "../services/awaiting-human-settings.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createFailingAwaitingHumanSettingsDb(baseDb: ReturnType<typeof createDb>) {
  const wrap = (value: unknown): any => new Proxy(value as object, {
    get(target, prop, receiver) {
      if (prop === "insert" || prop === "update") {
        return (table: unknown, ...args: unknown[]) => {
          if (table === companyAwaitingHumanSettings) {
            throw new Error("forced awaiting-human settings write failure");
          }
          const method = Reflect.get(target, prop, receiver);
          return typeof method === "function"
            ? method.call(target, table, ...args)
            : method;
        };
      }

      if (prop === "transaction") {
        return (action: (tx: unknown) => Promise<unknown>) => {
          const method = Reflect.get(target, prop, receiver);
          return typeof method === "function"
            ? method.call(target, async (tx: unknown) => action(wrap(tx)))
            : method;
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return wrap(baseDb) as ReturnType<typeof createDb>;
}

async function createCompany(db: ReturnType<typeof createDb>, companyId: string) {
  await db.insert(companies).values({
    id: companyId,
    name: "Paperclip",
    issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
}

describeEmbeddedPostgres("awaitingHumanSettingsService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-awaiting-human-settings-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companyAwaitingHumanSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("uses an upsert when two first-time saves race for the same company", async () => {
    const companyId = randomUUID();
    await createCompany(db, companyId);

    const service = awaitingHumanSettingsService(db);
    const patch = {
      enabled: true,
      provider: "clickup" as const,
      providerConfig: {
        workspaceId: "workspace-123",
        channelId: "channel-123",
        attachmentTaskId: null,
        primaryReviewerUserId: "primary-user-id",
        secondaryReviewerUserId: "secondary-user-id",
      },
      clickupPersonalToken: "token-123",
    };

    const [first, second] = await Promise.all([
      service.update(companyId, patch, { userId: "user-1", agentId: null }),
      service.update(companyId, patch, { userId: "user-2", agentId: null }),
    ]);

    expect(first).toEqual(expect.objectContaining({
      companyId,
      enabled: true,
      provider: "clickup",
    }));
    expect(second).toEqual(expect.objectContaining({
      companyId,
      enabled: true,
      provider: "clickup",
    }));

    const settingsRows = await db.select().from(companyAwaitingHumanSettings).where(eq(companyAwaitingHumanSettings.companyId, companyId));
    expect(settingsRows).toHaveLength(1);
    expect(settingsRows[0]?.providerConfigJson).toEqual(expect.objectContaining({
      workspaceId: "workspace-123",
      channelId: "channel-123",
      attachmentTaskId: null,
      primaryReviewerUserId: "primary-user-id",
      secondaryReviewerUserId: "secondary-user-id",
    }));
  });

  it("saves and returns generic approval reviewer IDs", async () => {
    const companyId = randomUUID();
    await createCompany(db, companyId);

    const service = awaitingHumanSettingsService(db);
    const updated = await service.update(companyId, {
      enabled: true,
      provider: "clickup",
      providerConfig: {
        workspaceId: "workspace-123",
        channelId: "channel-123",
        attachmentTaskId: "task-123",
        primaryReviewerUserId: "primary-user-id",
        secondaryReviewerUserId: "secondary-user-id",
      },
      clickupPersonalToken: "token-123",
    }, {
      userId: "user-1",
      agentId: null,
    });

    expect(updated).toEqual(expect.objectContaining({
      companyId,
      enabled: true,
      provider: "clickup",
      providerConfig: {
        workspaceId: "workspace-123",
        channelId: "channel-123",
        attachmentTaskId: "task-123",
        primaryReviewerUserId: "primary-user-id",
        secondaryReviewerUserId: "secondary-user-id",
      },
      hasStoredAuthToken: true,
    }));

    const fetched = await service.get(companyId);
    expect(fetched.providerConfig).toEqual({
      workspaceId: "workspace-123",
      channelId: "channel-123",
      attachmentTaskId: "task-123",
      primaryReviewerUserId: "primary-user-id",
      secondaryReviewerUserId: "secondary-user-id",
    });
  });

  it("does not rotate the stored token until ClickUp validation passes", async () => {
    const companyId = randomUUID();
    const secrets = secretService(db);
    await createCompany(db, companyId);

    const secret = await secrets.create(companyId, {
      name: "awaiting-human-clickup-token",
      provider: "local_encrypted",
      value: "old-token",
    });

    await db.insert(companyAwaitingHumanSettings).values({
      companyId,
      enabled: true,
      provider: "clickup",
      providerConfigJson: {
        authTokenRef: { type: "secret_ref", secretId: secret.id, version: "latest" },
        workspaceId: "workspace-123",
        channelId: "channel-123",
      },
    });

    const service = awaitingHumanSettingsService(db);

    await expect(service.update(companyId, {
      enabled: true,
      provider: "clickup",
      providerConfig: {
        workspaceId: null,
        channelId: "channel-123",
      },
      clickupPersonalToken: "new-token",
    }, {
      userId: "user-1",
      agentId: null,
    })).rejects.toThrow(/workspace ID/i);

    const [storedSecret] = await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id));
    expect(storedSecret?.latestVersion).toBe(1);
    await expect(secrets.resolveSecretValue(companyId, secret.id, "latest")).resolves.toBe("old-token");
  });

  it("allows a blank ClickUp channel ID and still rotates the stored token", async () => {
    const companyId = randomUUID();
    const secrets = secretService(db);
    await createCompany(db, companyId);

    const secret = await secrets.create(companyId, {
      name: "awaiting-human-clickup-token",
      provider: "local_encrypted",
      value: "old-token",
    });

    await db.insert(companyAwaitingHumanSettings).values({
      companyId,
      enabled: true,
      provider: "clickup",
      providerConfigJson: {
        authTokenRef: { type: "secret_ref", secretId: secret.id, version: "latest" },
        workspaceId: "workspace-123",
        channelId: "channel-123",
      },
    });

    const service = awaitingHumanSettingsService(db);
    const updated = await service.update(companyId, {
      enabled: true,
      provider: "clickup",
      providerConfig: {
        workspaceId: "workspace-123",
        channelId: null,
        attachmentTaskId: null,
        primaryReviewerUserId: null,
        secondaryReviewerUserId: null,
      },
      clickupPersonalToken: "new-token",
    }, {
      userId: "user-1",
      agentId: null,
    });

    expect(updated).toEqual(expect.objectContaining({
      companyId,
      enabled: true,
      provider: "clickup",
      providerConfig: {
        workspaceId: "workspace-123",
        channelId: null,
        attachmentTaskId: null,
        primaryReviewerUserId: null,
        secondaryReviewerUserId: null,
      },
      hasStoredAuthToken: true,
    }));

    const [storedSecret] = await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id));
    expect(storedSecret?.latestVersion).toBe(2);
    await expect(secrets.resolveSecretValue(companyId, secret.id, "latest")).resolves.toBe("new-token");
  });

  it("rejects enabling ClickUp without a stored or incoming token", async () => {
    const companyId = randomUUID();
    await createCompany(db, companyId);

    const service = awaitingHumanSettingsService(db);

    await expect(service.update(companyId, {
      enabled: true,
      provider: "clickup",
      providerConfig: {
        workspaceId: "workspace-123",
        channelId: "channel-123",
      },
    }, {
      userId: "user-1",
      agentId: null,
    })).rejects.toThrow(/personal token/i);

    const settingsRows = await db.select().from(companyAwaitingHumanSettings).where(eq(companyAwaitingHumanSettings.companyId, companyId));
    expect(settingsRows).toHaveLength(0);
  });

  it("rolls back a newly created ClickUp secret if the settings write fails", async () => {
    const companyId = randomUUID();
    await createCompany(db, companyId);

    const service = awaitingHumanSettingsService(createFailingAwaitingHumanSettingsDb(db));

    await expect(service.update(companyId, {
      enabled: true,
      provider: "clickup",
      providerConfig: {
        workspaceId: "workspace-123",
        channelId: "channel-123",
      },
      clickupPersonalToken: "token-to-roll-back",
    }, {
      userId: "user-1",
      agentId: null,
    })).rejects.toThrow(/forced awaiting-human settings write failure/i);

    const secretRows = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(secretRows).toHaveLength(0);
    const secretVersionRows = await db.select().from(companySecretVersions);
    expect(secretVersionRows).toHaveLength(0);
    const settingsRows = await db.select().from(companyAwaitingHumanSettings).where(eq(companyAwaitingHumanSettings.companyId, companyId));
    expect(settingsRows).toHaveLength(0);
  });

  it("deletes the stored ClickUp secret when switching away from ClickUp", async () => {
    const companyId = randomUUID();
    const secrets = secretService(db);
    await createCompany(db, companyId);

    const secret = await secrets.create(companyId, {
      name: "awaiting-human-clickup-token",
      provider: "local_encrypted",
      value: "old-token",
    });

    await db.insert(companyAwaitingHumanSettings).values({
      companyId,
      enabled: true,
      provider: "clickup",
      providerConfigJson: {
        authTokenRef: { type: "secret_ref", secretId: secret.id, version: "latest" },
        workspaceId: "workspace-123",
        channelId: "channel-123",
      },
    });

    const service = awaitingHumanSettingsService(db);
    const updated = await service.update(companyId, {
      enabled: false,
      provider: null,
    }, {
      userId: "user-1",
      agentId: null,
    });

    expect(updated).toEqual(expect.objectContaining({
      companyId,
      enabled: false,
      provider: null,
      providerConfig: null,
      hasStoredAuthToken: false,
    }));

    const [storedSecret] = await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id));
    expect(storedSecret).toBeUndefined();
  });

  it("defaults companies without a settings row to disabled awaiting-human delivery", async () => {
    const companyId = randomUUID();
    await createCompany(db, companyId);

    const service = awaitingHumanSettingsService(db);
    const settings = await service.get(companyId);

    expect(settings).toEqual(expect.objectContaining({
      companyId,
      enabled: false,
      provider: null,
      providerConfig: null,
      hasStoredAuthToken: false,
    }));
  });
});
