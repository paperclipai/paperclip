import { chatHistoryActionBlocks } from "../helpers/chat-history-proof.js";
import { subscribeDatabaseWork } from "@paperclipai/db";
import * as activityLogModule from "../../services/activity-log.js";
import { chatSlackManagerGrants, chatSlackRegistrations, toolOauthStates } from "@paperclipai/db";
import type { PaperclipCloudConnector, SealedConnectorCredentials } from "../../services/paperclip-cloud-connector.js";
import { buildSlackAppManifest, SLACK_MANAGER_SCOPES } from "@paperclipai/shared";
import { registerChatActionWork } from "../../services/chat-action-work.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../../services/delivery-work-notifications.js";
import { toolAccessService } from "../../services/tool-access.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";
import request from "supertest";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { agents, activityLog, authUsers, chatActions, chatEndpointLeases, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, joinRequests, companySecrets, companies, companyMemberships, createDb, principalPermissionGrants } from "@paperclipai/db";
import { chatChannelService, type ChatChannelServiceOptions } from "../../services/chat-channels.js";
import type { ChatSdkRuntime } from "../../services/chat-sdk-runtime.js";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { instanceSettingsService } from "../../services/instance-settings.js";
import { logActivity } from "../../services/activity-log.js";
import * as activityLogService from "../../services/activity-log.js";
import { logger as chatAttachmentLogger } from "../../middleware/logger.js";
import { type TestDb, externalTestDatabaseUrl, describeEmbeddedPostgres, FakeChatSdkRuntime, fakeSlackFetch, makeThread, makeMessage, routesApp } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";

describeEmbeddedPostgres("chat channels: slack setup and registration", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const { fixtureServices, retireFixtureState, seedCompany, readChatEndpointsById, readToolConnectionsById, createService, signedSlackWebhookRequest, configuredSlackEndpoint, deliverMessage } = h;

  it("retires a stale verifying receipt before another fixture runs recovery", async () => {
    const fixture = await seedCompany();
    const context = await configuredSlackEndpoint(fixture);
    const thread = makeThread({ channelId: "C-FIXTURE-RETIREMENT", id: "slack:C-FIXTURE-RETIREMENT:7001.1" });
    await deliverMessage({
      callbacks: context.callbacks,
      endpointId: context.endpoint.id,
      thread: thread.thread,
      message: makeMessage({ id: "7001.1", text: "@maya check fixture recovery", mentioned: true }),
      trigger: "mention",
    });
    await context.service.shutdown();
    const [receipt] = await db.select().from(chatActions).where(and(
      eq(chatActions.endpointId, context.endpoint.id),
      eq(chatActions.kind, "receipt_reaction"),
    ));
    expect(receipt).toBeDefined();
    await db.update(chatActions).set({ status: "processing", updatedAt: new Date(Date.now() - 61_000) })
      .where(eq(chatActions.id, receipt!.id));
    await db.insert(chatEndpointLeases).values({
      companyId: fixture.companyId,
      endpointId: context.endpoint.id,
      leaseKey: "credentials",
      token: "retired-fixture-owner",
      expiresAt: new Date(Date.now() + 90_000),
    });

    const other = await seedCompany();
    const next = createService();
    const otherEndpoint = await next.service.create(other.companyId, {
      provider: "slack", assignedAgentId: other.assignedAgentId,
    }, "owner-user");
    const [otherLease] = await db.insert(chatEndpointLeases).values({
      companyId: other.companyId,
      endpointId: otherEndpoint.id,
      leaseKey: "credentials",
      token: "other-fixture-owner",
      expiresAt: new Date(Date.now() + 90_000),
    }).returning();
    let recovery: Promise<number> | undefined;
    try {
      await retireFixtureState([fixture.companyId]);
      recovery = next.service.processPendingDeliveries();
      await expect.poll(async () => db.select({ status: chatActions.status }).from(chatActions)
        .where(eq(chatActions.id, receipt!.id)), { timeout: 5_000 })
        .toEqual([{ status: "cancelled" }]);
      await recovery;
      expect(next.runtime.endpoints.size).toBe(0);
      expect(await db.select().from(chatEndpointLeases).where(eq(chatEndpointLeases.id, otherLease!.id)))
        .toEqual([otherLease]);
    } finally {
      // Release synthetic owners even when a regression blocks recovery.
      await db.delete(chatEndpointLeases).where(inArray(chatEndpointLeases.companyId, [fixture.companyId, other.companyId]));
      await recovery;
      await next.service.shutdown();
    }
  });

  it("creates a channel-purpose connection and rejects attempts to change its assigned agent", async () => {
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
    const fixture = await seedCompany();
    const { service } = createService();
    const app = routesApp(db, fixture.companyId, service);

    const createResponse = await request(app)
      .post(`/api/companies/${fixture.companyId}/chat-endpoints`)
      .send({ provider: "slack", assignedAgentId: fixture.assignedAgentId })
      .expect(201);

    expect(createResponse.body).toMatchObject({
      provider: "slack",
      assignedAgentId: fixture.assignedAgentId,
      assignedAgentName: "Maya",
      status: "draft",
      allowUnlinkedPeople: false,
      setup: { command: "/maya", slackApp: { appName: "maya-paperclip", botName: "maya", command: "/maya" } },
    });
    const createdCommand = createResponse.body.setup.command as string;
    const [connection] = await readToolConnectionsById(createResponse.body.connectionId);
    expect(connection).toMatchObject({
      connectionPurpose: "channel",
      transport: "chat_sdk",
    });

    await request(app)
      .patch(`/api/chat-endpoints/${createResponse.body.id}`)
      .send({ assignedAgentId: fixture.replacementAgentId })
      .expect(400);
    const [stored] = await db
      .select({
        assignedAgentId: chatEndpoints.assignedAgentId,
        setup: chatEndpoints.setup,
      })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, createResponse.body.id));
    expect(stored.assignedAgentId).toBe(fixture.assignedAgentId);
    expect(stored.setup.command).toBe(createdCommand);

    await db
      .update(agents)
      .set({ name: "Maya Renamed" })
      .where(eq(agents.id, fixture.assignedAgentId));
    expect((await service.get(createResponse.body.id)).setup.command).toBe(
      createdCommand,
    );
  });

  describe("automatic Slack registration", () => {
    const actor = { userId: "owner-user", sessionId: null, bypassPermissionCheck: false };
    const appDetails = { appName: "Maya Test", botName: "maya-test", command: "/maya" };
    const configToken = "configuration-token-canary";
    const signingSecret = "signing-secret-canary";
    const clientSecret = "client-secret-canary";
    it("saves advanced app details with the initial draft and rejects them for other providers", async () => {
      await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
      const company = await seedCompany();
      const { service } = createService();
      const app = routesApp(db, company.companyId, service);
      const slackApp = { appName: "Research Ops", botName: "research-ops", command: "/research" };
      const response = await request(app).post(`/api/companies/${company.companyId}/chat-endpoints`)
        .send({ provider: "slack", assignedAgentId: company.assignedAgentId, slackApp }).expect(201);
      expect(response.body.setup).toMatchObject({ slackApp, command: "/research", slackSetupMethod: "automatic" });
      expect((await service.get(response.body.id)).setup.slackApp).toEqual(slackApp);
      await request(app).post(`/api/companies/${company.companyId}/chat-endpoints`)
        .send({ provider: "discord", assignedAgentId: company.assignedAgentId, slackApp }).expect(400);
    });
    async function fixture(overrides: Partial<ChatChannelServiceOptions> = {}) {
      await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
      const company = await seedCompany();
      const id = randomUUID().replaceAll("-", "").toUpperCase();
      const botId = `U${id}`;
      const installerId = `UINSTALLER${id}`;
      const appId = `A${id}`;
      const token = `xoxb-bot-token-canary-${id}`;
      const scopes = buildSlackAppManifest({ app: appDetails, agentName: "Maya", webhookUrl: "https://paperclip.example/hook" }).oauth_config.scopes.bot;
      const state = {
        managedAccessToken: token, rejectOldBotToken: false,
        userListCursor: null as string | null, userListNextCursor: "",
        managedBotAppId: appId, grantedScopes: scopes, managedError: null as string | null, failCreate: false, failValidate: false, failInventory: false, failAuth: false, failExchange: false,
        failManifestUpdate: false, timeoutManifestUpdate: false,
        beforeManifestUpdate: null as null | (() => Promise<void>),
        failIcon: false, timeoutIcon: false, failUser: false, failWelcome: false, timeoutWelcome: false,
        beforeUser: null as null | (() => Promise<void>),
        user: { id: installerId, team_id: "TAUTO", name: "installer", real_name: "Installing Person", is_bot: false, deleted: false },
        beforeIcon: null as null | (() => Promise<void>),
        beforeAuth: null as null | (() => Promise<void>),
        beforeExchange: null as null | (() => Promise<void>),
        oauth: { ok: true, app_id: appId, token_type: "bot", access_token: token, team: { id: "TAUTO" }, bot_user_id: botId, authed_user: { id: installerId }, scope: scopes.join(",") },
      };
      const fallback = fakeSlackFetch(botId);
      const provider = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("bots.info")) return Response.json({ ok: true, bot: { id: "BMANAGED", app_id: state.managedBotAppId, user_id: botId, deleted: false } });
        if (url.endsWith("apps.managedInstall")) return Response.json(state.managedError ? { ok: false, error: state.managedError } : { ok: true, app_id: appId, team_id: "TAUTO", api_access_tokens: { bot_access_token: state.managedAccessToken } });
        if (url.endsWith("apps.manifest.validate")) return Response.json(state.failValidate ? { ok: false, error: "invalid_auth", detail: configToken } : { ok: true });
        if (url.endsWith("apps.manifest.create")) {
          if (state.failCreate) throw new Error(`Timeout ${configToken} ${clientSecret}`);
          return Response.json({ ok: true, app_id: appId, team_id: "TAUTO", credentials: { client_id: "123.456", client_secret: clientSecret, signing_secret: signingSecret } });
        }
        if (url.endsWith("apps.manifest.update")) {
          await state.beforeManifestUpdate?.();
          if (state.timeoutManifestUpdate) throw new Error(`Manifest timeout ${configToken} ${clientSecret}`);
          return Response.json(state.failManifestUpdate ? { ok: false, error: "invalid_auth", detail: configToken } : { ok: true, app_id: appId, permissions_updated: true });
        }
        if (url.endsWith("apps.icon.set")) {
          await state.beforeIcon?.();
          if (state.timeoutIcon) throw new Error(`Icon timeout ${configToken} ${clientSecret}`);
          return Response.json(state.failIcon ? { ok: false, error: "missing_scope", detail: `${configToken} ${signingSecret}` } : { ok: true });
        }
        if (url.endsWith("oauth.v2.access")) {
          await state.beforeExchange?.();
          if (state.failExchange) throw new Error(`Timeout ${clientSecret} ${token}`);
          return Response.json(state.oauth);
        }
        if (url.endsWith("auth.test")) {
          await state.beforeAuth?.();
          if (state.rejectOldBotToken && new Headers(init?.headers).get("authorization") !== `Bearer ${state.managedAccessToken}`) return Response.json({ ok: false, error: "token_revoked" });
          if (state.failAuth) throw new Error(`Temporary failure ${token}`);
          return Response.json({ ok: true, team_id: "TAUTO", user_id: botId, bot_id: "BMANAGED", user: `maya-${id}`, team: "Test workspace" }, { headers: { "x-oauth-scopes": state.grantedScopes.join(",") } });
        }
        if (url.endsWith("users.list")) {
          state.userListCursor = new URLSearchParams(String(init?.body)).get("cursor");
          return Response.json({ ok: true, members: [state.user], response_metadata: { next_cursor: state.userListNextCursor } });
        }
        if (url.endsWith("users.info")) {
          await state.beforeUser?.();
          if (state.failUser) throw new Error(`User lookup failed ${token}`);
          return Response.json({ ok: true, user: state.user });
        }
        if (url.endsWith("chat.postMessage")) {
          if (state.timeoutWelcome) throw new Error(`DM timeout ${token} ${clientSecret}`);
          return Response.json(state.failWelcome ? { ok: false, error: "not_allowed", detail: token } : { ok: true, channel: "DWELCOME", ts: "1.000001" });
        }
        if (url.includes("conversations.list") && state.failInventory) throw new Error(`Inventory failed ${token}`);
        return fallback(input, init);
      });
      const sdk = new FakeChatSdkRuntime();
      const avatarBytes = Buffer.from("synthetic-png-bytes");
      const renderAvatar = vi.fn(async () => avatarBytes);
      const { service } = createService(sdk, provider, { renderSlackAvatar: renderAvatar, ...overrides });
      const endpoint = await service.create(company.companyId, { provider: "slack", assignedAgentId: company.assignedAgentId }, actor.userId);
      await service.update(endpoint.id, { slackApp: appDetails }, actor.userId);
      const app = routesApp(db, company.companyId, service);
      const createInput = { requestId: randomUUID(), credentials: { configurationToken: configToken } };
      const create = (input = createInput) => service.slackRegistration.create(endpoint.id, actor, input);
      const install = async () => new URL((await service.slackRegistration.install(endpoint.id, actor)).authorizationUrl).searchParams.get("state")!;
      return { ...company, endpoint, service, sdk, app, state, provider, create, install, createInput, token, appId, botId, installerId, avatarBytes, renderAvatar };
    }
    async function managedFixture() {
      const broker = {
        getCapabilities: vi.fn(async () => ["slack.manager"]),
        getSlackManagerAppId: vi.fn(async (): Promise<string | null> => "AMANAGER"),
        startAuthorization: vi.fn(async (_input: { returnState: string }) => ({ authorizationUrl: "https://slack.com/oauth/v2/authorize?state=broker", expiresAt: new Date(Date.now() + 600_000).toISOString() })),
        claim: vi.fn(), refresh: vi.fn(), revoke: vi.fn(async () => undefined),
      };
      const f = await fixture({ slackManaged: { enabled: true, broker: broker as unknown as PaperclipCloudConnector } });
      const credentials: SealedConnectorCredentials = { v: 1, provider: "slack", profile: "slack.manager", instanceId: "test", environment: "staging", subject: actor.userId, companyId: f.companyId,
        accessToken: "xoxe.xoxp-manager-access-canary", refreshToken: "xoxe-manager-refresh-canary", tokenType: "user", accessTokenExpiresAt: new Date(Date.now() + 43_200_000).toISOString(), refreshTokenExpiresAt: null,
        scopes: [...SLACK_MANAGER_SCOPES], slackManager: { appId: "AMANAGER", workspaceId: "TAUTO", workspaceName: "Test workspace", userId: f.installerId } };
      broker.claim.mockResolvedValue(credentials);
      broker.refresh.mockResolvedValue({ ...credentials, accessToken: "xoxe.rotated-canary", refreshToken: "xoxe.rotated-refresh-canary" });
      await f.service.update(f.endpoint.id, { slackSetupMethod: "managed" }, actor.userId);
      const grants = f.service.slackRegistration.managerGrants;
      const authorize = async () => { await grants.authorize(f.endpoint.id, actor); return broker.startAuthorization.mock.calls.at(-1)![0].returnState; };
      const authorizeState = await authorize();
      await grants.complete(authorizeState, "claim-canary", null, actor);
      const choices = await grants.choices(f.companyId, actor);
      expect(choices.workspaces).toHaveLength(1);
      const grantId = choices.workspaces[0]!.grantId;
      const input = { requestId: randomUUID(), grantId };
      const provision = () => f.service.slackRegistration.managed.provision(f.endpoint.id, actor, input);
      return { ...f, broker, credentials, grants, authorize, authorizeState, grantId, input, provision };
    }
    describe("Slack test messages", () => {
      const posts = (f: Awaited<ReturnType<typeof managedFixture>>) => f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"));
      it("sends to the current linked user and reuses a durable result on duplicate requests", async () => {
        const f = await managedFixture(); await f.provision(); f.provider.mockClear();
        const input = { requestId: randomUUID() };
        const result = await request(f.app).post(`/api/chat-endpoints/${f.endpoint.id}/slack/test-message`).send(input).expect(200);
        expect(result.body).toEqual({ status: "sent", slackUrl: "https://app.slack.com/client/TAUTO/DWELCOME" });
        await f.service.sendSlackTestMessage(f.endpoint.id, actor, input);
        expect(posts(f)).toHaveLength(1);
        expect(new URLSearchParams(String(posts(f)[0]![1]!.body)).get("channel")).toBe(f.installerId);
      });
      it("signals milestone eligibility around the real Slack account link and stays quiet on reconfirmation", async () => {
        const f = await managedFixture(); await f.provision();
        await db.delete(chatIdentityLinks).where(eq(chatIdentityLinks.endpointId, f.endpoint.id));
        const events: string[] = [];
        const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatRunMilestones, (event, scopes) => {
          if ([...scopes ?? []].some(scope => JSON.parse(scope).companyId === f.companyId)) events.push(event);
        });
        let release!: () => void, acquired!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const locked = new Promise<void>(resolve => { acquired = resolve; });
        const lock = db.transaction(async tx => {
          await tx.execute(sql`lock table chat_identity_links in share mode`);
          acquired(); await gate;
        });
        await locked;
        const linking = f.service.sendSlackTestMessage(f.endpoint.id, actor, { requestId: randomUUID() });
        void linking.catch(() => undefined);
        try {
          try {
            await vi.waitFor(async () => {
              const [waiting] = await db.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity
                where datname = current_database() and state = 'active' and wait_event_type = 'Lock'
                  and query like 'insert into "chat_identity_links"%'`);
              expect(waiting.count).toBeGreaterThan(0);
            });
            expect(events).toEqual(["intent"]);
            expect(await db.select().from(chatIdentityLinks).where(eq(chatIdentityLinks.endpointId, f.endpoint.id))).toEqual([]);
          } finally { release(); await lock; await linking; }
          expect(events).toEqual(["intent", "settled"]);
          expect(await db.select().from(chatIdentityLinks).where(eq(chatIdentityLinks.endpointId, f.endpoint.id)))
            .toEqual([expect.objectContaining({ paperclipUserId: actor.userId, status: "linked" })]);
          events.length = 0;
          expect(await f.service.sendSlackTestMessage(f.endpoint.id, actor, { requestId: randomUUID() })).toMatchObject({ status: "sent" });
          expect(events).toEqual([]);
        } finally { unsubscribe(); }
      });
      it("settles a failed Slack account-link intent without committing identity or sending a test message", async () => {
        const f = await managedFixture(); await f.provision();
        await db.delete(chatIdentityLinks).where(eq(chatIdentityLinks.endpointId, f.endpoint.id));
        f.provider.mockClear();
        const events: string[] = [];
        const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatRunMilestones, (event, scopes) => {
          if ([...scopes ?? []].some(scope => JSON.parse(scope).companyId === f.companyId)) events.push(event);
        });
        await db.execute(sql`create function sleep_slack_link_failure() returns trigger language plpgsql as $$ begin raise exception 'link write unavailable'; end $$`);
        await db.execute(sql`create trigger sleep_slack_link_failure before insert on chat_identity_links for each row execute function sleep_slack_link_failure()`);
        try {
          await expect(f.service.sendSlackTestMessage(f.endpoint.id, actor, { requestId: randomUUID() })).rejects.toThrow();
          expect(events).toEqual(["intent", "settled"]);
          expect(await db.select().from(chatIdentityLinks).where(eq(chatIdentityLinks.endpointId, f.endpoint.id))).toEqual([]);
          expect(posts(f)).toHaveLength(0);
        } finally {
          unsubscribe();
          await db.execute(sql`drop trigger sleep_slack_link_failure on chat_identity_links`);
          await db.execute(sql`drop function sleep_slack_link_failure()`);
        }
      });
      it("requires a private Slack challenge for an unknown account before linking and sending the test", async () => {
        const f = await managedFixture(); await f.provision();
        await db.delete(chatIdentityLinks).where(eq(chatIdentityLinks.endpointId, f.endpoint.id));
        await db.update(chatSlackManagerGrants).set({ userId: "another-user" }).where(eq(chatSlackManagerGrants.id, f.grantId));
        f.provider.mockClear(); const input = { requestId: randomUUID() };
        expect(await f.service.sendSlackTestMessage(f.endpoint.id, actor, input)).toEqual({ status: "connection_required", accounts: [{ id: f.installerId, name: "Installing Person" }], nextCursor: null });
        expect(posts(f)).toHaveLength(0);
        const pending = await f.service.sendSlackTestMessage(f.endpoint.id, actor, { ...input, slackUserId: f.installerId });
        expect(pending.status).toBe("connection_pending");
        const links = await db.select().from(chatIdentityLinks).where(eq(chatIdentityLinks.endpointId, f.endpoint.id));
        expect(links).toEqual([expect.objectContaining({ status: "pending", paperclipUserId: null })]);
        const fields = new URLSearchParams(String(posts(f)[0]![1]!.body));
        expect(fields.get("text")).not.toContain("This is your test message");
        const blocks = JSON.parse(fields.get("blocks")!);
        const invitationUrl = /<([^|]+)\|/.exec(blocks[1].text.text)![1]!;
        const token = new URL(invitationUrl).searchParams.get("token")!;
        expect(JSON.stringify(pending)).not.toContain(token);
        expect(await f.service.sendSlackTestMessage(f.endpoint.id, actor, input)).toEqual(pending);
        expect(posts(f)).toHaveLength(1);
        await f.service.confirmIdentityLink(token, actor.userId);
        expect(await f.service.sendSlackTestMessage(f.endpoint.id, actor, input)).toMatchObject({ status: "sent" });
        expect(new URLSearchParams(String(posts(f).at(-1)![1]!.body)).get("text")).toContain("This is your test message");
      });
      it("loads another workspace page instead of truncating account discovery", async () => {
        const f = await managedFixture(); await f.provision();
        await db.delete(chatIdentityLinks).where(eq(chatIdentityLinks.endpointId, f.endpoint.id));
        await db.update(chatSlackManagerGrants).set({ userId: "another-user" }).where(eq(chatSlackManagerGrants.id, f.grantId));
        f.provider.mockClear(); f.state.userListNextCursor = "next-page";
        const input = { requestId: randomUUID() };
        expect(await f.service.sendSlackTestMessage(f.endpoint.id, actor, input)).toMatchObject({ status: "connection_required", nextCursor: "next-page" });
        f.state.userListNextCursor = "";
        expect(await f.service.sendSlackTestMessage(f.endpoint.id, actor, { ...input, accountCursor: "next-page" })).toMatchObject({ status: "connection_required", nextCursor: null });
        expect(f.state.userListCursor).toBe("next-page");
        expect(posts(f)).toHaveLength(0);
      });
      it("does not downgrade confirmed delivery when activity logging fails", async () => {
        const f = await managedFixture(); await f.provision(); f.provider.mockClear();
        const original = activityLogModule.logActivity;
        const audit = vi.spyOn(activityLogModule, "logActivity").mockImplementation(async (database, entry) => {
          if (entry.action === "chat_slack.test_message_sent") throw new Error("Synthetic activity failure");
          return original(database, entry);
        });
        onTestFinished(() => audit.mockRestore());
        const input = { requestId: randomUUID() };
        expect(await f.service.sendSlackTestMessage(f.endpoint.id, actor, input)).toMatchObject({ status: "sent" });
        expect(await f.service.sendSlackTestMessage(f.endpoint.id, actor, input)).toMatchObject({ status: "sent" });
        expect(posts(f)).toHaveLength(1);
      });
      it("does not restore revoked access or take another user's identity", async () => {
        const f = await managedFixture(); await f.provision(); f.provider.mockClear();
        await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.endpointId, f.endpoint.id));
        await expect(f.service.sendSlackTestMessage(f.endpoint.id, actor, { requestId: randomUUID() })).rejects.toThrow("existing link");
        await db.update(chatIdentityLinks).set({ status: "linked", paperclipUserId: "another-user" }).where(eq(chatIdentityLinks.endpointId, f.endpoint.id));
        await expect(f.service.sendSlackTestMessage(f.endpoint.id, actor, { requestId: randomUUID(), slackUserId: f.installerId })).rejects.toThrow("existing link");
        expect(posts(f)).toHaveLength(0);
      });
      it("rejects wrong-workspace users, disabled DMs, and membership revocation", async () => {
        const f = await managedFixture(); await f.provision(); f.provider.mockClear();
        f.state.user.team_id = "TOTHER";
        await expect(f.service.sendSlackTestMessage(f.endpoint.id, actor, { requestId: randomUUID() })).rejects.toThrow("personal Slack account");
        f.state.user.team_id = "TAUTO";
        await db.update(chatEndpoints).set({ allowDirectMessages: false }).where(eq(chatEndpoints.id, f.endpoint.id));
        await expect(f.service.sendSlackTestMessage(f.endpoint.id, actor, { requestId: randomUUID() })).rejects.toThrow("Enable direct messages");
        await db.update(chatEndpoints).set({ allowDirectMessages: true }).where(eq(chatEndpoints.id, f.endpoint.id));
        await db.update(companyMemberships).set({ status: "inactive" }).where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, actor.userId)));
        await expect(f.service.sendSlackTestMessage(f.endpoint.id, actor, { requestId: randomUUID() })).rejects.toThrow("active Paperclip account");
        expect(posts(f)).toHaveLength(0);
      });
      it("redacts provider failures and never retries an ambiguous send", async () => {
        const f = await managedFixture(); await f.provision(); f.provider.mockClear(); f.state.timeoutWelcome = true;
        const input = { requestId: randomUUID() };
        const result = await request(f.app).post(`/api/chat-endpoints/${f.endpoint.id}/slack/test-message`).send(input).expect(422);
        expect(JSON.stringify(result.body)).not.toContain("canary");
        await expect(f.service.sendSlackTestMessage(f.endpoint.id, actor, input)).rejects.toThrow("may already have been sent");
        expect(posts(f)).toHaveLength(1);
        const actions = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "slack_test_message")));
        expect(JSON.stringify(actions)).not.toContain("canary");
        expect(actions[0]!.status).toBe("uncertain");
      });
    });
    describe("managed Slack", () => {
      it("keeps open-source setup independent of the broker", async () => {
        const f = await fixture();
        expect(await f.service.slackRegistration.managerGrants.choices(f.companyId, actor)).toEqual({ managedAvailable: false, defaultMethod: "automatic", workspaces: [] });
        await f.create();
        expect((await f.service.get(f.endpoint.id)).setup.slackSetupMethod).toBe("automatic");
        await expect(f.service.update(f.endpoint.id, { slackSetupMethod: "managed" }, actor.userId)).rejects.toThrow();
      });
      it("keeps configured Cloud drafts managed when the broker profile disappears", async () => {
        const f = await managedFixture();
        f.broker.getSlackManagerAppId.mockResolvedValue(null);
        expect(f.grants.defaultMethod()).toBe("managed");
        expect(await f.grants.choices(f.companyId, actor)).toEqual({ managedAvailable: false, defaultMethod: "managed", workspaces: [] });
        const next = await f.service.create(f.companyId, { provider: "slack", assignedAgentId: f.assignedAgentId }, actor.userId);
        expect(next.setup.slackSetupMethod).toBe("managed");
        await expect(f.provision()).rejects.toThrow();
      });
      it("creates and installs once, uploads the avatar and links only the manager grant owner", async () => {
        const f = await managedFixture();
        await Promise.all([1, 2].map(() => request(f.app)
          .post(`/api/chat-endpoints/${f.endpoint.id}/slack/managed/provision`)
          .send(f.input).expect(200)));
        const saved = await f.service.get(f.endpoint.id);
        expect(saved.setup).toMatchObject({ slackSetupMethod: "managed", slackRegistration: { status: "configured", appId: f.appId }, slackAvatar: { status: "uploaded" }, slackAccount: { status: "linked", paperclipUserId: actor.userId, externalUserId: f.installerId } });
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.managedInstall"))).toHaveLength(1);
        const activities = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
        for (const secret of [f.credentials.accessToken, f.credentials.refreshToken!, f.token, clientSecret, signingSecret, "claim-canary"]) expect(JSON.stringify({ saved, activities, choices: await f.grants.choices(f.companyId, actor) })).not.toContain(secret);
        await expect(f.service.update(f.endpoint.id, { slackSetupMethod: "automatic" }, actor.userId)).rejects.toThrow();
      });
      it("rejects missing, malformed, foreign and other-user manager grants before provisioning", async () => {
        const f = await managedFixture();
        const foreign = await seedCompany();
        const grants = await db.insert(chatSlackManagerGrants).values([
          { companyId: foreign.companyId, userId: actor.userId, slackUserId: "UFOREIGN", workspaceId: "TFOREIGN", workspaceName: "Foreign", managerAppId: "AMANAGER" },
          { companyId: f.companyId, userId: "another-user", slackUserId: "UOTHER", workspaceId: "TOTHER", workspaceName: "Other", managerAppId: "AMANAGER" },
        ]).returning();
        f.provider.mockClear();
        for (const [grantId, status] of [[randomUUID(), 404], ["invalid", 400], [grants[0]!.id, 404], [grants[1]!.id, 403]] as const) {
          await request(f.app).post(`/api/chat-endpoints/${f.endpoint.id}/slack/managed/provision`)
            .send({ ...f.input, grantId }).expect(status);
        }
        expect(f.provider).not.toHaveBeenCalled();
        expect(await db.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id))).toEqual([]);
      });
      it("reuses the same personal workspace grant for another draft without another authorization", async () => {
        const f = await managedFixture();
        const draft = await f.service.create(f.companyId, { provider: "slack", assignedAgentId: f.assignedAgentId, slackSetupMethod: "managed" }, actor.userId);
        expect((await f.grants.choices(f.companyId, actor)).workspaces[0]!.grantId).toBe(f.grantId);
        const otherActor = { ...actor, userId: "another-user", bypassPermissionCheck: true };
        expect((await f.grants.choices(f.companyId, otherActor)).workspaces).toEqual([]);
        await expect(f.service.slackRegistration.managed.provision(draft.id, otherActor, { ...f.input, requestId: randomUUID() })).rejects.toThrow();
        expect(f.broker.startAuthorization).toHaveBeenCalledTimes(1);
      });
      it("installs a second bot using the same grant without new manager consent", async () => {
        const f = await managedFixture(); await f.provision();
        const secondBot = `${f.botId}SECOND`;
        const secondApp = `${f.appId}SECOND`;
        const scopes = buildSlackAppManifest({ app: appDetails, agentName: "Maya", webhookUrl: "https://paperclip.example/hook" }).oauth_config.scopes.bot;
        const provider: typeof fetch = async (input, init) => {
          const url = String(input);
          if (url.endsWith("apps.manifest.create")) return Response.json({ ok: true, app_id: secondApp, team_id: "TAUTO", credentials: { client_id: "222.333", client_secret: clientSecret, signing_secret: signingSecret } });
          if (url.endsWith("apps.managedInstall")) return Response.json({ ok: true, app_id: secondApp, team_id: "TAUTO", api_access_tokens: { bot_access_token: "xoxb-second-managed" } });
          if (url.endsWith("auth.test")) return Response.json({ ok: true, team_id: "TAUTO", user_id: secondBot, bot_id: "BSECOND", team: "Test workspace" }, { headers: { "x-oauth-scopes": scopes.join(",") } });
          if (url.endsWith("bots.info")) return Response.json({ ok: true, bot: { id: "BSECOND", app_id: secondApp, user_id: secondBot, deleted: false } });
          return f.provider(input, init);
        };
        const { service } = createService(new FakeChatSdkRuntime(), provider, { renderSlackAvatar: f.renderAvatar, slackManaged: { enabled: true, broker: f.broker as unknown as PaperclipCloudConnector } });
        const second = await service.create(f.companyId, { provider: "slack", assignedAgentId: f.assignedAgentId, slackSetupMethod: "managed", slackApp: appDetails }, actor.userId);
        await service.slackRegistration.managed.provision(second.id, actor, { grantId: f.grantId, requestId: randomUUID() });
        expect((await service.get(second.id)).setup.slackRegistration).toMatchObject({ status: "configured", appId: secondApp });
        expect(f.broker.startAuthorization).toHaveBeenCalledTimes(1);
        expect(f.broker.claim).toHaveBeenCalledTimes(1);
      });
      it("rejects missing tool scopes before activating a managed bot", async () => {
        const f = await managedFixture(); f.state.grantedScopes = [];
        await f.provision();
        const saved = await f.service.get(f.endpoint.id);
        expect(saved.providerAccountId).toBeNull();
        expect(saved.setup.slackRegistration).toMatchObject({ status: "credentials_saved", errorCode: "slack_install_scopes_missing" });
      });
      it.each(["revoked", "attention", "active"] as const)("reinstalls the configured app on an explicit %s reconnect", async status => {
        const f = await managedFixture(); await f.provision(); f.provider.mockClear();
        await db.update(chatEndpoints).set({ status }).where(eq(chatEndpoints.id, f.endpoint.id));
        f.state.managedAccessToken = `xoxb-reconnected-${f.botId}`; f.state.rejectOldBotToken = true;
        const reconnectInput = { ...f.input, requestId: randomUUID(), reconnect: true };
        await f.service.slackRegistration.managed.provision(f.endpoint.id, actor, reconnectInput);
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.managedInstall"))).toHaveLength(1);
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(0);
        expect((await f.service.get(f.endpoint.id)).status).not.toBe("revoked");
        expect((await f.service.get(f.endpoint.id)).setup.slackRegistration).toMatchObject({ status: "configured", appId: f.appId });
        const [reconnectReceipt] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "slack_managed_reconnect")));
        expect(reconnectReceipt).toMatchObject({ status: "processed", result: null });
        expect(await chatHistoryActionBlocks(db, reconnectReceipt.id)).toBe(false);
        await f.service.slackRegistration.managed.provision(f.endpoint.id, actor, reconnectInput);
        await f.provision();
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.managedInstall"))).toHaveLength(1);
      });
      it("preserves configured-app reconnect intent when managed installation fails", async () => {
        const f = await managedFixture(); await f.provision(); f.provider.mockClear();
        await db.update(chatEndpoints).set({ status: "revoked" }).where(eq(chatEndpoints.id, f.endpoint.id));
        f.state.managedError = "temporary_error";
        await f.provision();
        expect((await f.service.get(f.endpoint.id)).setup.slackRegistration).toMatchObject({ status: "install", appId: f.appId });
        f.state.managedError = null;
        await f.provision();
        expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.status).toBe("configured");
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(0);
      });
      it("reinstalls the saved app after missing bot scopes without creating another app", async () => {
        const f = await managedFixture(); const scopes = f.state.grantedScopes;
        f.state.grantedScopes = []; await f.provision();
        f.state.grantedScopes = scopes; await f.provision();
        expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.status).toBe("configured");
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.managedInstall"))).toHaveLength(2);
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
      });
      it("retains reinstall intent after a provider failure instead of retrying rejected credentials", async () => {
        const f = await managedFixture(); const scopes = f.state.grantedScopes;
        f.state.grantedScopes = []; await f.provision();
        f.state.managedError = "internal_error"; await f.provision();
        expect((await f.service.get(f.endpoint.id)).setup.slackRegistration).toMatchObject({ status: "install", errorCode: "slack_provider_failure" });
        f.state.managedError = null; f.state.grantedScopes = scopes; await f.provision();
        expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.status).toBe("configured");
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.managedInstall"))).toHaveLength(3);
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
      });
      it("clears a manager reconnect error after renewing the bound grant", async () => {
        const f = await managedFixture(); f.state.managedError = "invalid_auth"; await f.provision();
        expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.errorCode).toBe("slack_manager_reauthorize");
        await f.grants.complete(await f.authorize(), "new-claim", null, actor);
        expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.errorCode).toBeNull();
        f.state.managedError = null; await f.provision();
        expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.status).toBe("configured");
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
      });
      it("reconnects a rejected manager token without losing pending manifest configuration", async () => {
        const f = await managedFixture(); f.state.failManifestUpdate = true; await f.provision();
        expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.errorCode).toBe("slack_manifest_update_pending");
        expect((await f.grants.choices(f.companyId, actor)).workspaces).toEqual([]);
        expect((await f.grants.get(f.grantId, f.companyId, actor)).status).toBe("reauthorize");
        await f.grants.complete(await f.authorize(), "new-claim", null, actor);
        f.state.failManifestUpdate = false; await f.provision();
        expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.status).toBe("configured");
        expect((await f.service.get(f.endpoint.id)).setup.slackAvatar?.status).toBe("uploaded");
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.icon.set"))).toHaveLength(1);
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
      });
      it("does not restore a revoked grant when an in-flight refresh returns", async () => {
        const f = await managedFixture();
        await db.update(chatSlackManagerGrants).set({ expiresAt: new Date(0) }).where(eq(chatSlackManagerGrants.id, f.grantId));
        f.broker.refresh.mockImplementation(async () => {
          await f.grants.revoke(f.grantId, f.companyId, actor);
          return f.credentials;
        });
        await expect(f.grants.token(f.grantId, f.companyId, actor)).rejects.toThrow();
        expect((await f.grants.get(f.grantId, f.companyId, actor)).status).toBe("revoked");
      });
      it("claims concurrent manager callbacks once", async () => {
        const f = await managedFixture(); const state = await f.authorize();
        const results = await Promise.allSettled([1, 2].map(() => f.grants.complete(state, "claim", null, actor)));
        expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
        expect(f.broker.claim).toHaveBeenCalledTimes(2);
      });
      it("atomically consumes manager state and rejects wrong actors and expired attempts", async () => {
        const f = await managedFixture();
        await expect(f.grants.complete(f.authorizeState, "replay", null, actor)).rejects.toThrow();
        const state = await f.authorize();
        await expect(f.grants.complete(state, "claim", null, { ...actor, userId: "another-user", bypassPermissionCheck: true })).rejects.toThrow();
        await db.update(toolOauthStates).set({ expiresAt: new Date(0) }).where(eq(toolOauthStates.state, state));
        await expect(f.grants.complete(state, "claim", null, actor)).rejects.toThrow();
        expect(f.broker.claim).toHaveBeenCalledTimes(1);
      });
      it("preserves declined manager authorization as a safe recoverable outcome", async () => {
        const f = await managedFixture();
        await f.grants.complete(await f.authorize(), null, "access_denied", actor);
        expect((await f.service.get(f.endpoint.id)).setup.slackManagerError).toBe("slack_install_declined");
      });
      it("resumes saved installation credentials after inventory failure without creating or reinstalling", async () => {
        const f = await managedFixture(); f.state.failInventory = true;
        await f.provision();
        expect((await f.service.slackRegistration.registration(f.endpoint.id))?.status).toBe("credentials_saved");
        f.state.failInventory = false; await f.provision();
        expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.status).toBe("configured");
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.managedInstall"))).toHaveLength(1);
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
      });
      it("never recreates an uncertain app", async () => {
        const f = await managedFixture(); f.state.failCreate = true;
        await f.provision(); await f.provision();
        expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.status).toBe("uncertain");
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
      });
      it("uses bound OAuth for approval fallback and rejects a different installer", async () => {
        const f = await managedFixture(); f.state.managedError = "app_approval_request_eligible";
        const result = await f.provision();
        const state = new URL(result.authorization!.authorizationUrl).searchParams.get("state")!;
        f.state.oauth.authed_user.id = "UOTHER";
        await f.service.slackRegistration.complete(state, "code-canary", null, actor);
        expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.errorCode).toBe("slack_install_identity_mismatch");
        expect((await f.service.get(f.endpoint.id)).providerAccountId).toBeNull();
      });
      it("does not activate a bot when the manager grant is revoked during child OAuth", async () => {
        const f = await managedFixture(); f.state.managedError = "app_approval_request_eligible";
        const result = await f.provision();
        const state = new URL(result.authorization!.authorizationUrl).searchParams.get("state")!;
        f.state.beforeExchange = () => f.grants.revoke(f.grantId, f.companyId, actor);
        await f.service.slackRegistration.complete(state, "code-canary", null, actor);
        const saved = await f.service.get(f.endpoint.id);
        expect(saved.providerAccountId).toBeNull();
        expect(saved.setup.slackRegistration?.errorCode).toBe("slack_install_identity_mismatch");
      });
      it("uses the held transaction for grant queries without acquiring another pool connection", async () => {
        const f = await managedFixture();
        const transactionContext = new AsyncLocalStorage<boolean>();
        const originalTransaction = db.transaction.bind(db);
        const transactionSpy = vi.spyOn(db, "transaction").mockImplementation((work, ...args) =>
          originalTransaction(tx => transactionContext.run(true, () => work(tx)), ...args));
        const querySpies = (["select", "insert", "update", "delete", "execute"] as const).map(method => {
          const original = db[method].bind(db) as (...args: unknown[]) => unknown;
          return vi.spyOn(db, method).mockImplementation(((...args: unknown[]) => {
            if (transactionContext.getStore()) throw new Error("Acquired outer pool connection from held transaction");
            return original(...args);
          }) as never);
        });
        try {
          await f.grants.token(f.grantId, f.companyId, actor);
          await db.update(chatSlackManagerGrants).set({ expiresAt: new Date(0) }).where(eq(chatSlackManagerGrants.id, f.grantId));
          await f.grants.token(f.grantId, f.companyId, actor);
          expect(f.broker.refresh).toHaveBeenCalledTimes(1);
          await f.grants.request(f.grantId, f.companyId, actor, "apps.manifest.validate", { manifest: "{}" });
          await f.grants.complete(await f.authorize(), "renewed-claim", null, actor);
          expect((await f.service.get(f.endpoint.id)).setup.slackManagerError).toBeUndefined();
          await f.grants.revoke(f.grantId, f.companyId, actor);
          expect(f.broker.revoke).toHaveBeenCalledTimes(2);
        } finally {
          transactionSpy.mockRestore();
          for (const spy of querySpies) spy.mockRestore();
        }
      });
      it("serializes refreshes across endpoints and never replays an ambiguous refresh", async () => {
        const f = await managedFixture();
        await db.update(chatSlackManagerGrants).set({ expiresAt: new Date(0) }).where(eq(chatSlackManagerGrants.id, f.grantId));
        const tokens = await Promise.all([1, 2].map(() => f.grants.token(f.grantId, f.companyId, actor)));
        expect(tokens.every(result => result.token === "xoxe.rotated-canary")).toBe(true);
        expect(f.broker.refresh).toHaveBeenCalledTimes(1);
        await db.update(chatSlackManagerGrants).set({ expiresAt: new Date(0) }).where(eq(chatSlackManagerGrants.id, f.grantId));
        f.broker.refresh.mockRejectedValue(new Error("provider echoed manager-canary"));
        await expect(f.grants.token(f.grantId, f.companyId, actor)).rejects.toThrow();
        await expect(f.grants.token(f.grantId, f.companyId, actor)).rejects.toThrow();
        expect(f.broker.refresh).toHaveBeenCalledTimes(2);
      });
      it("rejects a bot token belonging to a different Slack app before activation", async () => {
        const f = await managedFixture(); f.state.managedBotAppId = "ADIFFERENT";
        await f.provision();
        const saved = await f.service.get(f.endpoint.id);
        expect(saved.providerAccountId).toBeNull();
        expect(saved.setup.slackRegistration).toMatchObject({ status: "credentials_saved", errorCode: "slack_install_identity_mismatch" });
      });
      it("rejects manager identity changes and both callback-origin and ingress-origin drift", async () => {
        const f = await managedFixture(); const state = await f.authorize();
        for (const change of [{ publicBaseUrl: "https://changed.example" }, { webhookPublicBaseUrl: "https://changed.example" }]) {
          const changed = createService(new FakeChatSdkRuntime(), f.provider, { ...change, slackManaged: { enabled: true, broker: f.broker as unknown as PaperclipCloudConnector } }).service;
          await expect(changed.slackRegistration.managerGrants.complete(state, "claim", null, actor)).rejects.toThrow();
        }
        f.broker.getSlackManagerAppId.mockResolvedValue("ANEWMANAGER");
        await expect(f.provision()).rejects.toThrow();
        expect((await f.grants.choices(f.companyId, actor)).workspaces).toEqual([]);
      });
      it("preserves provider rate-limit backoff across subsequent attempts", async () => {
        const f = await managedFixture(); f.state.managedError = "ratelimited";
        await f.provision();
        f.state.managedError = null; await f.provision();
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.managedInstall"))).toHaveLength(1);
        expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.errorCode).toBe("slack_setup_rate_limited");
      });
      it("routes the broker claim_id callback back to the saved wizard without exposing the handoff", async () => {
        const f = await managedFixture(); const state = await f.authorize();
        const response = await request(f.app).get(`/api/chat-slack/managed/oauth/callback?state=${state}&claim_id=sealed-claim-canary`).set("accept", "application/json").expect(303);
        expect(f.broker.claim.mock.calls.at(-1)![0].claimId).toBe("sealed-claim-canary");
        expect(response.headers.location).toContain(f.endpoint.id);
        expect(response.text).not.toContain("sealed-claim-canary");
        expect(response.headers["cache-control"]).toBe("no-store");
      });
      it("does not accept another company's grant or keep authorizations after removal", async () => {
        const f = await managedFixture(); const other = await seedCompany();
        await expect(f.grants.token(f.grantId, other.companyId, { ...actor, bypassPermissionCheck: true })).rejects.toThrow();
        const state = await f.authorize();
        await f.service.configure(f.endpoint.id, { action: "remove" }, actor.userId);
        await expect(f.grants.complete(state, "claim", null, actor)).rejects.toThrow();
        expect((await f.grants.get(f.grantId, f.companyId, actor)).status).toBe("active");
      });
      it("revocation invalidates pending authorization and prevents future provisioning", async () => {
        const f = await managedFixture(); const state = await f.authorize();
        await f.grants.revoke(f.grantId, f.companyId, actor);
        await expect(f.grants.complete(state, "claim", null, actor)).rejects.toThrow();
        await expect(f.provision()).rejects.toThrow();
        expect((await f.grants.choices(f.companyId, actor)).workspaces).toEqual([]);
      });
    });
    function setupEvent(f: Awaited<ReturnType<typeof fixture>>, patch: Record<string, unknown> = {}, url = f.endpoint.setup.webhookUrl!, secret = signingSecret, timestamp?: string) {
      return signedSlackWebhookRequest({ url, contentType: "application/json", signingSecret: secret, ...(timestamp ? { timestamp } : {}),
        body: JSON.stringify({ type: "event_callback", api_app_id: f.appId, team_id: "TAUTO", event_id: "EvSETUP", event: {
          type: "message", subtype: "bot_message", bot_id: "BSETUP", user: f.botId, channel: "DWELCOME", ts: "1.000001", text: "Synthetic welcome",
        }, ...patch }),
      });
    }
    it("uses an authenticated message event to complete automatic setup without a URL challenge and notifies once", async () => {
      const f = await fixture({ scheduleDeferredWork: () => undefined });
      await f.create(); await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      const responses = await Promise.all([1, 2].map(() => f.service.handleWebhook(f.endpoint.publicId, "slack", setupEvent(f))));
      expect(responses.every(response => response.ok)).toBe(true);
      const saved = await f.service.get(f.endpoint.id);
      expect(saved.setup.webhookVerifiedAt).toBeTruthy();
      expect(saved.setup.slackAccount?.verificationStatus).toBe("pending");
      await request(f.app).post(`/api/chat-endpoints/${f.endpoint.id}/setup`).send({ action: "verify" }).expect(200);
      await f.service.slackRegistration.processPendingVerificationMessages();
      await f.service.handleWebhook(f.endpoint.publicId, "slack", setupEvent(f));
      await f.service.slackRegistration.processPendingVerificationMessages();
      expect((await f.service.get(f.endpoint.id)).setup.webhookVerifiedAt).toBe(saved.setup.webhookVerifiedAt);
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(2);
      const activities = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
      expect(activities.filter(row => row.action === "chat_endpoint.webhook_verified")).toHaveLength(1);
      for (const canary of [configToken, signingSecret, clientSecret, f.token]) expect(JSON.stringify({ saved, activities })).not.toContain(canary);
    });
    it.each(["wrong-app", "missing-app", "wrong-workspace", "missing-workspace", "wrong-bot-binding", "missing-event-id", "wrong-secret", "stale-signature", "old-origin", "non-message", "sdk-failure", "paused-during-callback"])("does not complete setup from %s event evidence", async invalid => {
      const f = await fixture({ scheduleDeferredWork: () => undefined });
      await f.create(); await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      const patch: Record<string, unknown> = {};
      if (invalid === "wrong-app") patch.api_app_id = "AOTHER";
      if (invalid === "missing-app") patch.api_app_id = undefined;
      if (invalid === "wrong-workspace") patch.team_id = "TOTHER";
      if (invalid === "missing-workspace") patch.team_id = undefined;
      if (invalid === "missing-event-id") patch.event_id = undefined;
      if (invalid === "non-message") patch.event = { type: "unrecognized_setup_event" };
      if (invalid === "wrong-bot-binding") await db.update(chatSlackRegistrations).set({ botUserId: "UOTHER" }).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      if (invalid === "sdk-failure") f.sdk.get(f.endpoint.id)!.webhookResponse = new Response("unavailable", { status: 503 });
      if (invalid === "paused-during-callback") f.sdk.get(f.endpoint.id)!.webhookHook = async () => {
        await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, f.endpoint.id));
      };
      await f.service.handleWebhook(f.endpoint.publicId, "slack", setupEvent(f, patch,
        invalid === "old-origin" ? f.endpoint.setup.webhookUrl!.replace("paperclip.example", "old.example") : undefined,
        invalid === "wrong-secret" ? "wrong-secret" : undefined,
        invalid === "stale-signature" ? "1" : undefined));
      const saved = await f.service.get(f.endpoint.id);
      expect(saved.setup.webhookVerifiedAt).toBeFalsy();
      expect(saved.setup.slackAccount?.verificationStatus).toBeUndefined();
      await f.service.slackRegistration.processPendingVerificationMessages();
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(1);
    });
    it("creates once under concurrent submissions and resumes after restart without exposing credentials", async () => {
      const f = await fixture();
      await Promise.all([f.create(), f.create()]);
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
      const saved = await f.service.get(f.endpoint.id);
      expect(saved.setup).toMatchObject({ slackSetupMethod: "automatic", slackRegistration: { status: "install", appId: f.appId } });
      expect(saved.setup.slackAvatar).toMatchObject({ status: "uploaded", uploadedAt: expect.any(String) });
      const { service: restarted } = createService(new FakeChatSdkRuntime(), f.provider);
      await restarted.slackRegistration.create(f.endpoint.id, actor, { ...f.createInput, requestId: randomUUID() });
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.icon.set"))).toHaveLength(1);
      expect((await restarted.get(f.endpoint.id)).setup.slackAvatar).toEqual(saved.setup.slackAvatar);
      const [row] = await db.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(Object.keys(row.secretIds).sort()).toEqual(["clientSecret", "signingSecret"]);
      const publicState = JSON.stringify({ saved, row, activities: await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId)) });
      for (const canary of [configToken, signingSecret, clientSecret, f.token]) expect(publicState).not.toContain(canary);
      await request(f.app).patch(`/api/chat-endpoints/${f.endpoint.id}`).send({ slackApp: appDetails }).expect(409);
    });
    it.each([undefined, "22222222-2222-4222-8222-222222222222"])("uploads preset bytes after credentials are durable, even with private avatar %s", async customAvatarAssetId => {
      const f = await fixture();
      await db.update(agents).set({ appearance: { schemaVersion: 1, characterVersion: "cap-v1", paletteId: "cherry-pop", customAvatarAssetId } }).where(eq(agents.id, f.assignedAgentId));
      f.state.beforeIcon = async () => {
        const row = (await f.service.slackRegistration.registration(f.endpoint.id))!;
        expect(row).toMatchObject({ status: "install", appId: f.appId });
        expect(Object.keys(row.secretIds).sort()).toEqual(["clientSecret", "signingSecret"]);
        expect((await f.service.get(f.endpoint.id)).setup.slackAvatar).toEqual({ status: "pending" });
      };
      await f.create();
      const [, init] = f.provider.mock.calls.find(([url]) => String(url).endsWith("apps.icon.set"))!;
      expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: `Bearer ${configToken}` } });
      expect(f.renderAvatar).toHaveBeenCalledWith({ appearance: { schemaVersion: 1, characterVersion: "cap-v1", paletteId: "cherry-pop" },
        size: 512, scale: 1, pose: "rest", muted: false, background: "paperclip-dark" });
      expect(init!.body).toBeInstanceOf(FormData);
      const fields = init!.body as FormData;
      expect(fields.get("app_id")).toBe(f.appId);
      expect(fields.has("url")).toBe(false);
      expect(fields.has("token")).toBe(false);
      expect(init!.headers).not.toHaveProperty("content-type"); // fetch sets the multipart boundary.
      const file = fields.get("file") as File;
      expect(file.type).toBe("image/png");
      expect(file.name).toBe("agent-avatar.png");
      expect(Buffer.from(await file.arrayBuffer())).toEqual(f.avatarBytes);
      expect(f.provider.mock.calls.every(([url]) => !String(url).includes("/agent-avatars/"))).toBe(true);
      expect((await request(f.app).get(`/api/chat-endpoints/${f.endpoint.id}`).expect(200)).body.setup.slackAvatar.status).toBe("uploaded");
    });
    it("uploads a real 512-pixel PNG from the production renderer", async () => {
      const f = await fixture({ renderSlackAvatar: undefined });
      await f.create();
      const [, init] = f.provider.mock.calls.find(([url]) => String(url).endsWith("apps.icon.set"))!;
      const file = (init!.body as FormData).get("file") as File;
      const png = Buffer.from(await file.arrayBuffer());
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.readUInt32BE(16)).toBe(512);
      expect(png.readUInt32BE(20)).toBe(512);
      expect((await f.service.get(f.endpoint.id)).setup.slackAvatar?.status).toBe("uploaded");
    });
    it("keeps the saved app installable after local avatar rendering fails", async () => {
      const f = await fixture({ renderSlackAvatar: async () => { throw new Error("render failed"); } });
      await f.create();
      expect((await f.service.get(f.endpoint.id)).setup.slackAvatar).toEqual({ status: "failed", errorCode: "slack_avatar_upload_failed" });
      expect(f.provider.mock.calls.some(([url]) => String(url).endsWith("apps.icon.set"))).toBe(false);
      await expect(f.install()).resolves.toMatch(/^slack-install\./);
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
    });
    it.each(["failIcon", "timeoutIcon"] as const)("keeps installation usable after %s without leaking provider echoes or creating another app", async failure => {
      const f = await fixture();
      f.state[failure] = true;
      const result = await request(f.app).post(`/api/chat-endpoints/${f.endpoint.id}/slack/registration`).send(f.createInput).expect(200);
      expect(result.body.setup.slackAvatar).toEqual({ status: "failed", errorCode: "slack_avatar_upload_failed" });
      expect(result.body.setup.slackRegistration).toMatchObject({ status: "install", appId: f.appId, errorCode: null });
      await f.create();
      await f.service.slackRegistration.complete(await f.install(), "icon-failure-code", null, actor);
      const saved = await f.service.get(f.endpoint.id);
      expect(saved.setup.slackRegistration?.status).toBe("configured");
      expect(saved.setup.slackAvatar).toEqual(result.body.setup.slackAvatar);
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.icon.set"))).toHaveLength(1);
      const activities = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
      expect(activities.some(entry => entry.action === "chat_slack.avatar_upload_failed")).toBe(true);
      for (const canary of [configToken, clientSecret, signingSecret, f.token]) expect(JSON.stringify({ result: result.body, saved, activities })).not.toContain(canary);
    });
    it("resumes an interrupted avatar upload without repeating creation or requesting another token", async () => {
      const f = await fixture();
      await f.create();
      const saved = await f.service.get(f.endpoint.id);
      await db.update(chatEndpoints).set({ setup: { ...saved.setup, slackAvatar: { status: "pending" } } }).where(eq(chatEndpoints.id, f.endpoint.id));
      const { service: restarted } = createService(new FakeChatSdkRuntime(), f.provider);
      await restarted.slackRegistration.create(f.endpoint.id, actor, { ...f.createInput, requestId: randomUUID() });
      expect((await restarted.get(f.endpoint.id)).setup.slackAvatar).toEqual({ status: "pending" });
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.icon.set"))).toHaveLength(1);
      expect((await restarted.slackRegistration.install(f.endpoint.id, actor)).authorizationUrl).toContain("slack.com/oauth/v2/authorize");
    });
    it("does not advance avatar state after management access is revoked during upload", async () => {
      const f = await fixture();
      f.state.beforeIcon = async () => { await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, f.companyId)); };
      await expect(f.create()).rejects.toThrow("Missing permission");
      const saved = await f.service.get(f.endpoint.id);
      expect(saved.setup.slackAvatar).toEqual({ status: "pending" });
      expect(saved.setup.slackRegistration).toMatchObject({ status: "install", appId: f.appId });
      expect(saved.botExternalId).toBeNull();
      await expect(f.install()).rejects.toThrow("Missing permission");
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
    });
    it("preserves a saved app when its creation activity fails without exposing the failure", async () => {
      const f = await fixture();
      const originalLogActivity = activityLogService.logActivity;
      const activity = vi.spyOn(activityLogService, "logActivity").mockImplementation(async (database, input) => {
        if (input.action === "chat_slack.app_created") throw new Error(`Audit outage ${clientSecret}`);
        return originalLogActivity(database, input);
      });
      const warning = vi.spyOn(chatAttachmentLogger, "warn").mockImplementation(() => {});
      try {
        await f.create();
        await f.create();
        expect((await f.service.get(f.endpoint.id)).setup.slackRegistration).toMatchObject({ status: "install", appId: f.appId, errorCode: null });
        const row = await f.service.slackRegistration.registration(f.endpoint.id);
        expect(Object.keys(row!.secretIds).sort()).toEqual(["clientSecret", "signingSecret"]);
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
        expect(warning).toHaveBeenCalledWith({ endpointId: f.endpoint.id, appId: f.appId }, "Slack app creation activity could not be recorded");
        expect(JSON.stringify(warning.mock.calls)).not.toContain(clientSecret);
        expect(activity.mock.calls.some(([, input]) => input.action === "chat_slack.creation_failed")).toBe(false);
      } finally { activity.mockRestore(); warning.mockRestore(); }
    });
    it("links the OAuth installer, sends one welcome DM, and still requires signed URL verification", async () => {
      const f = await fixture();
      await f.create();
      const state = await f.install();
      const first = await request(f.app).get(`/api/chat-slack/oauth/callback?state=${state}&code=oauth-code-canary`).set("Accept", "text/html").set("Sec-Fetch-Site", "cross-site").set("Sec-Fetch-Mode", "navigate").expect(200);
      expect(first.headers["cache-control"]).toBe("no-store");
      expect(first.text).not.toContain("oauth-code-canary");
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("oauth.v2.access"))).toHaveLength(0);
      const completed = await request(f.app).get(`/api/chat-slack/oauth/callback?state=${state}&code=oauth-code-canary`).set("Sec-Fetch-Site", "same-origin").expect(303);
      expect(completed.headers.location).toContain(`resume=${f.endpoint.id}`);
      const saved = await f.service.get(f.endpoint.id);
      expect(saved.setup.slackRegistration?.status).toBe("configured");
      expect(saved.setup.step).toBe("provider_setup");
      expect(saved.setup.webhookVerifiedAt).toBeNull();
      expect(saved.providerAccountId).toBe("TAUTO");
      expect(saved.setup.slackAccount).toEqual({ externalUserId: f.installerId, paperclipUserId: actor.userId, status: "linked", welcomeStatus: "sent", dmChannelId: "DWELCOME" });
      expect(await f.service.listPrincipals(f.endpoint.id)).toEqual([expect.objectContaining({ status: "linked", paperclipUserId: actor.userId, paperclipUserImage: null })]);
      await db.update(authUsers).set({ image: "https://example.test/installer.png" }).where(eq(authUsers.id, actor.userId));
      expect(await f.service.listPrincipals(f.endpoint.id)).toEqual([expect.objectContaining({ paperclipUserImage: "https://example.test/installer.png" })]);
      await db.update(authUsers).set({ image: null }).where(eq(authUsers.id, actor.userId));
      const [, welcome] = f.provider.mock.calls.find(([url]) => String(url).endsWith("chat.postMessage"))!;
      expect(new URLSearchParams(String(welcome!.body)).get("channel")).toBe(f.installerId);
      expect(new URLSearchParams(String(welcome!.body)).get("text")).toMatch(/^Hi, I’m .+\. Your Slack account is connected to Paperclip\.$/);
      const [row] = await db.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(Object.keys(row.secretIds)).toEqual(["clientSecret"]);
      await request(f.app).patch(`/api/chat-endpoints/${f.endpoint.id}`).send({ slackSetupMethod: "manual" }).expect(409);
      expect((await f.service.slackRegistration.registration(f.endpoint.id))?.secretIds).toEqual(row.secretIds);
      const body = JSON.stringify({ type: "url_verification", challenge: "auto-challenge" });
      await f.service.handleWebhook(saved.publicId, "slack", signedSlackWebhookRequest({ url: saved.setup.webhookUrl!, body, contentType: "application/json", signingSecret }));
      expect((await f.service.get(f.endpoint.id)).setup.webhookVerifiedAt).toBeTruthy();
      await f.service.slackRegistration.complete(await f.install(), "new-code", null, actor);
      expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.status).toBe("configured");
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
      const activities = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
      for (const canary of [configToken, signingSecret, clientSecret, f.token, "oauth-code-canary"]) expect(JSON.stringify({ saved, activities, response: completed.text })).not.toContain(canary);
    });
    it("adds events only after saving signing credentials and answers Slack's update-time challenge before OAuth", async () => {
      const f = await fixture({ scheduleDeferredWork: () => undefined });
      f.state.beforeManifestUpdate = async () => {
        const row = (await f.service.slackRegistration.registration(f.endpoint.id))!;
        expect(row.errorCode).toBe("slack_manifest_update_pending");
        expect(row.secretIds.signingSecret).toBeTruthy();
        const creation = f.provider.mock.calls.find(([url]) => String(url).endsWith("apps.manifest.create"))!;
        const update = f.provider.mock.calls.find(([url]) => String(url).endsWith("apps.manifest.update"))!;
        const initial = JSON.parse(new URLSearchParams(String(creation[1]!.body)).get("manifest")!);
        const final = JSON.parse(new URLSearchParams(String(update[1]!.body)).get("manifest")!);
        expect(initial.settings.event_subscriptions).toBeUndefined();
        expect(final).toEqual(row.manifest);
        const { event_subscriptions: events, ...settings } = final.settings;
        expect(events.request_url).toBe(f.endpoint.setup.webhookUrl);
        expect(initial).toEqual({ ...final, settings });
        const body = JSON.stringify({ type: "url_verification", challenge: "before-install" });
        const response = await f.service.handleWebhook(f.endpoint.publicId, "slack", signedSlackWebhookRequest({
          url: f.endpoint.setup.webhookUrl!, body, contentType: "application/json", signingSecret,
        }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ challenge: "before-install" });
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("auth.test") || String(url).endsWith("oauth.v2.access"))).toHaveLength(0);
        expect((await f.service.get(f.endpoint.id)).status).toBe("draft");
      };
      await f.create();
      const verifiedAt = (await f.service.get(f.endpoint.id)).setup.webhookVerifiedAt;
      expect(verifiedAt).toBeTruthy();
      await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      const saved = await f.service.get(f.endpoint.id);
      expect(saved.setup.webhookVerifiedAt).toBe(verifiedAt);
      expect(saved.setup.slackAccount?.verificationStatus).toBe("sent");
      const messages = f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"));
      expect(messages).toHaveLength(2);
      expect(new URLSearchParams(String(messages[0][1]!.body)).get("text")).not.toContain("/event-subscriptions");
      expect(new URLSearchParams(String(messages[1][1]!.body)).get("text")).toBe("Your Slack connection is working! Now ask me a question about your Paperclip instance.");
    });
    it.each(["failManifestUpdate", "timeoutManifestUpdate"] as const)("recovers %s on the same saved app after restart without exposing provider echoes", async failure => {
      const f = await fixture();
      f.state[failure] = true;
      await f.create();
      const saved = await f.service.get(f.endpoint.id);
      expect(saved.setup.slackRegistration).toMatchObject({ appId: f.appId, status: "install", errorCode: "slack_manifest_update_pending" });
      await expect(f.install()).rejects.toThrow("Finish configuring the saved Slack app");
      const activities = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
      for (const canary of [configToken, signingSecret, clientSecret]) expect(JSON.stringify({ saved, activities })).not.toContain(canary);
      f.state[failure] = false;
      const { service: restarted } = createService(new FakeChatSdkRuntime(), f.provider);
      await restarted.slackRegistration.create(f.endpoint.id, actor, { ...f.createInput, requestId: randomUUID() });
      expect((await restarted.get(f.endpoint.id)).setup.slackRegistration).toMatchObject({ appId: f.appId, errorCode: null });
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.update"))).toHaveLength(2);
      await expect(restarted.slackRegistration.install(f.endpoint.id, actor)).resolves.toHaveProperty("authorizationUrl");
      expect((await restarted.get(f.endpoint.id)).setup.webhookVerifiedAt).toBeFalsy();
    });
    it("wakes verification from a signed callback with no maintenance polling", async () => {
      const f = await fixture({ scheduleDeferredWork: () => undefined });
      await f.create(); await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      const onError = vi.fn();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
      try {
        await registerChatActionWork(coordinator, f.service, () => true).ready;
        await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 10_000 });
        expect(await f.service.nextVerificationMessageAt()).toBeNull();
        await f.service.handleWebhook(f.endpoint.publicId, "slack", signedSlackWebhookRequest({
          url: f.endpoint.setup.webhookUrl!, contentType: "application/json", signingSecret,
          body: JSON.stringify({ type: "url_verification", challenge: "scheduler" }),
        }));
        await vi.waitFor(async () => {
          expect((await f.service.get(f.endpoint.id)).setup.slackAccount?.verificationStatus).toBe("sent");
          expect(coordinator.nextWakeAt()).toBeNull();
        }, { timeout: 10_000 });
        expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(2);
        expect(onError).not.toHaveBeenCalled();
      } finally { await coordinator.stop(); }
    });
    it("acknowledges verification before sending one DM across concurrent callbacks and restart recovery", async () => {
      const f = await fixture({ scheduleDeferredWork: () => undefined });
      await f.create(); await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      const body = JSON.stringify({ type: "url_verification", challenge: "verified-once" });
      const challenge = () => f.service.handleWebhook(f.endpoint.publicId, "slack", signedSlackWebhookRequest({
        url: f.endpoint.setup.webhookUrl!, body, contentType: "application/json", signingSecret,
      }));
      const responses = await Promise.all([challenge(), challenge()]);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      expect((await f.service.get(f.endpoint.id)).setup.slackAccount?.verificationStatus).toBe("pending");
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(1);
      const restarted = createService(new FakeChatSdkRuntime(), f.provider).service;
      await Promise.all([restarted.slackRegistration.processPendingVerificationMessages(), restarted.slackRegistration.notifyVerified(f.endpoint.id)]);
      expect((await restarted.get(f.endpoint.id)).setup.slackAccount?.verificationStatus).toBe("sent");
      await challenge(); await restarted.slackRegistration.notifyVerified(f.endpoint.id);
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(2);
    });
    it.each(["unsigned", "wrong-secret", "expired-signature", "foreign-workspace", "old-origin"])("does not verify or notify for a %s challenge", async invalid => {
      const f = await fixture({ scheduleDeferredWork: () => undefined });
      await f.create(); await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      const body = JSON.stringify({ type: "url_verification", challenge: "invalid", ...(invalid === "foreign-workspace" ? { team_id: "TOTHER" } : {}) });
      const request = signedSlackWebhookRequest({ url: invalid === "old-origin" ? `https://old.example/api/chat-webhooks/${f.endpoint.publicId}/slack` : f.endpoint.setup.webhookUrl!, body, contentType: "application/json", signingSecret: invalid === "wrong-secret" ? "wrong" : signingSecret });
      if (invalid === "unsigned") request.headers.delete("x-slack-signature");
      if (invalid === "expired-signature") request.headers.set("x-slack-request-timestamp", "1");
      expect((await f.service.handleWebhook(f.endpoint.publicId, "slack", request)).status).toBe(["foreign-workspace", "old-origin"].includes(invalid) ? 200 : 401);
      expect((await f.service.get(f.endpoint.id)).setup.webhookVerifiedAt).toBeNull();
      await f.service.slackRegistration.notifyVerified(f.endpoint.id);
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(1);
    });
    it.each(["failWelcome", "timeoutWelcome"] as const)("does not replay a verification DM after %s", async failure => {
      const f = await fixture({ scheduleDeferredWork: () => undefined });
      await f.create(); await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      f.state[failure] = true;
      const body = JSON.stringify({ type: "url_verification", challenge: "verified" });
      const response = await f.service.handleWebhook(f.endpoint.publicId, "slack", signedSlackWebhookRequest({ url: f.endpoint.setup.webhookUrl!, body, contentType: "application/json", signingSecret }));
      expect(response.status).toBe(200);
      await f.service.slackRegistration.notifyVerified(f.endpoint.id);
      expect((await f.service.get(f.endpoint.id)).setup.slackAccount?.verificationStatus).toBe(failure === "failWelcome" ? "failed" : "uncertain");
      f.state[failure] = false;
      await f.service.slackRegistration.notifyVerified(f.endpoint.id);
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(2);
      const activities = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
      const saved = await f.service.get(f.endpoint.id);
      for (const canary of [configToken, signingSecret, clientSecret, f.token]) expect(JSON.stringify({ saved, activities })).not.toContain(canary);
    });
    it.each(["revoked-link", "removed", "interrupted"])("does not send a pending verification DM after %s", async interruption => {
      const f = await fixture({ scheduleDeferredWork: () => undefined });
      await f.create(); await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      const body = JSON.stringify({ type: "url_verification", challenge: "verified" });
      await f.service.handleWebhook(f.endpoint.publicId, "slack", signedSlackWebhookRequest({ url: f.endpoint.setup.webhookUrl!, body, contentType: "application/json", signingSecret }));
      if (interruption === "removed") await f.service.configure(f.endpoint.id, { action: "remove" }, actor.userId);
      else if (interruption === "revoked-link") await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.endpointId, f.endpoint.id));
      else {
        const [saved] = await readChatEndpointsById(f.endpoint.id);
        await db.update(chatEndpoints).set({ setup: { ...saved.setup, slackAccount: { ...saved.setup.slackAccount!, verificationStatus: "sending" } } }).where(eq(chatEndpoints.id, f.endpoint.id));
      }
      await f.service.slackRegistration.notifyVerified(f.endpoint.id);
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(1);
      if (interruption !== "removed") expect((await f.service.get(f.endpoint.id)).setup.slackAccount?.verificationStatus).toBe(interruption === "revoked-link" ? "failed" : "uncertain");
    });
    it.each(["failAuth", "failInventory"] as const)("vaults the bot token before %s and resumes without code exchange", async failure => {
      const f = await fixture();
      await f.create();
      f.state[failure] = true;
      await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      expect((await f.service.get(f.endpoint.id)).setup.slackRegistration).toMatchObject({ status: "credentials_saved", errorCode: "slack_configuration_incomplete" });
      const [row] = await db.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row.secretIds.botToken).toBeTruthy();
      f.state[failure] = false;
      await f.service.slackRegistration.resume(f.endpoint.id, actor);
      expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.status).toBe("configured");
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("oauth.v2.access"))).toHaveLength(1);
    });
    it("reuses the saved installer and sends no further DM on reauthorization or restart", async () => {
      const f = await fixture(); await f.create();
      const state = await f.install();
      const result = await Promise.allSettled([f.service.slackRegistration.complete(state, "code", null, actor), f.service.slackRegistration.complete(state, "code", null, actor)]);
      expect(result.filter(item => item.status === "fulfilled")).toHaveLength(1);
      f.state.oauth.authed_user.id = "UOTHERINSTALLER";
      await f.service.slackRegistration.complete(await f.install(), "other-code", null, actor);
      const restarted = createService(new FakeChatSdkRuntime(), f.provider).service;
      await restarted.slackRegistration.resume(f.endpoint.id, actor);
      expect((await restarted.get(f.endpoint.id)).setup.slackAccount?.externalUserId).toBe(f.installerId);
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(1);
      const principals = await db.select().from(chatExternalPrincipals).where(eq(chatExternalPrincipals.companyId, f.companyId));
      expect(principals.map(principal => principal.externalId)).toEqual([f.installerId]);
    });
    it("retains the token and installer after lookup failure and resumes without exchanging a code", async () => {
      const f = await fixture(); await f.create(); f.state.failUser = true;
      await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      expect((await f.service.get(f.endpoint.id)).setup).toMatchObject({ slackAccount: { status: "pending", externalUserId: f.installerId }, slackRegistration: { status: "credentials_saved" } });
      expect((await f.service.slackRegistration.registration(f.endpoint.id))?.secretIds.botToken).toBeTruthy();
      expect(await f.service.listPrincipals(f.endpoint.id)).toEqual([]);
      f.state.failUser = false;
      await f.service.slackRegistration.resume(f.endpoint.id, actor);
      expect((await f.service.get(f.endpoint.id)).setup.slackAccount).toMatchObject({ status: "linked", welcomeStatus: "sent" });
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("oauth.v2.access"))).toHaveLength(1);
    });
    it.each(["failWelcome", "timeoutWelcome"] as const)("keeps setup connected after %s and never retries an optional DM", async failure => {
      const f = await fixture(); await f.create(); f.state[failure] = true;
      await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      const saved = await f.service.get(f.endpoint.id);
      expect(saved.setup.slackRegistration?.status).toBe("configured");
      expect(saved.setup.slackAccount).toMatchObject({ status: "linked", welcomeStatus: failure === "failWelcome" ? "failed" : "uncertain" });
      f.state[failure] = false;
      await f.service.slackRegistration.resume(f.endpoint.id, actor);
      await f.service.slackRegistration.complete(await f.install(), "code-2", null, actor);
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(1);
      const activities = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
      for (const canary of [f.token, signingSecret, clientSecret, configToken]) expect(JSON.stringify({ saved, activities })).not.toContain(canary);
    });
    it.each(["workspace", "user", "bot", "deleted"])("rejects an installer lookup %s mismatch without linking", async mismatch => {
      const f = await fixture(); await f.create();
      if (mismatch === "workspace") f.state.user.team_id = "TOTHER";
      if (mismatch === "user") f.state.user.id = "UOTHER";
      if (mismatch === "bot") f.state.user.is_bot = true;
      if (mismatch === "deleted") f.state.user.deleted = true;
      await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      expect((await f.service.get(f.endpoint.id)).setup.slackRegistration).toMatchObject({ status: "credentials_saved", errorCode: "slack_install_account_missing" });
      expect((await f.service.slackRegistration.registration(f.endpoint.id))?.secretIds.botToken).toBeTruthy();
      expect(await db.select().from(chatIdentityLinks).where(eq(chatIdentityLinks.companyId, f.companyId))).toEqual([]);
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(0);
    });
    it("respects disabled direct messages when provisioning the welcome", async () => {
      const f = await fixture(); await f.create();
      await db.update(chatEndpoints).set({ allowDirectMessages: false }).where(eq(chatEndpoints.id, f.endpoint.id));
      await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      expect((await f.service.get(f.endpoint.id)).setup).toMatchObject({ slackRegistration: { status: "configured" }, slackAccount: { status: "linked", welcomeStatus: "failed" } });
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(0);
    });
    it("does not replay a welcome dispatch interrupted by restart", async () => {
      const f = await fixture(); await f.create();
      await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      const saved = await f.service.get(f.endpoint.id);
      await db.update(chatEndpoints).set({ setup: { ...saved.setup, slackAccount: { ...saved.setup.slackAccount!, welcomeStatus: "sending", dmChannelId: undefined } } }).where(eq(chatEndpoints.id, f.endpoint.id));
      const restarted = createService(new FakeChatSdkRuntime(), f.provider).service;
      await restarted.slackRegistration.resume(f.endpoint.id, actor);
      expect((await restarted.get(f.endpoint.id)).setup.slackAccount?.welcomeStatus).toBe("uncertain");
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(1);
    });
    it.each(["other-user", "revoked"])("preserves an existing %s account link without a welcome DM", async existing => {
      const f = await fixture(); await f.create();
      const [principal] = await db.insert(chatExternalPrincipals).values({ companyId: f.companyId, provider: "slack", providerAccountId: "TAUTO", externalId: f.installerId, kind: "user" }).returning();
      const [link] = await db.insert(chatIdentityLinks).values({ companyId: f.companyId, endpointId: f.endpoint.id, principalId: principal.id, paperclipUserId: existing === "revoked" ? actor.userId : "another-user", status: existing === "revoked" ? "revoked" : "linked" }).returning();
      await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.errorCode).toBe("slack_install_account_conflict");
      expect((await db.select().from(chatIdentityLinks).where(eq(chatIdentityLinks.id, link.id)))[0]).toMatchObject({ status: link.status, paperclipUserId: link.paperclipUserId });
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(0);
    });
    it("does not link or welcome an installer after company membership is revoked during lookup", async () => {
      const f = await fixture(); await f.create();
      f.state.beforeUser = async () => { await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.companyId, f.companyId)); };
      await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.status).toBe("credentials_saved");
      expect(await db.select().from(chatIdentityLinks).where(eq(chatIdentityLinks.companyId, f.companyId))).toEqual([]);
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(0);
    });
    it("does not send a pending welcome to a subsequently revoked account link", async () => {
      const f = await fixture(); await f.create();
      await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      const saved = await f.service.get(f.endpoint.id);
      await db.update(chatEndpoints).set({ setup: { ...saved.setup, slackAccount: { ...saved.setup.slackAccount!, welcomeStatus: "pending", dmChannelId: undefined } } }).where(eq(chatEndpoints.id, f.endpoint.id));
      await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.endpointId, f.endpoint.id));
      await f.service.slackRegistration.resume(f.endpoint.id, actor);
      expect((await f.service.get(f.endpoint.id)).setup.slackAccount?.welcomeStatus).toBe("failed");
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(1);
      expect((await db.select().from(chatIdentityLinks).where(eq(chatIdentityLinks.endpointId, f.endpoint.id)))[0].status).toBe("revoked");
    });
    it.each(["", "invalid"])("rejects a missing or invalid OAuth installer (%s)", async installer => {
      const f = await fixture(); await f.create(); f.state.oauth.authed_user.id = installer;
      await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.errorCode).toBe("slack_install_account_missing");
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(0);
    });
    it("does not repeat uncertain creation until the operator explicitly confirms no app exists", async () => {
      const f = await fixture();
      f.state.failCreate = true;
      await f.create();
      expect((await f.service.get(f.endpoint.id)).setup.slackRegistration).toMatchObject({ status: "uncertain", errorCode: "slack_creation_uncertain" });
      await f.create({ ...f.createInput, requestId: randomUUID() });
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
      f.state.failCreate = false;
      await f.service.slackRegistration.create(f.endpoint.id, actor, { ...f.createInput, requestId: randomUUID(), confirmedNoAppCreated: true });
      expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.status).toBe("install");
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(2);
    });
    it("shows interrupted creation as uncertain after restart and supports manual recovery on the same draft", async () => {
      const f = await fixture();
      f.state.failCreate = true;
      await f.create();
      await db.update(chatSlackRegistrations).set({ status: "creating", updatedAt: new Date(Date.now() - 120_000) }).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.status).toBe("uncertain");
      await f.service.update(f.endpoint.id, { slackSetupMethod: "manual" }, actor.userId);
      expect((await f.service.get(f.endpoint.id)).setup.slackSetupMethod).toBe("manual");
      await expect(f.service.slackRegistration.install(f.endpoint.id, actor)).rejects.toThrow();
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
    });
    it("maps invalid token and validation echoes without persisting or exposing the supplied token", async () => {
      const f = await fixture();
      f.state.failValidate = true;
      const result = await request(f.app).post(`/api/chat-endpoints/${f.endpoint.id}/slack/registration`).send(f.createInput).expect(422);
      expect(result.body.error).toContain("Generate a new access token");
      expect(result.text).not.toContain(configToken);
      expect(await f.service.slackRegistration.registration(f.endpoint.id)).toBeUndefined();
      const malformed = await request(f.app).post(`/api/chat-endpoints/${f.endpoint.id}/slack/registration`).send({ ...f.createInput, credentials: { configurationToken: { nested: configToken } } }).expect(400);
      expect(malformed.text).not.toContain(configToken);
      f.state.failValidate = false;
      await f.create();
      expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.status).toBe("install");
    });
    it.each(["app", "workspace", "bot", "type", "scope"])("rejects an OAuth %s mismatch without binding runtime credentials", async mismatch => {
      const f = await fixture();
      await f.create();
      if (mismatch === "app") f.state.oauth.app_id = "AWRONG";
      if (mismatch === "workspace") f.state.oauth.team.id = "";
      if (mismatch === "bot") f.state.oauth.bot_user_id = "invalid";
      if (mismatch === "type") f.state.oauth.token_type = "user";
      if (mismatch === "scope") f.state.oauth.scope = "chat:write";
      await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      const saved = await f.service.get(f.endpoint.id);
      expect(saved.providerAccountId).toBeNull();
      expect(saved.setup.slackRegistration?.errorCode).toBe(mismatch === "scope" ? "slack_install_scopes_missing" : "slack_install_identity_mismatch");
    });
    it("claims callbacks once, keeps denied installation resumable, and does not replay ambiguous exchange", async () => {
      const f = await fixture();
      await f.create();
      await f.service.slackRegistration.complete(await f.install(), null, "access_denied", actor);
      expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.errorCode).toBe("slack_install_declined");
      f.state.failExchange = true;
      const state = await f.install();
      const results = await Promise.allSettled([f.service.slackRegistration.complete(state, "code", null, actor), f.service.slackRegistration.complete(state, "code", null, actor)]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("oauth.v2.access"))).toHaveLength(1);
      await expect(f.service.slackRegistration.complete(state, "code", null, actor)).rejects.toThrow();
      f.state.failExchange = false;
      await f.service.slackRegistration.complete(await f.install(), "new-code", null, actor);
      expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.status).toBe("configured");
    });
    it("rejects expiry, wrong actor/session/company, permission revocation, and origin drift before exchange", async () => {
      const f = await fixture();
      await f.create();
      const state = await f.install();
      await expect(f.service.slackRegistration.complete(state, "code", null, { ...actor, userId: "other-user" })).rejects.toThrow();
      await expect(f.service.slackRegistration.complete(state, "code", null, { ...actor, sessionId: "other-session" })).rejects.toThrow();
      const other = await seedCompany();
      await db.update(toolOauthStates).set({ companyId: other.companyId }).where(eq(toolOauthStates.state, state));
      await expect(f.service.slackRegistration.complete(state, "code", null, actor)).rejects.toThrow();
      await db.update(toolOauthStates).set({ companyId: f.companyId, expiresAt: new Date(0) }).where(eq(toolOauthStates.state, state));
      await expect(f.service.slackRegistration.complete(state, "code", null, actor)).rejects.toThrow();
      const fresh = await f.install();
      const changed = createService(new FakeChatSdkRuntime(), f.provider, { webhookPublicBaseUrl: "https://changed.example" }).service;
      await expect(changed.slackRegistration.complete(fresh, "code", null, actor)).rejects.toThrow(/webhook address changed/);
      const changedBrowser = createService(new FakeChatSdkRuntime(), f.provider, { publicBaseUrl: "https://changed.example" }).service;
      await expect(changedBrowser.slackRegistration.complete(fresh, "code", null, actor)).rejects.toThrow();
      await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, f.companyId));
      await expect(f.service.slackRegistration.complete(fresh, "code", null, actor)).rejects.toThrow();
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("oauth.v2.access"))).toHaveLength(0);
    });
    it("returns expired authorization to the saved wizard without exchanging its code", async () => {
      const f = await fixture();
      await f.create();
      const state = await f.install();
      await db.update(toolOauthStates).set({ expiresAt: new Date(0) }).where(eq(toolOauthStates.state, state));
      expect(await f.service.slackRegistration.expiredReturn(state, { ...actor, sessionId: "wrong-session" })).toBeNull();
      const result = await request(f.app).get(`/api/chat-slack/oauth/callback?state=${state}&code=expired-code-canary`).expect(303);
      expect(result.headers.location).toContain(`resume=${f.endpoint.id}`);
      expect(result.text).not.toContain("expired-code-canary");
      expect((await f.service.get(f.endpoint.id)).setup.slackRegistration).toMatchObject({ status: "install", errorCode: "slack_install_expired" });
      expect(await db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state))).toEqual([]);
      expect(f.provider.mock.calls.some(([url]) => String(url).endsWith("oauth.v2.access"))).toBe(false);
    });
    it("does not bind runtime credentials when management access is revoked during provider checks", async () => {
      const f = await fixture();
      await f.create();
      f.state.beforeAuth = async () => { await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, f.companyId)); };
      await f.service.slackRegistration.complete(await f.install(), "code", null, actor);
      const saved = await f.service.get(f.endpoint.id);
      expect(saved.providerAccountId).toBeNull();
      expect(saved.botExternalId).toBeNull();
      expect(saved.setup.slackRegistration?.status).toBe("credentials_saved");
      const [connection] = await readToolConnectionsById(f.endpoint.connectionId);
      expect(connection.credentialSecretRefs).toEqual([]);
      await expect(f.service.slackRegistration.resume(f.endpoint.id, actor)).rejects.toThrow();
    });
    it("reinstalls a revoked bot using the same app and preserves the linked account", async () => {
      const f = await fixture();
      await f.create();
      await f.service.slackRegistration.complete(await f.install(), "first-code", null, actor);
      const account = (await f.service.get(f.endpoint.id)).setup.slackAccount;
      await f.service.handleWebhook(f.endpoint.publicId, "slack", setupEvent(f, {
        event: { type: "app_uninstalled" },
      }));
      expect((await f.service.get(f.endpoint.id)).status).toBe("revoked");
      await f.service.slackRegistration.complete(await f.install(), "reinstall-code", null, actor);
      const saved = await f.service.get(f.endpoint.id);
      expect(saved).toMatchObject({ status: "verifying", providerAccountId: "TAUTO", botExternalId: f.botId });
      expect(saved.setup.slackRegistration).toMatchObject({ status: "configured", appId: f.appId, errorCode: null });
      expect(saved.setup.slackAccount).toEqual(account);
      const [connection] = await readToolConnectionsById(f.endpoint.connectionId);
      expect(connection).toMatchObject({ status: "active", enabled: true });
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("apps.manifest.create"))).toHaveLength(1);
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(1);
    });
    it("rejects an authorization started before the bot was revoked", async () => {
      const f = await fixture();
      await f.create();
      await f.service.slackRegistration.complete(await f.install(), "first-code", null, actor);
      const state = await f.install();
      const exchanges = f.provider.mock.calls.filter(([url]) => String(url).endsWith("oauth.v2.access")).length;
      await f.service.handleWebhook(f.endpoint.publicId, "slack", setupEvent(f, {
        event: { type: "app_uninstalled" },
      }));
      await expect(f.service.slackRegistration.complete(state, "late-code", null, actor)).rejects.toThrow();
      expect((await f.service.get(f.endpoint.id)).status).toBe("revoked");
      expect(f.provider.mock.calls.filter(([url]) => String(url).endsWith("oauth.v2.access"))).toHaveLength(exchanges);
    });
    it.each(["workspace", "bot"])("rejects changing an established %s during reauthorization", async mismatch => {
      const f = await fixture();
      await f.create();
      await f.service.slackRegistration.complete(await f.install(), "first-code", null, actor);
      if (mismatch === "workspace") f.state.oauth.team.id = "TDIFFERENT";
      else f.state.oauth.bot_user_id = "UDIFFERENT";
      await f.service.slackRegistration.complete(await f.install(), "second-code", null, actor);
      const saved = await f.service.get(f.endpoint.id);
      expect(saved).toMatchObject({ providerAccountId: "TAUTO", botExternalId: f.botId });
      expect(saved.setup.slackRegistration?.errorCode).toBe("slack_install_identity_mismatch");
    });
    it.each(["chat", "connection"])("removes registration secrets and prevents late callbacks after %s removal", async path => {
      const f = await fixture();
      await f.create();
      const state = await f.install();
      const row = (await f.service.slackRegistration.registration(f.endpoint.id))!;
      if (path === "chat") await f.service.configure(f.endpoint.id, { action: "remove" }, actor.userId);
      else await toolAccessService(db).archiveConnection(f.endpoint.connectionId, f.companyId);
      expect((await f.service.slackRegistration.registration(f.endpoint.id))?.secretIds).toEqual({});
      await expect(f.service.slackRegistration.complete(state, "late-code", null, actor)).rejects.toThrow();
      const secrets = await db.select().from(companySecrets).where(inArray(companySecrets.id, Object.values(row.secretIds)));
      expect(secrets.every(secret => secret.status === "deleted")).toBe(true);
      expect((await f.service.get(f.endpoint.id)).setup.slackRegistration?.managementUrl).toContain(f.appId);
      expect(f.provider.mock.calls.some(([url]) => String(url).includes("apps.manifest.delete"))).toBe(false);
    });
  });

  it("persists Slack manifest draft details and the registered command, then locks them once connected", async () => {
    const fixture = await seedCompany();
    const { service } = createService();
    const app = routesApp(db, fixture.companyId, service);
    const endpoint = await service.create(fixture.companyId, { provider: "slack", assignedAgentId: fixture.assignedAgentId });
    const slackApp = { appName: "Research Ops", botName: "research-ops", command: "/research" };
    await request(app).patch(`/api/chat-endpoints/${endpoint.id}`).send({ slackApp }).expect(200);
    expect((await service.get(endpoint.id)).setup).toMatchObject({ slackApp, command: "/research" });
    const [stored] = await readChatEndpointsById(endpoint.id);
    expect(stored.setup.command).toBe("/research");
    await request(app).patch(`/api/chat-endpoints/${endpoint.id}`)
      .send({ slackApp: { ...slackApp, command: "not-a-command" } }).expect(400);
    await db.update(chatEndpoints).set({ status: "verifying" }).where(eq(chatEndpoints.id, endpoint.id));
    await request(app).patch(`/api/chat-endpoints/${endpoint.id}`)
      .send({ slackApp: { ...slackApp, command: "/different" } }).expect(409);
    expect((await service.get(endpoint.id)).setup.command).toBe("/research");
    const github = await service.create(fixture.companyId, { provider: "github", assignedAgentId: fixture.assignedAgentId });
    await request(app).patch(`/api/chat-endpoints/${github.id}`).send({ slackApp }).expect(422);
  });

  it("dispatches and publishes a queued Slack Board send with a one-connection database pool", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup, runtime } = await configuredSlackEndpoint(fixture, { linkedBoardUser: true });
    const channel = makeThread({ channelId: "CPOOL", id: "slack:CPOOL:8300.1", name: "pool" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: channel.thread,
      message: makeMessage({ id: "8300.1", text: "@maya start here", mentioned: true }), trigger: "mention" });
    await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, endpoint.id));
    const [conversation] = await service.listConversations(endpoint.id);
    runtime.endpoints.get(endpoint.id)!.posts.length = 0;
    wakeup.mockRejectedValueOnce(new Error("scheduler unavailable"));
    await service.publishBoardMessage(endpoint.id, conversation.id, "Small pool work", randomUUID(), "owner-user");
    const smallDb = createDb(h.connectionString, { maxConnections: 1 });
    try {
      const smallWake = vi.fn(async () => ({ accepted: true }));
      const worker = chatChannelService(smallDb, {
        fetch: fakeSlackFetch() as typeof fetch,
        heartbeat: { wakeup: smallWake },
        publicBaseUrl: "https://paperclip.example",
        runtime: runtime as unknown as ChatSdkRuntime,
      });
      fixtureServices.add(worker);
      await worker.processPendingDeliveries();
      await worker.processPendingPublications();
      expect(smallWake).toHaveBeenCalledTimes(1);
      expect(runtime.endpoints.get(endpoint.id)!.posts.map(post => post.text)).toEqual(["**Owner User (via Paperclip)**\n\nSmall pool work"]);
    } finally {
      await smallDb.$client.end();
    }
  }, 15_000);

  it("does not let two live agent connections claim the same native bot or spoof its verified identity", async () => {
    const fixture = await seedCompany();
    const { service } = createService(
      new FakeChatSdkRuntime(),
      fakeSlackFetch("U-ONE-NATIVE-BOT") as typeof globalThis.fetch,
    );
    const first = await service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );
    const second = await service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.replacementAgentId,
      },
      "owner-user",
    );
    await service.configure(
      first.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-first-agent",
          signingSecret: "first-signing-secret",
        },
      },
      "owner-user",
    );
    await expect(
      service.configure(
        second.id,
        {
          action: "configure",
          credentials: {
            botToken: "xoxb-second-agent",
            signingSecret: "second-signing-secret",
          },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "chat_bot_identity_in_use",
        endpointId: first.id,
        assignedAgentId: fixture.assignedAgentId,
      },
    });

    const app = routesApp(db, fixture.companyId, service);
    await request(app)
      .post(`/api/chat-endpoints/${second.id}/setup`)
      .send({
        action: "configure",
        providerAccountId: "T-SPOOFED",
        botExternalId: "U-SPOOFED",
        credentials: {
          botToken: "xoxb-spoof",
          signingSecret: "spoof-signing-secret",
        },
      })
      .expect(400);
  });

  it("discovers a Slack connect identity without starting work or granting access", async () => {
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } = await configuredSlackEndpoint(fixture, { allowUnlinkedPeople: false });
    const post = vi.fn();
    const postEphemeral = vi.fn(async () => ({ id: "connect-notice", usedFallback: false }));
    const event = {
      endpointId: endpoint.id, provider: "slack" as const,
      event: {
        channel: { id: "C-CONNECT", isDM: false, post, postEphemeral } as never,
        command: endpoint.setup.command!, text: "connect", triggerId: "connect-discovery-1",
        user: { userId: "U-CONNECT", userName: "connector", fullName: "Connect Person", isBot: false, isMe: false, isSystem: false },
        raw: { trigger_id: "connect-discovery-1" }, adapter: {} as never, openModal: async () => undefined,
      },
    };
    await callbacks.onSlashCommand!(event);
    await callbacks.onSlashCommand!(event);
    await vi.waitFor(() => expect(postEphemeral).toHaveBeenCalledTimes(1));
    const [identity] = await service.listPrincipals(endpoint.id);
    expect(identity).toMatchObject({ externalLabel: "Connect Person", status: "pending", paperclipUserId: null, lastConnectAt: expect.any(String) });
    expect(await service.listConversations(endpoint.id)).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(await db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "slack_connect")))).toHaveLength(1);
    expect(await db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "slash_task_start")))).toHaveLength(0);
    const other = await service.create(fixture.companyId, { provider: "slack", assignedAgentId: fixture.assignedAgentId }, "owner-user");
    await db.update(chatEndpoints).set({ status: "verifying", providerAccountId: (await service.get(endpoint.id)).providerAccountId }).where(eq(chatEndpoints.id, other.id));
    expect((await service.listPrincipals(other.id))[0]?.lastConnectAt).toBeNull();
    const notice = String((postEphemeral.mock.calls[0] as unknown[])[1]);
    const token = /token=([A-Za-z0-9_-]+)/.exec(notice)![1];
    expect(notice).toContain("Connect your Paperclip account");
    expect((postEphemeral.mock.calls[0] as unknown[])[2]).toEqual({ fallbackToDM: false });
    expect(await service.previewIdentityLink(token, "owner-user")).toMatchObject({ selfService: true, canConfirm: true, externalLabel: "Connect Person" });
    expect(await service.setupTestStatus(endpoint.id, "owner-user")).toEqual({ messageReceivedAt: null });
    await expect(service.finishSlackSetup(endpoint.id, "owner-user")).rejects.toMatchObject({ status: 403 });
    const outsiderId = `outsider-${fixture.companyId}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: outsiderId, name: "Outside Person", email: `${outsiderId}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
    const outsideApp = routesApp(db, randomUUID(), service, outsiderId);
    expect((await request(outsideApp).get(`/api/chat-identity-links/preview?token=${token}`)).body).toMatchObject({ selfService: true, canConfirm: false });
    await expect(service.confirmIdentityLink(token, outsiderId)).rejects.toMatchObject({ status: 403 });
    await request(outsideApp).post("/api/chat-identity-links/confirm").send({ token }).expect(403);
    expect((await request(outsideApp).post("/api/chat-identity-links/request-access").send({ token })).body).toMatchObject({ status: "pending_approval" });
    await service.requestIdentityAccess(token, outsiderId, "test");
    expect(await db.select().from(joinRequests).where(eq(joinRequests.companyId, fixture.companyId))).toHaveLength(1);
    expect(await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, fixture.companyId), eq(companyMemberships.principalId, outsiderId)))).toHaveLength(0);
    const adminOnly = await service.createLinkIntent(other.id, identity.principalId, 600);
    const adminToken = new URL(adminOnly.confirmationUrl).searchParams.get("token")!;
    expect((await request(outsideApp).get(`/api/chat-identity-links/preview?token=${adminToken}`)).status).toBe(404);
    await expect(service.requestIdentityAccess(adminToken, outsiderId, "test")).rejects.toMatchObject({ status: 403 });
    const providerRuntime = runtime.endpoints.get(endpoint.id)!;
    const originalThread = providerRuntime.thread.bind(providerRuntime);
    const confirmationNotice = vi.fn(async () => ({ id: "linked-notice", threadId: "C-CONNECT" }));
    providerRuntime.thread = (id: string) => ({ ...originalThread(id), postEphemeral: confirmationNotice });
    await service.confirmIdentityLink(token, "owner-user");
    await vi.waitFor(() => expect(confirmationNotice).toHaveBeenCalledWith("U-CONNECT", expect.stringContaining("account is connected"), { fallbackToDM: false }));
    expect((await service.listPrincipals(endpoint.id))[0]).toMatchObject({ status: "linked", paperclipUserId: "owner-user" });
    await expect(service.test(endpoint.id)).rejects.toMatchObject({ details: { code: "chat_test_follow_up_missing" } });
    await expect(service.confirmIdentityLink(token, "owner-user")).rejects.toMatchObject({ status: 422 });
    await request(outsideApp).post("/api/chat-identity-links/request-access").send({ token }).expect(422);
    expect(await service.setupTestStatus(endpoint.id, "owner-user")).toEqual({ messageReceivedAt: null });
    const finished = await service.finishSlackSetup(endpoint.id, "owner-user");
    expect(finished).toMatchObject({ status: "active", setup: { step: "complete", testSkipped: true } });
    expect(wakeup).not.toHaveBeenCalled();
  });
});
