import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  channelMessages,
  channelRoutes,
  channels,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  channelService,
  isSensitiveConfigKey,
  redactChannelConfig,
} from "../services/channels.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres channels service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("channels redaction", () => {
  it("flags well-known sensitive keys", () => {
    for (const key of [
      "apiKey",
      "api_key",
      "accessToken",
      "auth_token",
      "authorization",
      "bearer",
      "secret",
      "password",
      "passwd",
      "credential",
      "jwt",
      "privateKey",
      "cookie",
      "connectionString",
      "signingSecret",
      "webhookUrl",
      "botToken",
    ]) {
      expect(isSensitiveConfigKey(key)).toBe(true);
    }
    expect(isSensitiveConfigKey("channelName")).toBe(false);
    expect(isSensitiveConfigKey("displayName")).toBe(false);
  });

  it("redacts sensitive keys recursively, preserves shape, leaves empty values alone", () => {
    const result = redactChannelConfig({
      botToken: "xoxb-secret",
      signingSecret: "shhh",
      displayName: "Engineering",
      nested: {
        accessToken: "tok-1",
        public: "ok",
      },
      arr: [{ apiKey: "k1" }, { name: "n" }],
      emptyToken: "",
      nullToken: null,
    });
    expect(result).toEqual({
      botToken: "***REDACTED***",
      signingSecret: "***REDACTED***",
      displayName: "Engineering",
      nested: {
        accessToken: "***REDACTED***",
        public: "ok",
      },
      arr: [{ apiKey: "***REDACTED***" }, { name: "n" }],
      emptyToken: "",
      nullToken: null,
    });
  });
});

describeEmbeddedPostgres("channelService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-channels-service-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(channelMessages);
    await db.delete(channelRoutes);
    await db.delete(channels);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Acme") {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("creates a channel and redacts secrets in GET responses", async () => {
    const companyId = await seedCompany();
    const svc = channelService(db);

    const created = await svc.createChannel(companyId, {
      platform: "slack",
      name: "eng-alerts",
      config: { botToken: "xoxb-PLAINTEXT", workspace: "acme" },
      status: "active",
      direction: "outbound",
    });

    expect(created.config).toEqual({
      botToken: "***REDACTED***",
      workspace: "acme",
    });

    const fetched = await svc.getChannel(created.id);
    expect(fetched?.config).toEqual({
      botToken: "***REDACTED***",
      workspace: "acme",
    });

    const list = await svc.listChannels(companyId);
    expect(list).toHaveLength(1);
    expect(list[0].config).toEqual({
      botToken: "***REDACTED***",
      workspace: "acme",
    });

    const withSecrets = await svc.getChannelWithSecrets(created.id);
    expect(withSecrets?.config).toEqual({
      botToken: "xoxb-PLAINTEXT",
      workspace: "acme",
    });
  });

  it("scopes update + delete by companyId so company A cannot mutate company B's channel", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = channelService(db);

    const created = await svc.createChannel(companyA, {
      platform: "slack",
      name: "a-chan",
      config: {},
    });

    await expect(
      svc.updateChannel(companyB, created.id, { name: "hijacked" }),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      svc.deleteChannel(companyB, created.id),
    ).rejects.toMatchObject({ status: 404 });

    const stillThere = await svc.getChannel(created.id);
    expect(stillThere?.name).toBe("a-chan");
  });

  it("rejects createRoute that targets a channel from another company", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = channelService(db);

    const channelA = await svc.createChannel(companyA, {
      platform: "slack",
      name: "a-chan",
      config: {},
    });

    await expect(
      svc.createRoute(companyB, {
        channelId: channelA.id,
        trigger: "issue.created",
        filter: null,
        template: null,
        enabled: true,
      }),
    ).rejects.toMatchObject({ status: 404 });

    const routesForB = await svc.listRoutes(companyB);
    expect(routesForB).toHaveLength(0);
  });

  it("rejects empty updateChannel body at service layer", async () => {
    const companyId = await seedCompany();
    const svc = channelService(db);
    const created = await svc.createChannel(companyId, {
      platform: "slack",
      name: "x",
      config: {},
    });

    await expect(
      svc.updateChannel(companyId, created.id, {} as never),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("filters messages by channelId, direction, status", async () => {
    const companyId = await seedCompany();
    const svc = channelService(db);
    const channel = await svc.createChannel(companyId, {
      platform: "slack",
      name: "x",
      config: {},
    });
    const other = await svc.createChannel(companyId, {
      platform: "discord",
      name: "y",
      config: {},
    });

    await db.insert(channelMessages).values([
      {
        companyId,
        channelId: channel.id,
        direction: "outbound",
        content: "hello",
        status: "delivered",
      },
      {
        companyId,
        channelId: channel.id,
        direction: "inbound",
        content: "world",
        status: "received",
      },
      {
        companyId,
        channelId: other.id,
        direction: "outbound",
        content: "elsewhere",
        status: "pending",
      },
    ]);

    const onlyChannel = await svc.listMessages(companyId, {
      channelId: channel.id,
      limit: 50,
      offset: 0,
    });
    expect(onlyChannel).toHaveLength(2);

    const inbound = await svc.listMessages(companyId, {
      channelId: channel.id,
      direction: "inbound",
      limit: 50,
      offset: 0,
    });
    expect(inbound).toHaveLength(1);
    expect(inbound[0].content).toBe("world");

    const delivered = await svc.listMessages(companyId, {
      status: "delivered",
      limit: 50,
      offset: 0,
    });
    expect(delivered).toHaveLength(1);
  });
});
