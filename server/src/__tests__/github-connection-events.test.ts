import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  connectionEventDeliveries,
  connectionGrants,
  createDb,
  externalObjects,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { githubConnectionEventService } from "../services/github-connection-events.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import type { PaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres.sequential("GitHub connection event delivery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-events-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

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
    await tempDb?.cleanup();
  });

  it("applies a normalized merged PR once, updates the snapshot, and acknowledges Cloud", async () => {
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
      leaseEvents: vi.fn(async () => ({ leaseId: `lease-${++poll}`, events: [leasedEvent] })),
      acknowledgeEvents: vi.fn(async () => 1),
    } as unknown as PaperclipCloudConnector;
    let currentTime = new Date("2026-09-04T12:00:05.000Z");
    const service = githubConnectionEventService(db, { connector, now: () => currentTime });

    await expect(service.pollOnce()).resolves.toMatchObject({ leased: 1, processed: 1, duplicate: 0, failed: 0 });
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

    currentTime = new Date(currentTime.getTime() + 6_000);
    await expect(service.pollOnce()).resolves.toMatchObject({ leased: 1, processed: 0, duplicate: 1, failed: 0 });
    const [duplicateReceipt] = await db.select().from(connectionEventDeliveries).where(eq(
      connectionEventDeliveries.providerDeliveryId,
      leasedEvent.id,
    ));
    expect(duplicateReceipt?.attempts).toBe(1);
    expect(connector.acknowledgeEvents).toHaveBeenCalledTimes(2);
  });

  it("applies installation repository deltas transactionally and never reapplies a processed delivery", async () => {
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
      leaseEvents: vi.fn(async () => ({ leaseId: `lease-${++poll}`, events: [leasedEvent] })),
      acknowledgeEvents: vi.fn(async () => 1),
    } as unknown as PaperclipCloudConnector;
    let currentTime = new Date("2026-09-04T12:00:05.000Z");
    const service = githubConnectionEventService(db, { connector, now: () => currentTime });

    const unsubscribe = subscribeCompanyLiveEvents(companyId, () => {
      throw new Error("fixture live subscriber failed");
    });
    await expect(service.pollOnce()).resolves.toMatchObject({ processed: 1, duplicate: 0, failed: 0 });
    unsubscribe();
    let [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
    expect(grant?.providerTenant?.github).toMatchObject({ repositoryCount: 4, webhookHealth: "healthy" });

    currentTime = new Date(currentTime.getTime() + 6_000);
    await expect(service.pollOnce()).resolves.toMatchObject({ processed: 0, duplicate: 1, failed: 0 });
    [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
    expect(grant?.providerTenant?.github?.repositoryCount).toBe(4);
    const [receipt] = await db.select().from(connectionEventDeliveries).where(eq(
      connectionEventDeliveries.providerDeliveryId,
      leasedEvent.id,
    ));
    expect(receipt).toMatchObject({ status: "processed", attempts: 1 });
  });
});
