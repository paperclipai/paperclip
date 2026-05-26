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

  it("does not rotate the stored token until ClickUp settings validation passes", async () => {
    const companyId = randomUUID();
    const secrets = secretService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

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
        workspaceId: "workspace-123",
        channelId: null,
      },
      clickupPersonalToken: "new-token",
    }, {
      userId: "user-1",
      agentId: null,
    })).rejects.toThrow(/channel ID/i);

    const [storedSecret] = await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id));
    expect(storedSecret?.latestVersion).toBe(1);
    await expect(secrets.resolveSecretValue(companyId, secret.id, "latest")).resolves.toBe("old-token");

    const [settingsRow] = await db.select().from(companyAwaitingHumanSettings).where(eq(companyAwaitingHumanSettings.companyId, companyId));
    expect(settingsRow?.providerConfigJson).toEqual(expect.objectContaining({
      workspaceId: "workspace-123",
      channelId: "channel-123",
    }));
  });

  it("uses an upsert when two first-time saves race for the same company", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const service = awaitingHumanSettingsService(db);
    const input = {
      enabled: true,
      provider: "clickup" as const,
      providerConfig: {
        workspaceId: "workspace-123",
        channelId: "channel-123",
      },
    };

    await Promise.all([
      service.update(companyId, input, { userId: "user-1", agentId: null }),
      service.update(companyId, input, { userId: "user-2", agentId: null }),
    ]);

    const rows = await db.select().from(companyAwaitingHumanSettings).where(eq(companyAwaitingHumanSettings.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      companyId,
      enabled: true,
      provider: "clickup",
      providerConfigJson: expect.objectContaining({
        workspaceId: "workspace-123",
        channelId: "channel-123",
      }),
    }));
  });

  it("defaults companies without a settings row to disabled awaiting-human delivery", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

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
