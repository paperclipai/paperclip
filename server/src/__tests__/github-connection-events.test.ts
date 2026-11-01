import { startToolHealthWorker } from "./helpers/tool-health-worker.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyPendingMigrations,
  activityLog,
  companies,
  connectionEventDeliveries,
  connectionGrants,
  createDb,
  externalObjects,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { githubConnectionEventService } from "../services/github-connection-events.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { logger } from "../middleware/logger.js";
import type { PaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_GITHUB_EVENTS_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("GitHub connection event delivery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalTestDatabaseUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-events-");
    if (externalTestDatabaseUrl) await applyPendingMigrations(externalTestDatabaseUrl);
    db = createDb(externalTestDatabaseUrl ?? tempDb!.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(connectionEventDeliveries);
    await db.delete(externalObjects);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  it.each([false, true])("applies a normalized merged PR once while retaining undecryptable siblings for retry (active setup=%s)", async activeSetup => {
    const companyId = randomUUID();
    const userId = `github-owner-${randomUUID()}`;
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const grantId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "GHE" });
    await db.insert(toolApplications).values({
      id: applicationId,
      companyId,
      applicationKey: `github-${randomUUID()}`,
      name: "GitHub",
      type: "mcp_server",
      status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      name: "GitHub",
      uid: `github-${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "per_user",
      status: "active",
      enabled: true,
      config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } },
      transportConfig: {},
    });
    await db.insert(connectionGrants).values({
      id: grantId,
      companyId,
      connectionId,
      kind: "user",
      subjectUserId: userId,
      status: "active",
      isDefault: false,
      providerTenant: {
        oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: null },
        github: {
          userId: "42",
          login: "octocat",
          installationCount: 1,
          repositoryCount: 3,
          repositorySelection: "selected",
          installationIds: ["101"],
          installationOwnerLogins: ["paperclipai"],
          repositories: [{ id: "203", fullName: "paperclipai/removed", installationId: "101" }],
          webhookHealth: "pending",
        },
      },
    });
    const externalObjectId = randomUUID();
    await db.insert(externalObjects).values({
      id: externalObjectId,
      companyId,
      providerKey: "github",
      objectType: "pull_request",
      externalId: "paperclipai/paperclip#pull/123",
      statusCategory: "open",
      statusTone: "info",
      data: { provider: "github", marker: "preserved" },
    });

    const leasedEvent = {
      id: "delivery_merged_123",
      provider: "github" as const,
      event: "pull_request",
      action: "closed",
      installationId: "101",
      repositoryId: "99",
      createdAt: "2026-09-04T12:00:00.000Z",
      bindingIds: [`${grantId}_101`],
      payload: {
        repository: "paperclipai/paperclip",
        number: 123,
        state: "closed",
        merged: true,
        mergedAt: "2026-09-04T11:59:00.000Z",
        updatedAt: "2026-09-04T11:59:01.000Z",
        url: "https://github.com/paperclipai/paperclip/pull/123",
        headRef: "feature",
        headSha: "a".repeat(40),
        baseRef: "master",
        baseSha: "b".repeat(40),
        body: "private pull request body",
        comments: [{ body: "private review comment" }],
        accessToken: "ghu_must_not_be_persisted",
        arbitraryNested: { credential: "also-must-not-be-persisted" },
      },
    };
    let poll = 0;
    const connector = {
      getCapabilities: vi.fn(async () => ["github.code" as const]),
      startAuthorization: vi.fn(),
      claim: vi.fn(),
      refresh: vi.fn(),
      revoke: vi.fn(),
      setWebhookBinding: vi.fn(async () => undefined),
      leaseEvents: vi.fn(async () => ({ leaseId: `lease-${++poll}`, events: [leasedEvent], failedEventIds: ["undecryptable-delivery"] })),
      acknowledgeEvents: vi.fn(async () => 1),
    } as unknown as PaperclipCloudConnector;
    let currentTime = new Date("2026-09-04T12:00:05.000Z");
    const service = githubConnectionEventService(db, { connector, now: () => currentTime });

    if (activeSetup) {
      // An existing personal connection can leave a long empty-queue backoff
      // before a new dedicated App starts its signed-ping verification.
      for (const delay of [0, 10_000, 20_000, 40_000, 80_000]) {
        currentTime = new Date(currentTime.getTime() + delay);
        vi.mocked(connector.leaseEvents).mockResolvedValueOnce(null);
        await service.pollOnce();
      }
      currentTime = new Date(currentTime.getTime() + 5_000);
      await expect(service.pollOnce()).resolves.toMatchObject({ leased: 0 });
      expect(connector.leaseEvents).toHaveBeenCalledTimes(5);
    }

    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await expect(service.pollOnce({ forSetup: activeSetup })).resolves.toMatchObject({ leased: 2, processed: 1, duplicate: 0, failed: 1 });
    expect(warning.mock.calls).toEqual([[{
      deliveryId: "undecryptable-delivery", reason: "inner_event_authentication_failed",
    }, "GitHub connector event retained for retry"]]);
    warning.mockRestore();
    const [snapshot] = await db.select().from(externalObjects).where(eq(externalObjects.id, externalObjectId));
    expect(snapshot).toMatchObject({
      statusKey: "merged",
      statusLabel: "Merged",
      statusCategory: "succeeded",
      statusTone: "success",
      isTerminal: true,
      remoteVersion: "2026-09-04T11:59:01.000Z",
      data: expect.objectContaining({ marker: "preserved", merged: true, headRef: "feature", baseSha: "b".repeat(40) }),
    });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
    expect(grant?.providerTenant?.github).toMatchObject({ webhookHealth: "healthy", lastWebhookAt: currentTime.toISOString() });
    const [receipt] = await db.select().from(connectionEventDeliveries).where(eq(
      connectionEventDeliveries.providerDeliveryId,
      leasedEvent.id,
    ));
    expect(receipt).toMatchObject({
      status: "processed",
      attempts: 1,
      provider: "github",
      normalizedPayload: {
        repository: "paperclipai/paperclip",
        number: 123,
        state: "closed",
        merged: true,
        mergedAt: "2026-09-04T11:59:00.000Z",
        updatedAt: "2026-09-04T11:59:01.000Z",
        url: "https://github.com/paperclipai/paperclip/pull/123",
        headRef: "feature",
        headSha: "a".repeat(40),
        baseRef: "master",
        baseSha: "b".repeat(40),
      },
    });
    expect(JSON.stringify(receipt)).not.toMatch(/private pull request|private review|ghu_|also-must-not/);
    const [activity] = await db.select().from(activityLog).where(eq(activityLog.action, "tool_connection.webhook_processed"));
    expect(activity?.details).toEqual({
      provider: "github",
      event: "pull_request",
      action: "closed",
      deliveryId: leasedEvent.id,
      installationId: "101",
      repositoryId: "99",
    });
    expect(connector.acknowledgeEvents).toHaveBeenCalledTimes(1);
    expect(connector.acknowledgeEvents).toHaveBeenLastCalledWith(expect.objectContaining({
      deliveryIds: [leasedEvent.id],
    }));
    expect(await db.select().from(connectionEventDeliveries).where(eq(
      connectionEventDeliveries.providerDeliveryId, "undecryptable-delivery",
    ))).toEqual([]);

    currentTime = new Date(currentTime.getTime() + 6_000);
    await expect(service.pollOnce()).resolves.toMatchObject({ leased: 2, processed: 0, duplicate: 1, failed: 1 });
    const [duplicateReceipt] = await db.select().from(connectionEventDeliveries).where(eq(
      connectionEventDeliveries.providerDeliveryId,
      leasedEvent.id,
    ));
    expect(duplicateReceipt?.attempts).toBe(1);
    expect(connector.acknowledgeEvents).toHaveBeenCalledTimes(2);
    vi.mocked(connector.leaseEvents).mockResolvedValue({
      leaseId: "failed-only", events: [], failedEventIds: ["undecryptable-delivery"],
    });
    currentTime = new Date(currentTime.getTime() + 6_000);
    await expect(service.pollOnce()).resolves.toMatchObject({ leased: 1, processed: 0, failed: 1 });
    expect(connector.acknowledgeEvents).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("applies installation events once without discarding newer verified access (refreshed: %s)", async (refreshed) => {
    const companyId = randomUUID();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const grantId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "GHI" });
    await db.insert(toolApplications).values({
      id: applicationId,
      companyId,
      applicationKey: `github-${randomUUID()}`,
      name: "GitHub",
      type: "mcp_server",
      status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      name: "GitHub",
      uid: `github-${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "per_user",
      status: "active",
      enabled: true,
      healthCheckedAt: new Date("2026-09-04T11:59:05.000Z"),
      config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } },
      transportConfig: {},
    });
    await db.insert(connectionGrants).values({
      id: grantId,
      companyId,
      connectionId,
      kind: "user",
      subjectUserId: `github-owner-${randomUUID()}`,
      status: "active",
      isDefault: false,
      providerTenant: {
        oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: null },
        github: {
          userId: "42",
          login: "octocat",
          installationCount: 1,
          repositoryCount: 3,
          repositorySelection: "selected",
          installationIds: ["101"],
          installationOwnerLogins: ["paperclipai"],
          repositories: [{ id: "203", fullName: "paperclipai/removed", installationId: "101" }],
          webhookHealth: "pending",
        },
      },
    });

    const leasedEvent = {
      id: "delivery_repository_change_101",
      provider: "github" as const,
      event: "installation_repositories",
      action: "added",
      installationId: "101",
      repositoryId: null,
      createdAt: "2026-09-04T12:00:00.000Z",
      bindingIds: [`${grantId}_101`],
      payload: {
        repositorySelection: "selected",
        repositoriesAdded: ["201", "202"],
        repositoriesRemoved: ["203"],
      },
    };
    let poll = 0;
    const connector = {
      getCapabilities: vi.fn(async () => ["github.code" as const]),
      startAuthorization: vi.fn(),
      claim: vi.fn(),
      refresh: vi.fn(),
      revoke: vi.fn(),
      setWebhookBinding: vi.fn(async () => undefined),
      leaseEvents: vi.fn(async () => {
        if (refreshed) {
          const [latest] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
          await db.update(connectionGrants).set({ providerTenant: {
            ...latest!.providerTenant,
            github: { ...latest!.providerTenant!.github!, lastAccessRefreshAt: "2026-09-04T12:00:02.000Z" },
          } }).where(eq(connectionGrants.id, grantId));
        }
        return ({ leaseId: `lease-${++poll}`, events: [leasedEvent] });
      }),
      acknowledgeEvents: vi.fn(async () => 1),
    } as unknown as PaperclipCloudConnector;
    let currentTime = new Date("2026-09-04T12:00:05.000Z");
    const service = githubConnectionEventService(db, { connector, now: () => currentTime });

    const health = await startToolHealthWorker(db, companyId, currentTime);
    try {
      await health.expectDeadline(new Date("2026-09-04T12:14:05.000Z").getTime());
      const unsubscribe = subscribeCompanyLiveEvents(companyId, () => {
        throw new Error("fixture live subscriber failed");
      });
      try {
        await expect(service.pollOnce()).resolves.toMatchObject({ processed: 1, duplicate: 0, failed: 0 });
      } finally { unsubscribe(); }
      await health.expectDeadline(currentTime.getTime() + 900_000 - (refreshed ? 60_000 : 0));
      await health.expectQuiet();
    } finally { await health.stop(); }
    let [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
    expect(grant?.providerTenant?.github).toMatchObject({ repositoryCount: refreshed ? 3 : 4, webhookHealth: "healthy" });
    if (refreshed) {
      expect(grant?.providerTenant?.github?.repositories).toHaveLength(1);
    } else {
      expect(grant?.providerTenant?.github?.repositories).toBeUndefined();
    }

    currentTime = new Date(currentTime.getTime() + 6_000);
    await expect(service.pollOnce()).resolves.toMatchObject({ processed: 0, duplicate: 1, failed: 0 });
    [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
    expect(grant?.providerTenant?.github?.repositoryCount).toBe(refreshed ? 3 : 4);
    const [receipt] = await db.select().from(connectionEventDeliveries).where(eq(
      connectionEventDeliveries.providerDeliveryId,
      leasedEvent.id,
    ));
    expect(receipt).toMatchObject({ status: "processed", attempts: 1 });
  });
});
