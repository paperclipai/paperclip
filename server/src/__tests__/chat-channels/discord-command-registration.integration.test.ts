import { nativeChatProgressWork } from "../../services/chat-native-progress-work.js";
import { cloudActorHeaderSourceFromHeaders, resolveCloudTenantActor } from "../../middleware/auth.js";
import { cloudTenantPrimaryCompanyId } from "../../services/cloud-instance.js";
import { accessService } from "../../services/access.js";
import { subscribeDatabaseWork } from "@paperclipai/db";
import { notifyChatEndpointConfiguration, notifyChatCompanyConfiguration } from "../../services/chat-channels/configuration-work-notifications.js";
import { configureAgentLifecycle } from "../../services/agent-lifecycle.js";
import { deleteCompany } from "../../services/company-deletion.js";
import { conflict } from "../../errors.js";
import { idleWorkSnapshot } from "../../services/task-admission.js";
import { chatRunMilestoneWork } from "../../services/chat-run-milestone-work.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../../services/delivery-work-notifications.js";
import { toolAccessService } from "../../services/tool-access.js";
import { createHash, randomUUID } from "node:crypto";
import { type Server } from "node:http";
import path from "node:path";
import request from "supertest";
import { and, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, activityLog, authUsers, chatActions, chatConversations, chatDeliveries, chatDiscordCommandOwners, chatEndpointLeases, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatPublications, companySecrets, companyMemberships, heartbeatRunEvents, heartbeatRuns, issueComments, issues, toolConnections } from "@paperclipai/db";
import type { Message, Thread } from "chat";
import { type ChatChannelServiceOptions, type ChatChannelService } from "../../services/chat-channels.js";
import type { InternalSetupState } from "../../services/chat-channels/runtime-types.js";
import { createChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { createDiscordAdapter } from "@chat-adapter/discord";
import { issueService } from "../../services/issues.js";
import { enqueueChatRunMilestones, resolveChatRunPresentationAuthorizationReason } from "../../services/chat-run-publications.js";
import { type TestDb, describeEmbeddedPostgres, FakeChatSdkRuntime, uniqueDiscordApplicationId, fakeDiscordFetch, makeThread, makeMessage } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";

describeEmbeddedPostgres("chat channels: discord command registration", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const { seedCompany, readChatEndpointsById, readChatConversationsById, readChatPublicationsByCommentId, readChatActionsByProviderActionId, createService, retirePublicationFixture, chatWakeContext, addSelectedChatFinal, qualifySetupRoundTrip, configuredDiscordEndpoint, recoverDiscordCommands, deliverMessage, waitForProcessedReceiptRemoval } = h;

  describe("Discord automatic command registration", () => {
    async function retireRegistrationFixture(
      service: ChatChannelService,
      endpointId: string,
    ) {
      try {
        const owners = await db
          .select()
          .from(chatDiscordCommandOwners)
          .where(eq(chatDiscordCommandOwners.endpointId, endpointId));
        if ((await service.get(endpointId))?.status !== "archived") {
          await service.configure(endpointId, { action: "remove" }, "owner-user");
        }
        expect((await service.get(endpointId))?.status).toBe("archived");
        // Removal retires only this fixture's runtime; immutable application
        // ownership stays available to the no-adoption/tombstone checks.
        expect(
          await db
            .select()
            .from(chatDiscordCommandOwners)
            .where(eq(chatDiscordCommandOwners.endpointId, endpointId)),
        ).toEqual(owners);
      } finally {
        await service.shutdown();
      }
    }

    async function registrationFixture(
      mode: "success" | "unavailable" | "unknown" = "success",
      receiverOptions: Partial<Pick<ChatChannelServiceOptions, "discordGatewayLeaseTtlMs" | "discordGatewayLeaseRenewalIntervalMs">> = {},
    ) {
      const fixture = await seedCompany();
      const applicationId = uniqueDiscordApplicationId();
      const guildId = "1457808928258658549";
      const baseFetch = fakeDiscordFetch(applicationId);
      const commandUrl = `https://discord.com/api/v10/applications/${applicationId}/commands`;
      let commands: Record<string, unknown>[] = [
        {
          id: "888888888888888881",
          application_id: applicationId,
          version: "888888888888888882",
          type: 1,
          name: "other",
          description: "Existing application command",
        },
      ];
      let unavailable = mode === "unavailable";
      let endpointId: string;
      const calls: string[] = [];
      const providerFetch = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input) !== commandUrl) return baseFetch(input);
          const method = init?.method ?? "GET";
          calls.push(method);
          if (method === "GET")
            return Response.json(commands, { status: unavailable ? 503 : 200 });
          expect(method).toBe("POST");
          const [intent] = await db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, endpointId),
                eq(chatActions.kind, "discord_command_registration"),
              ),
            );
          expect(intent?.payload.registration).toMatchObject({
            phase: "attempted",
            scope: { applicationId, guildId },
          });
          expect(intent?.status).not.toBe("processed");
          const definition = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          const command = {
            ...definition,
            id: "888888888888888883",
            application_id: applicationId,
            version: "888888888888888884",
          };
          commands = [...commands, command];
          if (mode === "unknown")
            throw new Error("private registration transport failure");
          return Response.json(command);
        },
      ) as unknown as typeof globalThis.fetch;
      const context = createService(new FakeChatSdkRuntime(), providerFetch, receiverOptions);
      const endpoint = await context.service.create(
        fixture.companyId,
        {
          provider: "discord",
          assignedAgentId: fixture.assignedAgentId,
          name: "Discord command registration",
        },
        "owner-user",
      );
      endpointId = endpoint.id;
      const credentials = {
        applicationId,
        guildId,
        botToken: "discord-registration-private-token",
      };
      const configure = () =>
        context.service.configure(
          endpointId,
          { action: "configure", credentials },
          "owner-user",
        );
      const makeDue = () =>
        db
          .update(chatActions)
          .set({
            result: sql`${chatActions.result} || '{"retryAt":"2000-01-01T00:00:00.000Z"}'::jsonb`,
          })
          .where(
            and(
              eq(chatActions.endpointId, endpointId),
              eq(chatActions.kind, "discord_command_registration"),
            ),
          );
      return {
        ...context,
        fixture,
        endpoint,
        credentials,
        calls,
        providerFetch,
        configure,
        makeDue,
        available: (value = true) => {
          unavailable = !value;
        },
        commandRows: () => commands,
        replaceCommands: (next: Record<string, unknown>[]) => {
          commands = next;
        },
      };
    }

    it("drives receiver discovery through real configure, rotation, pause, and resume producers", async () => {
      const f = await registrationFixture("success", { discordGatewayLeaseTtlMs: 600_000, discordGatewayLeaseRenewalIntervalMs: 300_000 });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
      const onError = vi.fn();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
      const settle = async () => vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(idleWorkSnapshot().active).toBe(0);
        expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      const quiet = async () => {
        const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
        try {
          await vi.advanceTimersByTimeAsync(20_000);
          expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
        } finally { reads.mockRestore(); writes.mockRestore(); }
      };
      try {
        await f.service.registerReceiverWork(coordinator, () => true).ready;
        await settle(); await quiet();
        await f.configure(); await settle();
        const first = f.runtime.get(f.endpoint.id); expect(first).not.toBeNull();
        await quiet();
        await f.service.configure(f.endpoint.id, { action: "reconnect", credentials: { ...f.credentials, botToken: "rotated-receiver-token" } }, "owner-user");
        await settle(); expect(f.runtime.get(f.endpoint.id)).not.toBe(first); expect(first!.shutdown).toHaveBeenCalledOnce();
        // Pause requires completed onboarding; configure/reconnect intentionally
        // leave this fixture waiting for its first test conversation.
        const configured = await f.service.get(f.endpoint.id);
        await db.update(chatEndpoints).set({ status: "active", setup: { ...configured.setup, step: "complete" } })
          .where(eq(chatEndpoints.id, f.endpoint.id));
        await f.service.configure(f.endpoint.id, { action: "pause" }, "owner-user");
        await settle(); expect(f.runtime.get(f.endpoint.id)).toBeNull(); await quiet();
        await f.service.configure(f.endpoint.id, { action: "resume" }, "owner-user");
        await settle(); expect(f.runtime.get(f.endpoint.id)).not.toBeNull(); await quiet();
        await f.service.configure(f.endpoint.id, { action: "remove" }, "owner-user");
        await settle(); expect(f.runtime.get(f.endpoint.id)).toBeNull(); await quiet();
        expect(onError).not.toHaveBeenCalled();
      } finally {
        await coordinator.stop(); await f.service.shutdown(); vi.useRealTimers();
        await retireRegistrationFixture(f.service, f.endpoint.id);
      }
    });

    it("does not rediscover a receiver stopped by a company removal refresh", async () => {
      const f = await registrationFixture("success", { discordGatewayLeaseTtlMs: 600_000, discordGatewayLeaseRenewalIntervalMs: 300_000 });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
      const onError = vi.fn(), coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
      let reads: ReturnType<typeof vi.spyOn> | undefined;
      try {
        await f.configure(); await f.service.registerReceiverWork(coordinator, () => true).ready;
        await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull(); });
        const owned = f.runtime.get(f.endpoint.id)!;
        reads = vi.spyOn(db, "select");
        await db.transaction(async tx => {
          await notifyChatCompanyConfiguration(tx, f.fixture.companyId);
          await tx.delete(chatEndpoints).where(eq(chatEndpoints.id, f.endpoint.id));
        });
        await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull(); });
        expect(owned.shutdown).toHaveBeenCalledOnce();
        expect(reads).toHaveBeenCalledOnce(); expect(onError).not.toHaveBeenCalled();
      } finally {
        reads?.mockRestore(); await coordinator.stop(); vi.useRealTimers(); await f.service.shutdown();
        await db.update(chatEndpoints).set({ status: "archived" }).where(eq(chatEndpoints.id, f.endpoint.id));
      }
    });

    it("takes over a persisted foreign receiver lease at its deadline through the worker", async () => {
      const f = await registrationFixture();
      await f.configure(); await f.service.shutdown();
      const token = randomUUID(), expiresAt = new Date(Date.now() + 500);
      await db.insert(chatEndpointLeases).values({ companyId: f.fixture.companyId, endpointId: f.endpoint.id,
        leaseKey: "discord_gateway_runtime", token, expiresAt });
      const standby = createService(new FakeChatSdkRuntime(), f.providerFetch);
      const onError = vi.fn();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
      try {
        await standby.service.registerReceiverWork(coordinator, () => true).ready;
        expect(standby.runtime.get(f.endpoint.id)).toBeNull();
        expect(coordinator.nextWakeAt()).toBeGreaterThanOrEqual(expiresAt.getTime());
        await vi.waitFor(() => expect(standby.runtime.get(f.endpoint.id)).not.toBeNull(), { timeout: 5000 });
        const [lease] = await db.select().from(chatEndpointLeases).where(eq(chatEndpointLeases.endpointId, f.endpoint.id));
        expect(lease.token).not.toBe(token);
        expect(lease.expiresAt.getTime()).toBeGreaterThan(expiresAt.getTime());
        expect(onError).not.toHaveBeenCalled();
      } finally {
        await coordinator.stop(); await retireRegistrationFixture(standby.service, f.endpoint.id);
      }
    });

    it.each(["owned", "foreign-token", "paused", "credential-change", "foreign-company"])("fences receiver construction across renewal: %s", async fault => {
      const f = await registrationFixture("success", { discordGatewayLeaseTtlMs: 60_000, discordGatewayLeaseRenewalIntervalMs: fault === "slow-renewal" || fault === "foreign-token-before-renewal" ? 5000 : 50 });
      const listenerStarted = vi.fn(async () => {});
      f.runtime.initializeHook = listenerStarted;
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const constructing = new Promise<void>(resolve => { entered = resolve; });
      const replace = f.runtime.replaceEndpoint.bind(f.runtime);
      const replacement = vi.spyOn(f.runtime, "replaceEndpoint").mockImplementation(async options => {
        entered(); await gate; return replace(options);
      });
      const configured = f.configure().then(value => ({ value }), error => ({ error }));
      const foreignToken = randomUUID();
      let shutdown: Promise<void> | undefined;
      try {
        await constructing;
        if (fault === "lost-token") await db.delete(chatEndpointLeases).where(and(eq(chatEndpointLeases.endpointId, f.endpoint.id), eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime")));
        if (fault === "foreign-token" || fault === "foreign-token-before-renewal") await db.update(chatEndpointLeases).set({ token: foreignToken }).where(and(eq(chatEndpointLeases.endpointId, f.endpoint.id), eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime")));
        if (fault === "paused") await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, f.endpoint.id));
        if (fault === "removed") await db.delete(chatEndpoints).where(eq(chatEndpoints.id, f.endpoint.id));
        if (fault === "replacement") await db.update(chatEndpoints).set({ setup: sql`${chatEndpoints.setup} || jsonb_build_object('runtimeGeneration', (${chatEndpoints.setup}->>'runtimeGeneration')::integer + 1)` }).where(eq(chatEndpoints.id, f.endpoint.id));
        if (fault === "foreign-company") {
          const foreign = await seedCompany();
          await expect(db.update(chatEndpoints).set({ companyId: foreign.companyId }).where(eq(chatEndpoints.id, f.endpoint.id)))
            .rejects.toMatchObject({ cause: { code: "23503" } });
        }
        if (fault === "credential-change") await db.update(toolConnections).set({ credentialSecretRefs: [] }).where(eq(toolConnections.id, f.endpoint.connectionId));
        if (fault === "shutdown") shutdown = f.service.shutdown();
        await new Promise(resolve => setTimeout(resolve, 200));
        release();
        const result = await configured;
        const [lease] = await db.select().from(chatEndpointLeases).where(and(eq(chatEndpointLeases.endpointId, f.endpoint.id), eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime")));
        if (fault === "owned" || fault === "slow-renewal" || fault === "foreign-company") {
          expect(result).not.toHaveProperty("error");
          expect(listenerStarted).toHaveBeenCalledOnce();
          expect(f.runtime.get(f.endpoint.id)).not.toBeNull();
          expect(lease).toBeDefined();
        } else {
          expect(result).toHaveProperty("error");
          expect(listenerStarted).not.toHaveBeenCalled();
          expect(f.runtime.get(f.endpoint.id)).toBeNull();
          if (fault === "foreign-token" || fault === "foreign-token-before-renewal") expect(lease?.token).toBe(foreignToken);
          else expect(lease).toBeUndefined();
        }
      } finally {
        release(); await configured; await shutdown; replacement.mockRestore();
        if (fault === "removed") await f.service.shutdown();
        else await retireRegistrationFixture(f.service, f.endpoint.id);
      }
    });

    it("rechecks durable ownership after an earlier renewal finishes before listener start", async () => {
      const f = await registrationFixture("success", { discordGatewayLeaseTtlMs: 60_000, discordGatewayLeaseRenewalIntervalMs: 50 });
      const listenerStarted = vi.fn(async () => {}); f.runtime.initializeHook = listenerStarted;
      let releaseConstruction!: () => void, constructionEntered!: () => void, releaseRenewal!: () => void, renewalEntered!: () => void;
      const construction = new Promise<void>(resolve => { releaseConstruction = resolve; });
      const enteredConstruction = new Promise<void>(resolve => { constructionEntered = resolve; });
      const renewal = new Promise<void>(resolve => { releaseRenewal = resolve; });
      const enteredRenewal = new Promise<void>(resolve => { renewalEntered = resolve; });
      let constructionPending = false;
      const replace = f.runtime.replaceEndpoint.bind(f.runtime);
      const replacement = vi.spyOn(f.runtime, "replaceEndpoint").mockImplementation(async options => {
        constructionPending = true; constructionEntered(); await construction; return replace(options);
      });
      let gated = false;
      const transact = db.transaction.bind(db);
      const transaction = vi.spyOn(db, "transaction").mockImplementation((async (...args: Parameters<typeof db.transaction>) => {
        const result = await transact(...args);
        if (result === true && constructionPending && !gated) { gated = true; renewalEntered(); await renewal; }
        return result;
      }) as typeof db.transaction);
      const configured = f.configure().then(value => ({ value }), error => ({ error }));
      const foreignToken = randomUUID();
      try {
        await enteredConstruction; await enteredRenewal;
        await db.update(chatEndpointLeases).set({ token: foreignToken }).where(and(eq(chatEndpointLeases.endpointId, f.endpoint.id), eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime")));
        releaseConstruction();
        await vi.waitFor(() => expect(f.runtime.get(f.endpoint.id)).not.toBeNull());
        releaseRenewal();
        expect(await configured).toHaveProperty("error");
        expect(listenerStarted).not.toHaveBeenCalled();
        const [lease] = await db.select().from(chatEndpointLeases).where(and(eq(chatEndpointLeases.endpointId, f.endpoint.id), eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime")));
        expect(lease?.token).toBe(foreignToken);
      } finally {
        releaseConstruction(); releaseRenewal(); await configured; transaction.mockRestore(); replacement.mockRestore();
        await retireRegistrationFixture(f.service, f.endpoint.id);
      }
    });

    it("restarts a receiver after token loss only after the old listener has stopped", async () => {
      const f = await registrationFixture("success", { discordGatewayLeaseTtlMs: 60_000, discordGatewayLeaseRenewalIntervalMs: 50 });
      const onError = vi.fn();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
      let release!: () => void;
      const stopped = new Promise<void>(resolve => { release = resolve; });
      try {
        await f.configure();
        await f.service.registerReceiverWork(coordinator, () => true).ready;
        const old = f.runtime.get(f.endpoint.id)!;
        old.shutdown.mockImplementation(async () => { await stopped; });
        await db.delete(chatEndpointLeases).where(eq(chatEndpointLeases.endpointId, f.endpoint.id));
        await vi.waitFor(() => expect(old.shutdown).toHaveBeenCalledOnce());
        await db.transaction(tx => notifyChatEndpointConfiguration(tx, f.endpoint));
        await new Promise(resolve => setTimeout(resolve, 250));
        expect(f.runtime.get(f.endpoint.id)).toBeNull();
        release();
        await vi.waitFor(async () => {
          expect(f.runtime.get(f.endpoint.id)).not.toBeNull();
          expect(f.runtime.get(f.endpoint.id)).not.toBe(old);
          expect(idleWorkSnapshot().active).toBe(0);
          expect(coordinator.nextWakeAt()).toBeNull();
        });
        expect(onError).not.toHaveBeenCalled();
      } finally {
        release(); await coordinator.stop(); vi.useRealTimers();
        await retireRegistrationFixture(f.service, f.endpoint.id);
      }
    });

    it("learns the first configured command and cancels its deadline when the endpoint is removed", async () => {
      const f = await registrationFixture();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const onError = vi.fn();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
      try {
        await f.service.registerCommandWork(coordinator, () => true).ready;
        expect(coordinator.nextWakeAt()).toBeNull();
        await f.configure();
        expect(f.calls).toEqual(["GET", "POST"]);
        await vi.advanceTimersByTimeAsync(31_000);
        await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeGreaterThan(Date.now()));
        const deadline = coordinator.nextWakeAt();
        expect(deadline).toBeGreaterThan(Date.now() + 200_000);
        await f.service.configure(f.endpoint.id, { action: "remove" }, "owner-user");
        await vi.advanceTimersByTimeAsync(31_000);
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(1000);
          expect(idleWorkSnapshot().active).toBe(0);
          expect(coordinator.nextWakeAt()).toBeNull();
        });
        const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
        try {
          await vi.advanceTimersByTimeAsync(120_000);
          expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
        } finally { reads.mockRestore(); writes.mockRestore(); }
        expect(f.calls).toEqual(["GET", "POST"]);
        expect(onError).not.toHaveBeenCalled();
      } finally {
        await coordinator.stop(); vi.useRealTimers();
        await retireRegistrationFixture(f.service, f.endpoint.id);
      }
    });

    it.each(["credential rotation", "company deletion"] as const)("updates scheduled registration after real %s", async (mutation) => {
      const f = await registrationFixture();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const onError = vi.fn();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
      let deleted = false;
      let lifecycle: ReturnType<typeof configureAgentLifecycle> | undefined;
      try {
        await f.service.registerCommandWork(coordinator, () => true).ready;
        await f.configure();
        await vi.advanceTimersByTimeAsync(31_000);
        await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeGreaterThan(Date.now()));
        const before = coordinator.nextWakeAt()!;
        const owners = await db.select().from(chatDiscordCommandOwners)
          .where(eq(chatDiscordCommandOwners.endpointId, f.endpoint.id));
        if (mutation === "credential rotation") {
          await f.service.configure(f.endpoint.id, {
            action: "reconnect", credentials: { ...f.credentials, botToken: "discord-rotated-secret" },
          }, "owner-user");
          const [saved] = await db.select().from(chatActions).where(and(
            eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "discord_command_registration"),
          ));
          const expected = Date.parse(String(saved.result!.retryAt));
          expect(expected).toBeGreaterThan(before);
          await vi.advanceTimersByTimeAsync(31_000);
          await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBe(expected));
          expect(f.calls).toEqual(["GET", "POST", "GET"]);
        } else {
          lifecycle = configureAgentLifecycle(db, {
            requiredPluginIds: async () => [], runHost: async () => "complete", runPlugin: async () => "complete",
          });
          await deleteCompany(db, f.fixture.companyId);
          deleted = true;
          await vi.advanceTimersByTimeAsync(31_000);
          await vi.waitFor(async () => {
            await vi.advanceTimersByTimeAsync(1000);
            expect(idleWorkSnapshot().active).toBe(0);
            expect(coordinator.nextWakeAt()).toBeNull();
          });
          expect(await db.select().from(chatDiscordCommandOwners)
            .where(eq(chatDiscordCommandOwners.endpointId, f.endpoint.id))).toEqual(owners);
          await f.service.shutdown();
          const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
          try {
            await vi.advanceTimersByTimeAsync(120_000);
            expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
          } finally { reads.mockRestore(); writes.mockRestore(); }
          expect(f.calls).toEqual(["GET", "POST"]);
        }
        expect(onError).not.toHaveBeenCalled();
      } finally {
        await lifecycle?.stop();
        await coordinator.stop(); vi.useRealTimers();
        if (deleted) await f.service.shutdown();
        else await retireRegistrationFixture(f.service, f.endpoint.id);
      }
    });

    it("keeps mention setup usable on registration failure and upgrades automatically when due", async () => {
      const f = await registrationFixture("unavailable");
      try {
        await f.configure();
        expect((await f.service.get(f.endpoint.id))?.status).toBe("verifying");
        expect(
          (await f.service.get(f.endpoint.id))?.capabilities.slashCommands,
        ).toBe(false);
        expect(
          f.runtime.configurations.get(f.endpoint.id)?.callbacks.onSlashCommand,
        ).toBeTypeOf("function");
        f.available();
        await f.makeDue();
        await recoverDiscordCommands(f.service);
        expect(
          (await f.service.get(f.endpoint.id))?.capabilities.slashCommands,
        ).toBe(true);
        expect(
          f.runtime.configurations.get(f.endpoint.id)?.callbacks.onSlashCommand,
        ).toBeTypeOf("function");
        expect(f.calls).toEqual(["GET", "GET", "POST"]);
      } finally {
        await retireRegistrationFixture(f.service, f.endpoint.id);
      }
    });

    it("reconstructs an uncertain registration by GET without repeating the provider write", async () => {
      const f = await registrationFixture("unknown");
      let restarted: ReturnType<typeof createService> | undefined;
      try {
        await f.configure();
        expect(
          (await f.service.get(f.endpoint.id))?.capabilities.slashCommands,
        ).toBe(false);
        expect(
          f.runtime.configurations.get(f.endpoint.id)?.callbacks.onSlashCommand,
        ).toBeTypeOf("function");
        await f.service.shutdown();
        await f.makeDue();
        restarted = createService(new FakeChatSdkRuntime(), f.providerFetch);
        await restarted.service.reconcileProviderRuntimes();
        await recoverDiscordCommands(restarted.service);
        expect(
          (await restarted.service.get(f.endpoint.id))?.capabilities
            .slashCommands,
        ).toBe(true);
        expect(
          restarted.runtime.configurations.get(f.endpoint.id)?.callbacks
            .onSlashCommand,
        ).toBeTypeOf("function");
        expect(f.calls).toEqual(["GET", "POST", "GET"]);
      } finally {
        try {
          await retireRegistrationFixture(
            restarted?.service ?? f.service,
            f.endpoint.id,
          );
        } finally {
          await f.service.shutdown();
        }
      }
    });

    it("preserves a healthy Discord Gateway when a due command refresh returns 503", async () => {
      const f = await registrationFixture();
      try {
        await f.configure();
        const original = f.runtime.endpoints.get(f.endpoint.id);
        expect(original).toBeDefined();
        const originalCallbacks = f.runtime.configurations.get(
          f.endpoint.id,
        )!.callbacks;
        expect(originalCallbacks.onMessage).toBeTypeOf("function");
        expect(originalCallbacks.onSlashCommand).toBeTypeOf("function");
        const connected = await f.service.get(f.endpoint.id);
        expect(connected?.capabilities).toMatchObject({
          slashCommands: true,
          ephemeralMessages: true,
        });
        expect(
          f.runtime.configurations.get(f.endpoint.id)?.callbacks.onSlashCommand,
        ).toBeTypeOf("function");
        expect(f.calls).toEqual(["GET", "POST"]);
        expect(f.commandRows().map((row) => row.name)).toEqual([
          "other",
          "paperclip",
        ]);
        const [registration] = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, f.endpoint.id),
              eq(chatActions.kind, "discord_command_registration"),
            ),
          );
        expect(registration?.status).toBe("processed");
        expect(registration?.payload.registration).toMatchObject({
          phase: "registered",
        });
        expect(JSON.stringify(registration)).not.toContain(
          f.credentials.botToken,
        );
        await f.service.reconcileProviderRuntimes();
        expect(f.calls).toEqual(["GET", "POST"]);
        const shutdown = vi.spyOn(original!, "shutdown");
        const targetRestart = vi.fn(async () => {
          throw new Error(
            "Healthy Gateway must not restart for command maintenance",
          );
        });
        f.runtime.initializeHook = async (endpointId) => {
          if (endpointId === f.endpoint.id) await targetRestart();
        };
        f.available(false);
        await f.makeDue();
        await recoverDiscordCommands(f.service);
        expect(f.runtime.endpoints.get(f.endpoint.id)).toBe(original);
        expect(f.runtime.configurations.get(f.endpoint.id)?.callbacks).toBe(
          originalCallbacks,
        );
        expect(shutdown).not.toHaveBeenCalled();
        expect(targetRestart).not.toHaveBeenCalled();
        expect(
          (await f.service.get(f.endpoint.id))?.capabilities,
        ).toMatchObject({ slashCommands: false, ephemeralMessages: false });
        expect(f.calls).toEqual(["GET", "POST", "GET"]);
        await f.service.reconcileProviderRuntimes();
        expect(f.calls).toEqual(["GET", "POST", "GET"]);
        expect(f.runtime.endpoints.get(f.endpoint.id)).toBe(original);
        expect(shutdown).not.toHaveBeenCalled();
        expect(targetRestart).not.toHaveBeenCalled();
      } finally {
        await retireRegistrationFixture(f.service, f.endpoint.id);
      }
    });

    it("retains the Gateway after an external command namespace conflict without overwriting it", async () => {
      const f = await registrationFixture();
      try {
        await f.configure();
        const original = f.runtime.endpoints.get(f.endpoint.id);
        expect(original).toBeDefined();
        const callbacks = f.runtime.configurations.get(
          f.endpoint.id,
        )!.callbacks;
        const shutdown = vi.spyOn(original!, "shutdown");
        f.replaceCommands(
          f
            .commandRows()
            .map((command) =>
              command.name === "paperclip"
                ? { ...command, description: "Owned by another integration" }
                : command,
            ),
        );
        await f.makeDue();
        await recoverDiscordCommands(f.service);
        expect(
          (await f.service.get(f.endpoint.id))?.capabilities.slashCommands,
        ).toBe(false);
        expect(f.runtime.endpoints.get(f.endpoint.id)).toBe(original);
        expect(f.runtime.configurations.get(f.endpoint.id)?.callbacks).toBe(
          callbacks,
        );
        expect(callbacks.onMessage).toBeTypeOf("function");
        expect(callbacks.onSlashCommand).toBeTypeOf("function");
        expect(shutdown).not.toHaveBeenCalled();
        expect(f.calls).toEqual(["GET", "POST", "GET"]);
        expect(f.commandRows()[1]?.description).toBe(
          "Owned by another integration",
        );
      } finally {
        await retireRegistrationFixture(f.service, f.endpoint.id);
      }
    });
  });
});
