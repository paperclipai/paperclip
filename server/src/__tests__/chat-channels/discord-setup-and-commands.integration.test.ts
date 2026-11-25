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

describeEmbeddedPostgres("chat channels: discord setup and commands", () => {
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

  it("rehydrates one Discord Gateway owner on startup and hands off cleanly across replicas", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    const guildId = "1457808928258658549";
    const providerFetch = fakeDiscordFetch(
      applicationId,
      guildId,
    ) as typeof globalThis.fetch;
    const ownerRuntime = new FakeChatSdkRuntime();
    const owner = createService(ownerRuntime, providerFetch);
    const endpoint = await owner.service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await owner.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          applicationId,
          botToken: "discord-secret",
          guildId,
        },
      },
      "owner-user",
    );
    expect(
      ownerRuntime.configurations.get(endpoint.id)?.enableDiscordGateway,
    ).toBe(true);

    const standbyRuntime = new FakeChatSdkRuntime();
    const standby = createService(standbyRuntime, providerFetch);
    await expect(standby.service.reconcileProviderRuntimes()).resolves.toEqual({
      eligible: 1,
      local: 0,
      ownedElsewhere: 1,
      failed: 0,
    });
    expect(standbyRuntime.endpoints.has(endpoint.id)).toBe(false);
    await expect(
      db
        .select({ token: chatEndpointLeases.token })
        .from(chatEndpointLeases)
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
          ),
        ),
    ).resolves.toHaveLength(1);

    const firstRuntime = ownerRuntime.endpoints.get(endpoint.id);
    await owner.service.shutdown();
    expect(firstRuntime?.shutdown).toHaveBeenCalledOnce();
    const reconciled = await standby.service.reconcileProviderRuntimes();
    // Earlier integration cases intentionally leave durable active endpoints
    // behind in this shared database. A fresh standby must recover all
    // currently unowned Discord gateways, including this test's endpoint.
    expect(reconciled).toMatchObject({ ownedElsewhere: 0, failed: 0 });
    expect(reconciled.local).toBe(reconciled.eligible);
    expect(reconciled.local).toBeGreaterThanOrEqual(1);
    expect(
      standbyRuntime.configurations.get(endpoint.id)?.enableDiscordGateway,
    ).toBe(true);
    await standby.service.shutdown();
    await expect(
      db
        .select({ token: chatEndpointLeases.token })
        .from(chatEndpointLeases)
        .where(eq(chatEndpointLeases.endpointId, endpoint.id)),
    ).resolves.toEqual([]);
  });

  it("recovers buffered Discord messages and reactions after an unreclaimed host-pause lease expiry", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredDiscordEndpoint(fixture, {
        discordGatewayLeaseRenewalIntervalMs: 60_000,
        discordGatewayLeaseTtlMs: 200,
      });
    const ownedRuntime = runtime.endpoints.get(endpoint.id);
    if (!ownedRuntime)
      throw new Error("Expected Discord Gateway owner runtime");
    const [leaseBeforePause] = await db
      .select({ token: chatEndpointLeases.token })
      .from(chatEndpointLeases)
      .where(
        and(
          eq(chatEndpointLeases.endpointId, endpoint.id),
          eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
        ),
      );
    if (!leaseBeforePause) throw new Error("Expected Discord Gateway lease");

    await new Promise((resolve) => setTimeout(resolve, 250));
    const messageId = "555555555555555601";
    const channel = makeThread({
      channelId: "333333333333333333",
      id: `discord:1457808928258658549:333333333333333333:${messageId}`,
      name: "discord-host-pause",
    });
    const message = makeMessage({
      id: messageId,
      mentioned: true,
      text: "@maya retain this buffered Discord turn",
      userId: "444444444444444444",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message,
      trigger: "mention",
    });

    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(
              chatDeliveries.providerEventId,
              `${channel.thread.id}:${messageId}`,
            ),
          ),
        ),
    ).resolves.toHaveLength(1);
    expect(runtime.endpoints.get(endpoint.id)).toBe(ownedRuntime);
    expect(ownedRuntime.shutdown).not.toHaveBeenCalled();
    await expect(
      db
        .select({ token: chatEndpointLeases.token })
        .from(chatEndpointLeases)
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
          ),
        ),
    ).resolves.toEqual([{ token: leaseBeforePause.token }]);

    await qualifySetupRoundTrip(service, endpoint.id, message.author.userId);
    await service.test(endpoint.id);
    if (!callbacks.onReaction) {
      throw new Error("Expected Discord reaction callback");
    }
    const commentCountBefore = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.companyId, fixture.companyId))
      .then((rows) => rows.length);
    const wakeupCountBefore = wakeup.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const emoji = {
      name: "thumbsup",
      toJSON: () => "👍",
      toString: () => "👍",
    };
    const reaction = {
      endpointId: endpoint.id,
      provider: "discord" as const,
      event: {
        adapter: {} as never,
        added: true,
        emoji,
        message,
        messageId,
        raw: {
          channel_id: "333333333333333333",
          emoji: { id: null, name: "👍" },
          gateway_dispatch: {
            eventType: "MESSAGE_REACTION_ADD",
            sequence: 801,
            sessionFingerprint: "c".repeat(24),
            shardId: 0,
          },
          guild_id: "1457808928258658549",
          message_id: messageId,
          user_id: message.author.userId,
        },
        rawEmoji: "👍",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: message.author,
      },
    };
    await callbacks.onReaction(reaction);
    await callbacks.onReaction(reaction);

    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "reaction_added"),
            sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${messageId}`,
          ),
        ),
    ).resolves.toEqual([{ state: "processed" }]);
    expect(
      await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.companyId, fixture.companyId))
        .then((rows) => rows.length),
    ).toBe(commentCountBefore);
    expect(wakeup).toHaveBeenCalledTimes(wakeupCountBefore);
    expect(runtime.endpoints.get(endpoint.id)).toBe(ownedRuntime);
    expect(ownedRuntime.shutdown).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it("stops a Discord Gateway on lease loss and lets a standby take over", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    const guildId = "1457808928258658549";
    const providerFetch = fakeDiscordFetch(
      applicationId,
      guildId,
    ) as typeof globalThis.fetch;
    const ownerRuntime = new FakeChatSdkRuntime();
    const owner = createService(ownerRuntime, providerFetch, {
      discordGatewayLeaseRenewalIntervalMs: 60_000,
      discordGatewayLeaseTtlMs: 200,
    });
    const endpoint = await owner.service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await owner.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          applicationId,
          botToken: "discord-secret",
          guildId,
        },
      },
      "owner-user",
    );
    const staleRuntime = ownerRuntime.endpoints.get(endpoint.id);
    const staleAdmission = ownerRuntime.configurations.get(endpoint.id)
      ?.callbacks.onDiscordRootMentionAdmission;
    const staleCallbacks = ownerRuntime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!staleAdmission || !staleCallbacks)
      throw new Error("Expected Discord admission callbacks");

    const standbyRuntime = new FakeChatSdkRuntime();
    const standby = createService(standbyRuntime, providerFetch);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const reconciled = await standby.service.reconcileProviderRuntimes();
    expect(reconciled).toMatchObject({ ownedElsewhere: 0, failed: 0 });
    expect(reconciled.local).toBe(reconciled.eligible);
    expect(reconciled.local).toBeGreaterThanOrEqual(1);
    expect(
      standbyRuntime.configurations.get(endpoint.id)?.enableDiscordGateway,
    ).toBe(true);
    await expect(
      staleAdmission({
        channelId: "333333333333333333",
        endpointId: endpoint.id,
        guildId,
        messageId: "555555555555555555",
        threadId: `discord:${guildId}:333333333333333333:555555555555555555`,
        userId: "444444444444444444",
      }),
    ).resolves.toBe(false);
    expect(staleRuntime?.shutdown).toHaveBeenCalledOnce();

    const freshCallbacks = standbyRuntime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!freshCallbacks)
      throw new Error("Expected standby Discord admission callbacks");
    const messageId = "555555555555555602";
    const channel = makeThread({
      channelId: "333333333333333333",
      id: `discord:${guildId}:333333333333333333:${messageId}`,
      name: "discord-standby-takeover",
    });
    const message = makeMessage({
      id: messageId,
      mentioned: true,
      text: "@maya accept this once after Gateway takeover",
      userId: "444444444444444444",
    });
    await deliverMessage({
      callbacks: staleCallbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message,
      trigger: "mention",
    });
    await deliverMessage({
      callbacks: freshCallbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message,
      trigger: "mention",
    });
    await expect(
      db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(
              chatDeliveries.providerEventId,
              `${channel.thread.id}:${messageId}`,
            ),
          ),
        ),
    ).resolves.toHaveLength(1);
    await Promise.all([owner.service.shutdown(), standby.service.shutdown()]);
  });

  it("fences message and reaction callbacks that resume after Discord Gateway takeover", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    const guildId = "1457808928258658549";
    const channelId = "333333333333333334";
    let holdOldCallbacks = false;
    let releaseOldCallbacks!: () => void;
    let messageAdmissionEntered!: () => void;
    let reactionAdmissionEntered!: () => void;
    const oldCallbacksReleased = new Promise<void>((resolve) => {
      releaseOldCallbacks = resolve;
    });
    const messageAdmissionReached = new Promise<void>((resolve) => {
      messageAdmissionEntered = resolve;
    });
    const reactionAdmissionReached = new Promise<void>((resolve) => {
      reactionAdmissionEntered = resolve;
    });
    const providerFetch = fakeDiscordFetch(
      applicationId,
      guildId,
    ) as typeof globalThis.fetch;
    const ownerRuntime = new FakeChatSdkRuntime();
    const owner = createService(ownerRuntime, providerFetch, {
      discordGatewayLeaseRenewalIntervalMs: 60_000,
      discordGatewayLeaseTtlMs: 200,
      discordGatewayMessageAdmissionBarrier: async () => {
        if (!holdOldCallbacks) return;
        messageAdmissionEntered();
        await oldCallbacksReleased;
      },
      reactionLinkPreflightBarrier: async () => {
        if (!holdOldCallbacks) return;
        reactionAdmissionEntered();
        await oldCallbacksReleased;
      },
    });
    const endpoint = await owner.service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await owner.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          applicationId,
          botToken: "discord-secret",
          guildId,
        },
      },
      "owner-user",
    );
    const rootMessageId = "555555555555555603";
    const channel = makeThread({
      channelId,
      id: `discord:${guildId}:${channelId}:${rootMessageId}`,
      name: "discord-callback-takeover",
    });
    const rootMessage = makeMessage({
      id: rootMessageId,
      mentioned: true,
      text: "@maya establish the takeover fixture",
      userId: "444444444444444445",
    });
    const setupCallbacks = ownerRuntime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!setupCallbacks) throw new Error("Expected owner Discord callbacks");
    await deliverMessage({
      callbacks: setupCallbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message: rootMessage,
      trigger: "mention",
    });
    await qualifySetupRoundTrip(
      owner.service,
      endpoint.id,
      rootMessage.author.userId,
    );
    await owner.service.test(endpoint.id);
    const staleRuntime = ownerRuntime.endpoints.get(endpoint.id);
    const staleCallbacks = ownerRuntime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!staleRuntime || !staleCallbacks?.onReaction) {
      throw new Error("Expected active owner Discord callbacks");
    }
    const [leaseBeforeTakeover] = await db
      .select({ token: chatEndpointLeases.token })
      .from(chatEndpointLeases)
      .where(
        and(
          eq(chatEndpointLeases.endpointId, endpoint.id),
          eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
        ),
      );
    if (!leaseBeforeTakeover) throw new Error("Expected owner Gateway lease");

    const messageId = "555555555555555604";
    const bufferedMessage = makeMessage({
      id: messageId,
      text: "continue this once after takeover",
      userId: rootMessage.author.userId,
    });
    const emoji = {
      name: "thumbsup",
      toJSON: () => "👍",
      toString: () => "👍",
    };
    const reaction = {
      endpointId: endpoint.id,
      provider: "discord" as const,
      event: {
        adapter: {} as never,
        added: true,
        emoji,
        message: rootMessage,
        messageId: rootMessageId,
        raw: {
          channel_id: channelId,
          emoji: { id: null, name: "👍" },
          gateway_dispatch: {
            eventType: "MESSAGE_REACTION_ADD",
            sequence: 802,
            sessionFingerprint: "d".repeat(24),
            shardId: 0,
          },
          guild_id: guildId,
          message_id: rootMessageId,
          user_id: rootMessage.author.userId,
        },
        rawEmoji: "👍",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: rootMessage.author,
      },
    };
    const commentCountBefore = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.companyId, fixture.companyId))
      .then((rows) => rows.length);
    const wakeupCountBefore = owner.wakeup.mock.calls.length;
    holdOldCallbacks = true;
    const staleMessage = deliverMessage({
      callbacks: staleCallbacks,
      endpointId: endpoint.id,
      provider: "discord",
      thread: channel.thread,
      message: bufferedMessage,
      trigger: "subscribed_message",
    });
    const staleReaction = staleCallbacks.onReaction(reaction);
    await Promise.all([messageAdmissionReached, reactionAdmissionReached]);

    const standbyRuntime = new FakeChatSdkRuntime();
    const standby = createService(standbyRuntime, providerFetch);
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const reconciled = await standby.service.reconcileProviderRuntimes();
      expect(reconciled).toMatchObject({ ownedElsewhere: 0, failed: 0 });
      const freshCallbacks = standbyRuntime.configurations.get(
        endpoint.id,
      )?.callbacks;
      if (!freshCallbacks?.onReaction) {
        throw new Error("Expected standby Discord callbacks");
      }
      const [leaseAfterTakeover] = await db
        .select({ token: chatEndpointLeases.token })
        .from(chatEndpointLeases)
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
          ),
        );
      expect(leaseAfterTakeover?.token).toBeTruthy();
      expect(leaseAfterTakeover?.token).not.toBe(leaseBeforeTakeover.token);

      releaseOldCallbacks();
      await Promise.all([staleMessage, staleReaction]);
      await expect(
        db
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              or(
                eq(
                  chatDeliveries.providerEventId,
                  `${channel.thread.id}:${messageId}`,
                ),
                and(
                  eq(chatDeliveries.eventKind, "reaction_added"),
                  sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${rootMessageId}`,
                ),
              ),
            ),
          ),
      ).resolves.toEqual([]);
      await vi.waitFor(() => {
        expect(staleRuntime.shutdown).toHaveBeenCalledOnce();
      });

      await deliverMessage({
        callbacks: freshCallbacks,
        endpointId: endpoint.id,
        provider: "discord",
        thread: channel.thread,
        message: bufferedMessage,
        trigger: "subscribed_message",
      });
      await freshCallbacks.onReaction(reaction);
      await deliverMessage({
        callbacks: freshCallbacks,
        endpointId: endpoint.id,
        provider: "discord",
        thread: channel.thread,
        message: bufferedMessage,
        trigger: "subscribed_message",
      });
      await freshCallbacks.onReaction(reaction);

      await expect(
        db
          .select({ state: chatDeliveries.state })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(
                chatDeliveries.providerEventId,
                `${channel.thread.id}:${messageId}`,
              ),
            ),
          ),
      ).resolves.toEqual([{ state: "processed" }]);
      await expect(
        db
          .select({ state: chatDeliveries.state })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(chatDeliveries.eventKind, "reaction_added"),
              sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${rootMessageId}`,
            ),
          ),
      ).resolves.toEqual([{ state: "processed" }]);
      expect(
        await db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.companyId, fixture.companyId))
          .then((rows) => rows.length),
      ).toBe(commentCountBefore + 1);
      expect(owner.wakeup).toHaveBeenCalledTimes(wakeupCountBefore);
      expect(standby.wakeup).toHaveBeenCalledOnce();
    } finally {
      releaseOldCallbacks();
      await Promise.allSettled([staleMessage, staleReaction]);
      await Promise.allSettled([
        owner.service.shutdown(),
        standby.service.shutdown(),
      ]);
    }
  });

  it("releases Discord ownership when runtime construction fails", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    const runtime = new FakeChatSdkRuntime();
    runtime.initializeHook = async () => {
      throw new Error("constructor failed");
    };
    const { service } = createService(
      runtime,
      fakeDiscordFetch(applicationId) as typeof globalThis.fetch,
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await expect(
      service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: {
            applicationId,
            botToken: "discord-secret",
            guildId: "1457808928258658549",
          },
        },
        "owner-user",
      ),
    ).rejects.toThrow("constructor failed");
    await expect(
      db
        .select({ token: chatEndpointLeases.token })
        .from(chatEndpointLeases)
        .where(eq(chatEndpointLeases.endpointId, endpoint.id)),
    ).resolves.toEqual([]);
    await service.shutdown();
  });

  it("serializes Discord Gateway health events and recovers transient guild outages", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    let releaseDisconnect!: () => void;
    let disconnectEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      disconnectEntered = resolve;
    });
    const disconnectBarrier = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    const runtime = new FakeChatSdkRuntime();
    const context = createService(
      runtime,
      fakeDiscordFetch(applicationId) as typeof globalThis.fetch,
      {
        discordGatewayEventBarrier: async (callback) => {
          if (callback.event.type !== "disconnected") return;
          disconnectEntered();
          await disconnectBarrier;
        },
      },
    );
    const endpoint = await context.service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await context.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          applicationId,
          botToken: "discord-secret",
          guildId: "1457808928258658549",
        },
      },
      "owner-user",
    );
    const setup = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id))
      .then((rows) => rows[0]!.setup);
    await db
      .update(chatEndpoints)
      .set({ status: "active", setup: { ...setup, step: "complete" } })
      .where(eq(chatEndpoints.id, endpoint.id));
    const onGatewayEvent = runtime.configurations.get(endpoint.id)?.callbacks
      .onDiscordGatewayEvent;
    if (!onGatewayEvent) throw new Error("Expected Discord Gateway callback");

    const recovered = vi.fn();
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.chatPublications, recovered);
    const disconnect = Promise.resolve(
      onGatewayEvent({
        endpointId: endpoint.id,
        provider: "discord",
        sequence: 1,
        event: { type: "disconnected", fatal: false, code: 1001 },
      }),
    );
    await entered;
    let recoveryFinished = false;
    const recovery = Promise.resolve(
      onGatewayEvent({
        endpointId: endpoint.id,
        provider: "discord",
        sequence: 2,
        event: { type: "ready" },
      }),
    ).then(() => {
      recoveryFinished = true;
    });
    await Promise.resolve();
    expect(recoveryFinished).toBe(false);
    releaseDisconnect();
    try {
      await Promise.all([disconnect, recovery]);
      expect(recovered).toHaveBeenCalled();
    } finally { unsubscribe(); }
    await expect(context.service.get(endpoint.id)).resolves.toMatchObject({
      status: "active",
      healthMessage: "Connected",
    });

    await onGatewayEvent({
      endpointId: endpoint.id,
      provider: "discord",
      sequence: 3,
      event: {
        type: "guild_unavailable",
        guildId: "1457808928258658549",
      },
    });
    await expect(context.service.get(endpoint.id)).resolves.toMatchObject({
      status: "active",
      healthMessage: expect.stringContaining("temporarily unavailable"),
    });
    await onGatewayEvent({
      endpointId: endpoint.id,
      provider: "discord",
      sequence: 4,
      event: {
        type: "guild_available",
        guildId: "1457808928258658549",
      },
    });
    await expect(context.service.get(endpoint.id)).resolves.toMatchObject({
      status: "active",
      healthMessage: "Connected",
    });
    await context.service.shutdown();
  });

  it("does not let pause overtake a credential-fenced Discord root thread creation", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    let releaseTransport!: () => void;
    let transportEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      transportEntered = resolve;
    });
    const transportBarrier = new Promise<void>((resolve) => {
      releaseTransport = resolve;
    });
    const runtime = new FakeChatSdkRuntime();
    const { service } = createService(
      runtime,
      fakeDiscordFetch(applicationId) as typeof globalThis.fetch,
      {
        discordRootThreadTransportBarrier: async () => {
          transportEntered();
          await transportBarrier;
        },
        scheduleDeferredWork: () => undefined,
      },
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          applicationId,
          botToken: "discord-secret",
          guildId: "1457808928258658549",
        },
      },
      "owner-user",
    );
    const setup = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id))
      .then((rows) => rows[0]!.setup);
    await db
      .update(chatEndpoints)
      .set({
        allowUnlinkedPeople: true,
        status: "active",
        setup: { ...setup, step: "complete" },
      })
      .where(eq(chatEndpoints.id, endpoint.id));
    await db
      .update(chatEndpointResources)
      .set({ enabled: true })
      .where(eq(chatEndpointResources.endpointId, endpoint.id));

    const admission = runtime.configurations.get(endpoint.id)?.callbacks
      .onDiscordRootMentionAdmission;
    if (!admission) throw new Error("Expected Discord admission callback");
    const ownedRuntime = runtime.endpoints.get(endpoint.id);
    if (!ownedRuntime)
      throw new Error("Expected Discord Gateway owner runtime");
    const messageId = "555555555555555590";
    const threadId = `discord:1457808928258658549:333333333333333333:${messageId}`;
    const message = {
      ...makeMessage({
        id: messageId,
        mentioned: true,
        text: "@maya serialize this root",
        userId: "444444444444444444",
      }),
      threadId,
    } as Message;
    const admitting = Promise.resolve(
      admission({
        channelId: "333333333333333333",
        endpointId: endpoint.id,
        guildId: "1457808928258658549",
        message,
        messageId,
        threadId,
        userId: "444444444444444444",
      }),
    );
    await entered;

    let pauseSettled = false;
    const pausing = service
      .configure(endpoint.id, { action: "pause" }, "owner-user")
      .then((result) => {
        pauseSettled = true;
        return result;
      });
    await Promise.resolve();
    expect(pauseSettled).toBe(false);
    releaseTransport();
    await expect(admitting).resolves.toBe(false);
    await expect(pausing).resolves.toMatchObject({ status: "paused" });
    expect(ownedRuntime.ensuredDiscordRootThreads).toEqual([
      {
        channelId: "333333333333333333",
        content: "@maya serialize this root",
        messageId,
      },
    ]);
    expect(runtime.configurations.get(endpoint.id)?.enableDiscordGateway).toBe(
      true,
    );
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    await service.shutdown();
  });

  it("configures a Discord bot only after identity, intent, server, and channel permissions verify", async () => {
    const fixture = await seedCompany();
    const applicationId = uniqueDiscordApplicationId();
    const guildId = "1457808928258658549";
    const providerFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toMatch(
          /^Bot discord-secret(?:-rotated)?$/,
        );
        const path = new URL(String(input)).pathname;
        const responses: Record<string, unknown> = {
          "/api/v10/users/@me": {
            id: applicationId,
            username: "maya",
            global_name: "Maya",
            bot: true,
          },
          "/api/v10/oauth2/applications/@me": {
            id: applicationId,
            name: "Maya",
            flags: 1 << 18,
          },
          [`/api/v10/guilds/${guildId}`]: { id: guildId, name: "Clawd" },
          [`/api/v10/guilds/${guildId}/members/${applicationId}`]: {
            roles: ["222222222222222222"],
            user: { id: applicationId },
          },
          [`/api/v10/guilds/${guildId}/roles`]: [
            {
              id: "222222222222222222",
              permissions: "309237763136",
            },
          ],
          [`/api/v10/guilds/${guildId}/channels`]: [
            {
              id: "333333333333333333",
              name: "agent-lab",
              position: 1,
              type: 0,
            },
          ],
        };
        return new Response(JSON.stringify(responses[path]), {
          status: path in responses ? 200 : 404,
          headers: { "content-type": "application/json" },
        });
      },
    ) as unknown as typeof globalThis.fetch;
    const { runtime, service } = createService(
      new FakeChatSdkRuntime(),
      providerFetch,
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "discord", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );

    const configured = await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          applicationId,
          botToken: "discord-secret",
          guildId,
        },
      },
      "owner-user",
    );

    expect(configured).toMatchObject({
      provider: "discord",
      providerAccountId: guildId,
      providerAccountLabel: "Clawd",
      botExternalId: applicationId,
      botUsername: "maya",
      status: "verifying",
      setup: { step: "test" },
    });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "333333333333333333",
        parentProviderResourceId: guildId,
        label: "#agent-lab",
        enabled: false,
      }),
    ]);
    expect(
      runtime.configurations.get(endpoint.id)?.providerConfig,
    ).toMatchObject({
      provider: "discord",
      credentials: {
        applicationId,
        botToken: "discord-secret",
        guildId,
      },
    });
    const connection = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId))
      .then((rows) => rows[0]!);
    expect(connection.refs).toHaveLength(3);
    expect(JSON.stringify(connection)).not.toContain("discord-secret");

    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    const admitRootMention = callbacks?.onDiscordRootMentionAdmission;
    if (!admitRootMention)
      throw new Error("Expected Discord root-mention admission callback");
    const rootMention = (messageId: string) => {
      const threadId = `discord:${guildId}:333333333333333333:${messageId}`;
      const message = {
        ...makeMessage({
          id: messageId,
          text: "@maya investigate the queue",
          mentioned: true,
          userId: "444444444444444444",
        }),
        threadId,
      } as Message;
      return {
        message,
        thread: makeThread({
          channelId: "333333333333333333",
          id: threadId,
        }).thread,
        threadId,
      };
    };
    const admission = async (messageId: string) => {
      const root = rootMention(messageId);
      return await admitRootMention({
        endpointId: endpoint.id,
        guildId,
        channelId: "333333333333333333",
        messageId,
        message: root.message,
        threadId: root.threadId,
        userId: "444444444444444444",
      });
    };
    await expect(admission("555555555555555551")).resolves.toBe(false);
    const [admittedRoot] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            `discord:${guildId}:333333333333333333:555555555555555551:555555555555555551`,
          ),
        ),
      );
    expect(admittedRoot).toMatchObject({
      state: "received",
      redactedError: null,
      normalizedEvent: expect.objectContaining({
        message: expect.objectContaining({
          text: "@maya investigate the queue",
        }),
      }),
    });
    expect(admittedRoot?.nextAttemptAt).toBeNull();
    expect(
      runtime.endpoints.get(endpoint.id)?.ensuredDiscordRootThreads,
    ).toContainEqual({
      channelId: "333333333333333333",
      messageId: "555555555555555551",
      content: "@maya investigate the queue",
    });
    await expect(service.listConversations(endpoint.id)).resolves.toHaveLength(
      0,
    );
    await service.processPendingDeliveries(25, admittedRoot!.id);
    await vi.waitFor(async () => {
      await expect(
        db
          .select({
            normalizedEvent: chatDeliveries.normalizedEvent,
            state: chatDeliveries.state,
          })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.id, admittedRoot!.id)),
      ).resolves.toEqual([
        expect.objectContaining({
          state: "processed",
          normalizedEvent: expect.not.objectContaining({
            providerThreadPending: true,
          }),
        }),
      ]);
    });

    await db
      .update(chatEndpoints)
      .set({ status: "active" })
      .where(eq(chatEndpoints.id, endpoint.id));
    await db
      .update(chatEndpointResources)
      .set({ enabled: false })
      .where(eq(chatEndpointResources.endpointId, endpoint.id));
    await expect(admission("555555555555555552")).resolves.toBe(false);
    await expect(
      db
        .select({
          normalizedEvent: chatDeliveries.normalizedEvent,
          redactedError: chatDeliveries.redactedError,
          state: chatDeliveries.state,
        })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(
              chatDeliveries.providerEventId,
              `discord:${guildId}:333333333333333333:555555555555555552:555555555555555552`,
            ),
          ),
        ),
    ).resolves.toEqual([
      {
        normalizedEvent: expect.objectContaining({
          filtering: {
            contentRetained: false,
            providerThreadCreated: false,
          },
        }),
        redactedError: "Destination is not enabled in Paperclip",
        state: "filtered",
      },
    ]);

    await db
      .update(chatEndpointResources)
      .set({ enabled: true })
      .where(eq(chatEndpointResources.endpointId, endpoint.id));
    await db
      .update(chatEndpoints)
      .set({ allowGroupChats: false })
      .where(eq(chatEndpoints.id, endpoint.id));
    await expect(admission("555555555555555553")).resolves.toBe(false);
    await db
      .update(chatEndpoints)
      .set({ allowGroupChats: true, allowUnlinkedPeople: false })
      .where(eq(chatEndpoints.id, endpoint.id));
    await expect(admission("555555555555555554")).resolves.toBe(false);
    await db
      .update(chatEndpoints)
      .set({ allowUnlinkedPeople: true })
      .where(eq(chatEndpoints.id, endpoint.id));
    const activeRuntime = runtime.endpoints.get(endpoint.id);
    if (!activeRuntime) throw new Error("Expected active Discord runtime");
    const ensureDiscordRootThread = activeRuntime.ensureDiscordRootThread;
    activeRuntime.ensureDiscordRootThread = vi.fn(async () => {
      throw new Error("temporary Discord API failure");
    });
    await expect(admission("555555555555555555")).resolves.toBe(false);
    const [interruptedRoot] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            `discord:${guildId}:333333333333333333:555555555555555555:555555555555555555`,
          ),
        ),
      );
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, interruptedRoot!.id));
    activeRuntime.ensureDiscordRootThread = ensureDiscordRootThread;
    await service.processPendingDeliveries(25, interruptedRoot!.id);
    expect(
      runtime.endpoints.get(endpoint.id)?.ensuredDiscordRootThreads,
    ).toContainEqual({
      channelId: "333333333333333333",
      messageId: "555555555555555555",
      content: "@maya investigate the queue",
    });
    await expect(
      db
        .select({
          normalizedEvent: chatDeliveries.normalizedEvent,
          state: chatDeliveries.state,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, interruptedRoot!.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        state: "processed",
        normalizedEvent: expect.not.objectContaining({
          providerThreadPending: true,
        }),
      }),
    ]);

    const runtimeBeforeRotation = runtime.endpoints.get(endpoint.id);
    const firstSecretIds = new Set(connection.refs.map((ref) => ref.secretId));
    const conversationsBeforeRotation = await service.listConversations(
      endpoint.id,
    );
    expect(conversationsBeforeRotation.length).toBeGreaterThan(0);

    const reconnected = await service.configure(
      endpoint.id,
      {
        action: "reconnect",
        // Rotation accepts the one changed secret and merges the immutable
        // Application/Server identity from Paperclip's existing vault refs.
        credentials: { botToken: "discord-secret-rotated" },
      },
      "owner-user",
    );
    expect(reconnected).toMatchObject({
      id: endpoint.id,
      providerAccountId: guildId,
      botExternalId: applicationId,
      status: "verifying",
      setup: { step: "test" },
    });
    expect(runtimeBeforeRotation?.shutdown).toHaveBeenCalledTimes(1);
    expect(
      runtime.configurations.get(endpoint.id)?.providerConfig,
    ).toMatchObject({
      provider: "discord",
      credentials: {
        applicationId,
        botToken: "discord-secret-rotated",
        guildId,
      },
    });
    const [rotatedConnection] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(rotatedConnection?.refs).toHaveLength(3);
    expect(
      rotatedConnection?.refs.every((ref) => !firstSecretIds.has(ref.secretId)),
    ).toBe(true);
    await expect(service.listConversations(endpoint.id)).resolves.toMatchObject(
      conversationsBeforeRotation.map((conversation) => ({
        id: conversation.id,
        issueId: conversation.issueId,
      })),
    );
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "333333333333333333",
        enabled: true,
      }),
    ]);
    const reconnectActivity = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, endpoint.connectionId))
      .then((rows) =>
        rows.find((row) => row.action === "chat_endpoint.reconnected"),
      );
    expect(reconnectActivity).toEqual({
      action: "chat_endpoint.reconnected",
      details: { endpointId: endpoint.id, provider: "discord" },
    });
    expect(JSON.stringify(reconnectActivity)).not.toContain(
      "discord-secret-rotated",
    );

    const reconnectedCallbacks = runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    const reconnectedAdmission =
      reconnectedCallbacks?.onDiscordRootMentionAdmission;
    const onDiscordGatewayEvent = reconnectedCallbacks?.onDiscordGatewayEvent;
    if (!reconnectedAdmission || !onDiscordGatewayEvent) {
      throw new Error("Expected Discord lifecycle callbacks after reconnect");
    }
    const inaccessibleRoot = rootMention("555555555555555556");
    const currentRuntime = runtime.endpoints.get(endpoint.id);
    if (!currentRuntime) throw new Error("Expected active Discord runtime");
    currentRuntime.ensureDiscordRootThread = vi.fn(async () => {
      throw Object.assign(new Error("provider detail must not escape"), {
        adapter: "discord",
        code: 50013,
        status: 403,
      });
    });
    await expect(
      reconnectedAdmission({
        endpointId: endpoint.id,
        guildId,
        channelId: "333333333333333333",
        messageId: inaccessibleRoot.message.id,
        message: inaccessibleRoot.message,
        threadId: inaccessibleRoot.threadId,
        userId: "444444444444444444",
      }),
    ).resolves.toBe(false);
    const [inaccessibleDelivery] = await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            `discord:${guildId}:333333333333333333:555555555555555556:555555555555555556`,
          ),
        ),
      )
      .returning({ id: chatDeliveries.id });
    if (!inaccessibleDelivery) {
      throw new Error("Expected provisional inaccessible Discord root");
    }
    await service.processPendingDeliveries(25, inaccessibleDelivery.id);
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "333333333333333333",
        availability: "unavailable",
      }),
    ]);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual(
      conversationsBeforeRotation.map((conversation) =>
        expect.objectContaining({
          id: conversation.id,
          state: "unavailable",
        }),
      ),
    );

    await db
      .update(chatEndpointResources)
      .set({ availability: "available" })
      .where(eq(chatEndpointResources.endpointId, endpoint.id));
    await db
      .update(chatConversations)
      .set({ state: "active" })
      .where(eq(chatConversations.endpointId, endpoint.id));
    await onDiscordGatewayEvent({
      endpointId: endpoint.id,
      provider: "discord",
      sequence: 1,
      event: { type: "disconnected", fatal: false, code: 1001 },
    });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      healthMessage: "Discord Gateway disconnected (code 1001); reconnecting",
    });
    await expect(
      db
        .select({
          enabled: toolConnections.enabled,
          healthStatus: toolConnections.healthStatus,
          status: toolConnections.status,
        })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId)),
    ).resolves.toEqual([
      { enabled: true, healthStatus: "degraded", status: "active" },
    ]);
    await onDiscordGatewayEvent({
      endpointId: endpoint.id,
      provider: "discord",
      sequence: 2,
      event: { type: "ready", botUserId: applicationId },
    });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "verifying",
      healthMessage: "Waiting for a test conversation",
    });
    await onDiscordGatewayEvent({
      endpointId: endpoint.id,
      provider: "discord",
      sequence: 3,
      event: {
        type: "channel_removed",
        channelId: "333333333333333333",
        guildId,
        label: "agent-lab",
      },
    });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "333333333333333333",
        availability: "removed",
      }),
    ]);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual(
      conversationsBeforeRotation.map((conversation) =>
        expect.objectContaining({
          id: conversation.id,
          state: "unavailable",
        }),
      ),
    );
    await onDiscordGatewayEvent({
      endpointId: endpoint.id,
      provider: "discord",
      sequence: 4,
      event: { type: "guild_removed", guildId },
    });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "revoked",
      healthMessage: "Discord bot was removed from the configured server",
    });
    await expect(
      db
        .select({
          enabled: toolConnections.enabled,
          healthStatus: toolConnections.healthStatus,
          status: toolConnections.status,
        })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId)),
    ).resolves.toEqual([
      { enabled: false, healthStatus: "failed", status: "disabled" },
    ]);

    await service.configure(endpoint.id, { action: "remove" }, "owner-user");
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "archived",
    });
    await expect(service.listConversations(endpoint.id)).resolves.toEqual(
      conversationsBeforeRotation.map((conversation) =>
        expect.objectContaining({
          id: conversation.id,
          issueId: conversation.issueId,
          state: "endpoint_removed",
        }),
      ),
    );
    await expect(
      db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId))
        .then((rows) => rows[0]?.refs),
    ).resolves.toEqual([]);
    await expect(
      db
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(eq(companySecrets.companyId, fixture.companyId)),
    ).resolves.toHaveLength(0);
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    await service.shutdown();
  });

  it("allows only one concurrent live endpoint to claim a Discord bot across guilds", async () => {
    const fixture = await seedCompany();
    const applicationId = "623456789012345678";
    const guildIds = ["723456789012345678", "823456789012345678"];
    const providerFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toMatch(
          /^Bot discord-secret-/,
        );
        const path = new URL(String(input)).pathname;
        if (path === "/api/v10/users/@me") {
          return new Response(
            JSON.stringify({
              id: applicationId,
              username: "shared-maya",
              global_name: "Shared Maya",
              bot: true,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (path === "/api/v10/oauth2/applications/@me") {
          return new Response(
            JSON.stringify({
              id: applicationId,
              name: "Shared Maya",
              flags: 1 << 18,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const guildId = guildIds.find((candidate) => path.includes(candidate));
        if (!guildId) {
          return new Response(JSON.stringify({ message: "not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        let body: unknown;
        if (path === `/api/v10/guilds/${guildId}`) {
          body = { id: guildId, name: `Guild ${guildId}` };
        } else if (path.endsWith(`/members/${applicationId}`)) {
          body = {
            roles: ["923456789012345678"],
            user: { id: applicationId },
          };
        } else if (path.endsWith("/roles")) {
          body = [
            {
              id: "923456789012345678",
              permissions: "309237763136",
            },
          ];
        } else if (path.endsWith("/channels")) {
          body = [
            {
              id:
                guildId === guildIds[0]
                  ? "333333333333333334"
                  : "333333333333333335",
              name: "agent-lab",
              position: 1,
              type: 0,
            },
          ];
        }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    ) as unknown as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch);
    const endpoints = await Promise.all([
      service.create(
        fixture.companyId,
        { provider: "discord", assignedAgentId: fixture.assignedAgentId },
        "owner-user",
      ),
      service.create(
        fixture.companyId,
        { provider: "discord", assignedAgentId: fixture.replacementAgentId },
        "owner-user",
      ),
    ]);

    const outcomes = await Promise.allSettled(
      endpoints.map((endpoint, index) =>
        service.configure(
          endpoint.id,
          {
            action: "configure",
            credentials: {
              applicationId,
              botToken: `discord-secret-${index}`,
              guildId: guildIds[index]!,
            },
          },
          "owner-user",
        ),
      ),
    );

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      status: 409,
      details: { code: "chat_bot_identity_in_use" },
    });
    const live = await db
      .select({ id: chatEndpoints.id })
      .from(chatEndpoints)
      .where(
        and(
          eq(chatEndpoints.provider, "discord"),
          eq(chatEndpoints.botExternalId, applicationId),
          inArray(chatEndpoints.status, [
            "verifying",
            "active",
            "paused",
            "attention",
          ]),
        ),
      );
    expect(live).toHaveLength(1);
  });

  describe("Discord native commands with durable service authority", () => {
    const guildId = "1457808928258658549";
    const channelId = "333333333333333333";
    const externalUserId = "444444444444444419";
    const rootMessageId = "555555555555555619";
    const registeredCommandId = "888888888888888819";
    let interactionSequence = 0n;

    async function commandFixture(companyId?: string) {
      const fixture = await seedCompany(undefined, companyId);
      const applicationId = uniqueDiscordApplicationId();
      let holdWork = false;
      const queued: Array<() => void> = [];
      const remoteCommands: Array<Record<string, unknown>> = [];
      const registrationCalls: string[] = [];
      const providerFetch: typeof globalThis.fetch = async (input, init) => {
        if (
          [
            `/api/v10/applications/${applicationId}/commands`,
            `/api/v10/applications/${applicationId}/commands/${registeredCommandId}`,
          ].includes(new URL(String(input)).pathname)
        ) {
          const method = init?.method ?? "GET";
          registrationCalls.push(method);
          if (method === "GET") return Response.json(remoteCommands);
          if (method !== "POST" && method !== "PATCH")
            throw new Error("Unexpected fixture command request");
          const definition = JSON.parse(String(init?.body));
          const command = {
            ...definition,
            id: registeredCommandId,
            application_id: applicationId,
            version: "999999999999999919",
          };
          if (method === "PATCH")
            remoteCommands.splice(0, remoteCommands.length, command);
          else remoteCommands.push(command);
          return Response.json(command);
        }
        return fakeDiscordFetch(applicationId)(input);
      };
      const context = createService(new FakeChatSdkRuntime(), providerFetch, {
        scheduleDeferredWork(task) {
          if (holdWork) queued.push(task);
          else setImmediate(task);
        },
      });
      const endpoint = await context.service.create(
        fixture.companyId,
        {
          provider: "discord",
          assignedAgentId: fixture.assignedAgentId,
          name: "Discord command fixture",
        },
        "owner-user",
      );
      const identityAdapter = createDiscordAdapter({
        applicationId,
        botToken: "synthetic-identity-only",
        webhookVerifier: async () => false,
      });
      context.runtime.initializeHook = async (endpointId) => {
        if (endpointId !== endpoint.id) return;
        const current = context.runtime.get(endpointId)!;
        const original = current.thread.bind(current);
        // Real pinned source IDs, with data transport only still mocked.
        current.thread = (threadId) => ({
          ...original(threadId),
          channelId: identityAdapter.channelIdFromThreadId(threadId),
          isDM: threadId.startsWith("discord:@me:"),
        });
      };
      await context.service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: { applicationId, botToken: "discord-secret", guildId },
        },
        "owner-user",
      );
      const initialCallbacks = context.runtime.configurations.get(
        endpoint.id,
      )!.callbacks;
      if (!initialCallbacks.onDiscordRootMentionAdmission)
        throw new Error("Discord root fixture callback unavailable");
      const threadId = `discord:${guildId}:${channelId}:${rootMessageId}`;
      await initialCallbacks.onDiscordRootMentionAdmission({
        endpointId: endpoint.id,
        guildId,
        channelId,
        messageId: rootMessageId,
        message: {
          ...makeMessage({
            id: rootMessageId,
            text: "@maya investigate the command fixture",
            mentioned: true,
            userId: externalUserId,
          }),
          threadId,
        } as Message,
        threadId,
        userId: externalUserId,
      });
      const delivery = await db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.providerEventId, `${threadId}:${rootMessageId}`),
          ),
        )
        .then((rows) => rows[0]);
      if (!delivery) throw new Error("Discord command setup delivery absent");
      await context.service.processPendingDeliveries(25, delivery.id);
      await qualifySetupRoundTrip(context.service, endpoint.id, externalUserId);
      await context.service.test(endpoint.id);
      await context.service.reconcileProviderRuntimes();
      const callbacks = context.runtime.configurations.get(
        endpoint.id,
      )!.callbacks;
      if (!callbacks.onSlashCommand)
        throw new Error("Registered Discord command callback unavailable");
      const [conversation] = await context.service.listConversations(
        endpoint.id,
      );
      if (!conversation) throw new Error("Discord command conversation absent");
      const principal = await db
        .select()
        .from(chatExternalPrincipals)
        .where(
          and(
            eq(chatExternalPrincipals.companyId, fixture.companyId),
            eq(chatExternalPrincipals.provider, "discord"),
            eq(chatExternalPrincipals.providerAccountId, guildId),
            eq(chatExternalPrincipals.externalId, externalUserId),
          ),
        )
        .then((rows) => rows[0]);
      if (!principal) throw new Error("Discord command principal absent");
      const intent = await context.service.createLinkIntent(
        endpoint.id,
        principal.id,
        1800,
      );
      await context.service.confirmIdentityLink(
        new URL(intent.confirmationUrl).searchParams.get("token")!,
        "owner-user",
      );
      const scope = {
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        applicationId,
        guildId,
      };
      expect(
        registrationCalls.filter((method) => method === "POST"),
      ).toHaveLength(1);
      holdWork = true;
      const pinnedRuntimes: Array<
        ReturnType<typeof createChatSdkEndpointRuntime>
      > = [];
      const coldContexts: Array<ReturnType<typeof createService>> = [];
      async function parser(
        configuration = context.runtime.configurations.get(endpoint.id)!,
      ) {
        const pinned = createChatSdkEndpointRuntime({
          ...configuration,
          callbacks: {
            onMessage() {},
            onSlashCommand: configuration.callbacks.onSlashCommand,
          },
          enableDiscordGateway: false,
          logger: "silent",
        });
        pinnedRuntimes.push(pinned);
        await pinned.initialize();
        return pinned.getProviderAdapter() as unknown as {
          handleGatewayInteraction(input: unknown): Promise<void>;
        };
      }
      const adapter = await parser();
      const interaction = (
        command: "status" | "new" | "close",
        overrides: Record<string, unknown> = {},
      ) => ({
        id: (
          ((BigInt(Date.now()) - 1420070400000n) << 22n) +
          interactionSequence++
        ).toString(),
        applicationId,
        commandId: registeredCommandId,
        commandName: "paperclip",
        commandType: 1,
        type: 2,
        version: 1,
        context: 0,
        guildId,
        channelId: rootMessageId,
        channel: { id: rootMessageId, parentId: channelId, type: 11 },
        authorizingIntegrationOwners: { guildId, userId: null },
        user: {
          id: externalUserId,
          username: "operator",
          globalName: "Operator",
          bot: false,
          discriminator: "0",
        },
        options: { data: [{ name: command, type: 1 }] },
        createdTimestamp: Date.now(),
        token: "synthetic-command-interaction-token",
        isChatInputCommand: () => true,
        isModalSubmit: () => false,
        isMessageComponent: () => false,
        deferReply: vi.fn(async () => undefined),
        editReply: vi.fn(async () => undefined),
        deferred: false,
        replied: false,
        ...overrides,
      });
      const actions = () =>
        db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "discord_native_command"),
            ),
          )
          .orderBy(asc(chatActions.createdAt));
      const publications = () =>
        db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, endpoint.id),
              like(chatPublications.idempotencyKey, "control:%"),
            ),
          );
      return {
        ...context,
        fixture,
        endpoint,
        callbacks,
        conversation,
        applicationId,
        principal,
        scope,
        adapter,
        parser,
        interaction,
        actions,
        publications,
        queued,
        registrationCalls,
        async coldUnavailableParser(legacyCopy = false) {
          await context.service.shutdown();
          await db
            .update(chatEndpoints)
            .set({
              capabilities: { ...endpoint.capabilities, slashCommands: false },
            })
            .where(eq(chatEndpoints.id, endpoint.id));
          const registration = await db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, endpoint.id),
                eq(chatActions.kind, "discord_command_registration"),
              ),
            )
            .then((rows) => rows[0]!);
          let priorRegistration = registration.payload.registration;
          if (legacyCopy) {
            const prior = structuredClone(remoteCommands[0]!);
            (prior.options as Array<{ description: string }>)[2]!.description =
              "Close the current Paperclip task";
            remoteCommands[0] = prior;
            const {
              id: _id,
              application_id: _application,
              version: _version,
              ...definition
            } = prior;
            const stored = priorRegistration as {
              receipt: Record<string, unknown>;
            };
            priorRegistration = {
              ...stored,
              receipt: {
                ...stored.receipt,
                definitionDigest: createHash("sha256")
                  .update(JSON.stringify(definition))
                  .digest("hex"),
              },
            };
          }
          await db
            .update(chatActions)
            .set({
              payload: { registration: priorRegistration },
              result: {
                schema: "paperclip.discord.command-registration-result.v1",
                outcome: legacyCopy ? "registered" : "unavailable",
                retryAt: legacyCopy
                  ? new Date(0).toISOString()
                  : new Date(Date.now() + 60_000).toISOString(),
              },
            })
            .where(
              and(
                eq(chatActions.endpointId, endpoint.id),
                eq(chatActions.kind, "discord_command_registration"),
              ),
            );
          const cold = createService(new FakeChatSdkRuntime(), providerFetch, {
            scheduleDeferredWork(task) {
              queued.push(task);
            },
          });
          coldContexts.push(cold);
          await cold.service.reconcileProviderRuntimes();
          await recoverDiscordCommands(cold.service);
          return {
            ...cold,
            adapter: await parser(
              cold.runtime.configurations.get(endpoint.id)!,
            ),
          };
        },
        async close() {
          try {
            await Promise.all(
              pinnedRuntimes.map((pinned) => pinned.shutdown()),
            );
          } finally {
            try {
              await Promise.all(
                coldContexts.map((cold) => cold.service.shutdown()),
              );
            } finally {
              await retirePublicationFixture(context.service, endpoint.id);
            }
          }
        },
      };
    }

    it.each(["working", "unknown_final"])(
      "qualifies pinned Discord close-owned progress retirement (%s)",
      async (mode) => {
        const f = await commandFixture();
        try {
          // The setup root can still have a retryable wake after a concurrent
          // fixture drain. Start this run from a fresh, actually accepted
          // request and prove its receipt exists before testing its removal.
          const sourceMessageId = (
            ((BigInt(Date.now()) - 1420070400000n) << 22n) +
            1n
          ).toString();
          const sourceThread = makeThread({
            id: f.conversation.externalThreadId,
            channelId: f.conversation.externalConversationId,
            name: "Close-owned progress qualification",
          });
          await deliverMessage({
            callbacks: f.callbacks,
            endpointId: f.endpoint.id,
            provider: "discord",
            thread: sourceThread.thread,
            message: makeMessage({
              id: sourceMessageId,
              text: "Work on this request while I test closing the conversation",
              userId: externalUserId,
            }),
            trigger: "subscribed_message",
          });
          const [sourceDelivery] = await db
            .select({ id: chatDeliveries.id, state: chatDeliveries.state })
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, f.endpoint.id),
                sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${sourceMessageId}`,
              ),
            );
          expect(sourceDelivery?.state).toBe("processed");
          await expect(
            db
              .select({ status: chatActions.status })
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.endpointId, f.endpoint.id),
                  eq(chatActions.deliveryId, sourceDelivery!.id),
                  eq(chatActions.kind, "inbound_wakeup"),
                ),
              ),
          ).resolves.toEqual([{ status: "processed" }]);
          await expect(
            db
              .select({ status: chatActions.status })
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.endpointId, f.endpoint.id),
                  eq(
                    chatActions.providerActionId,
                    `receipt_reaction:${sourceDelivery!.id}`,
                  ),
                ),
              ),
          ).resolves.toEqual([{ status: "processed" }]);
          const runId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: runId,
            companyId: f.fixture.companyId,
            agentId: f.fixture.assignedAgentId,
            status: "running",
            contextSnapshot: await chatWakeContext({
              endpointId: f.endpoint.id,
              issueId: f.conversation.issueId,
              provider: "discord",
              providerMessageId: sourceMessageId,
            }),
          });
          const [progress] = await db
            .insert(chatPublications)
            .values({
              companyId: f.fixture.companyId,
              endpointId: f.endpoint.id,
              conversationId: f.conversation.id,
              issueId: f.conversation.issueId,
              idempotencyKey: `run:${runId}:working:${f.endpoint.id}`,
              payload: { text: "Maya is working…", progressState: "working" },
              state: "pending",
            })
            .returning();
          await f.service.processPendingPublications();
          const runtime = f.runtime.endpoints.get(f.endpoint.id)!;
          const progressMessageId = await db
            .select({ id: chatPublications.providerMessageId })
            .from(chatPublications)
            .where(eq(chatPublications.id, progress.id))
            .then((rows) => rows[0]!.id!);
          if (mode === "final") {
            await addSelectedChatFinal({
              agentId: f.fixture.assignedAgentId,
              body: "The Discord final must remain",
              companyId: f.fixture.companyId,
              issueId: f.conversation.issueId,
              runId,
            });
            await f.service.processPendingPublications();
          }
          if (mode === "card")
            await db
              .update(chatPublications)
              .set({
                payload: {
                  ...progress.payload,
                  card: { schema: "paperclip.chat.card.v1", kind: "status", title: "Not a plain progress lane" },
                },
              })
              .where(eq(chatPublications.id, progress.id));
          const command = f.interaction("close");
          await f.adapter.handleGatewayInteraction(command);
          const close = (await f.publications()).find((publication) =>
            publication.idempotencyKey.startsWith("control:close:"),
          )!;
          expect(close).toBeDefined();
          if (mode === "unknown_final") {
            const final = await addSelectedChatFinal({
              agentId: f.fixture.assignedAgentId,
              body: "Possibly delivered Discord final",
              companyId: f.fixture.companyId,
              issueId: f.conversation.issueId,
              runId,
            });
            await db
              .update(chatPublications)
              .set({
                state: "delivery_unknown",
                createdAt: new Date(close.createdAt.getTime() + 1000),
              })
              .where(eq(chatPublications.commentId, final.id));
          }
          const editCount = runtime.edits.length,
            postCount = runtime.posts.length;
          await f.service.processPendingPublications();
          await f.service.processPendingReceiptReactions();
          expect(runtime.edits).toHaveLength(
            editCount + (mode === "working" ? 1 : 0),
          );
          expect(runtime.posts).toHaveLength(
            postCount + (mode === "working" ? 0 : 1),
          );
          if (mode === "working") {
            expect(runtime.edits.at(-1)).toMatchObject({
              messageId: progressMessageId,
              text: close.payload.text,
            });
            await waitForProcessedReceiptRemoval(f.endpoint.id, {
              threadId: f.conversation.externalThreadId,
              messageId: sourceMessageId,
              emoji: "eyes",
            });
            expect(runtime.removedReactions).toContainEqual({
              threadId: f.conversation.externalThreadId,
              messageId: sourceMessageId,
              emoji: "eyes",
            });
          }
          await expect(
            db
              .select({ status: heartbeatRuns.status })
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, runId)),
          ).resolves.toEqual([{ status: "running" }]);
          await f.adapter.handleGatewayInteraction(command);
          await f.service.processPendingPublications();
          expect(runtime.edits).toHaveLength(
            editCount + (mode === "working" ? 1 : 0),
          );
        } finally {
          await f.close();
        }
      },
    );

    it("answers a cold unavailable Discord command privately without leaving the interaction thinking", async () => {
      const f = await commandFixture();
      try {
        const cold = await f.coldUnavailableParser();
        const beforeActions = await f.actions();
        const beforePublications = await f.publications();
        const command = f.interaction("close");
        await cold.adapter.handleGatewayInteraction(command);
        expect
          .soft(command.deferReply)
          .toHaveBeenCalledExactlyOnceWith({ flags: 64 });
        expect(command.editReply).toHaveBeenCalledExactlyOnceWith({
          content: expect.stringContaining(
            "This command is not available here",
          ),
          allowedMentions: { parse: [] },
        });
        expect(await f.actions()).toEqual(beforeActions);
        expect(await f.publications()).toEqual(beforePublications);
        expect(cold.wakeup).not.toHaveBeenCalled();
        expect(
          (
            await readChatConversationsById(f.conversation.id)
          )[0]?.state,
        ).toBe("active");
      } finally {
        await f.close();
      }
    });

    it("upgrades a retained prior-copy registration after service restart before admitting close", async () => {
      const f = await commandFixture();
      try {
        const cold = await f.coldUnavailableParser(true);
        expect(
          f.registrationCalls.filter((method) => method === "POST"),
        ).toHaveLength(1);
        expect(
          f.registrationCalls.filter((method) => method === "PATCH"),
        ).toHaveLength(1);
        const command = f.interaction("close");
        await cold.adapter.handleGatewayInteraction(command);
        expect(command.editReply).toHaveBeenCalledExactlyOnceWith({
          content: expect.stringContaining("request recorded"),
          allowedMentions: { parse: [] },
        });
        expect(await f.actions()).toHaveLength(1);
        expect(await f.publications()).toHaveLength(1);
        expect(cold.wakeup).not.toHaveBeenCalled();
        await cold.service.processPendingPublications(100);
        expect((await f.publications())[0]?.state).toBe("published");
        expect(
          (
            await readChatConversationsById(f.conversation.id)
          )[0]?.state,
        ).toBe("completed");
      } finally {
        await f.close();
      }
    });

    it("returns private status, keeps guild new as guidance, and closes only after a real public control receipt", async () => {
      const f = await commandFixture();
      try {
        const wakeCount = f.wakeup.mock.calls.length;
        const status = f.interaction("status");
        await f.adapter.handleGatewayInteraction(status);
        expect(status.deferReply).toHaveBeenCalledWith({ flags: 64 });
        expect(status.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining(f.conversation.issueIdentifier!),
            allowedMentions: { parse: [] },
          }),
        );
        expect(await f.publications()).toHaveLength(0);
        const newCommand = f.interaction("new");
        await f.adapter.handleGatewayInteraction(newCommand);
        expect(newCommand.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("new Discord thread"),
          }),
        );
        expect(await f.publications()).toHaveLength(0);
        const close = f.interaction("close");
        await f.adapter.handleGatewayInteraction(close);
        expect(close.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("recorded"),
          }),
        );
        const [publication] = await f.publications();
        expect(publication).toMatchObject({
          state: "pending",
          conversationId: f.conversation.id,
          issueId: f.conversation.issueId,
        });
        expect(publication.idempotencyKey).toMatch(/^control:close:/);
        expect(
          (
            await readChatConversationsById(f.conversation.id)
          )[0]?.state,
        ).toBe("active");
        expect(await f.actions()).toHaveLength(3);
        expect(f.wakeup).toHaveBeenCalledTimes(wakeCount);
        await f.service.processPendingPublications(100);
        expect((await f.publications())[0]).toMatchObject({
          state: "published",
        });
        expect(
          (
            await readChatConversationsById(f.conversation.id)
          )[0]?.state,
        ).toBe("completed");
        // Fresh adapter removes only process-local ACK suppression. The real
        // service must replay the exact durable action, not stage another close
        // or infer a replacement conversation from its now-completed target.
        const replayAdapter = await f.parser();
        const replay = f.interaction("close", { id: close.id });
        await replayAdapter.handleGatewayInteraction(replay);
        expect(replay.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("recorded"),
          }),
        );
        expect(await f.actions()).toHaveLength(3);
        expect(await f.publications()).toHaveLength(1);
        expect(await f.service.listConversations(f.endpoint.id)).toHaveLength(
          1,
        );
        expect(JSON.stringify(await f.actions())).not.toContain(
          "synthetic-command-interaction-token",
        );
      } finally {
        await f.close();
      }
    });

    it.each([
      "missing owner",
      "viewer",
      "stale generation",
      "replaced Gateway lease",
    ])(
      "denies a previously accepted command after %s without another action or public receipt",
      async (reason) => {
        const f = await commandFixture();
        try {
          const first = f.interaction("status");
          await f.adapter.handleGatewayInteraction(first);
          expect(first.editReply).toHaveBeenCalledWith(
            expect.objectContaining({
              content: expect.stringContaining(f.conversation.issueIdentifier!),
            }),
          );
          const before = await f.actions();
          expect(before).toHaveLength(1);
          const current = await readChatEndpointsById(f.endpoint.id)
            .then((rows) => rows[0]!);
          if (reason === "missing owner")
            await db
              .delete(chatDiscordCommandOwners)
              .where(
                eq(chatDiscordCommandOwners.applicationId, f.applicationId),
              );
          if (reason === "unconfirmed registration")
            await db
              .update(chatActions)
              .set({ result: { outcome: "unknown" } })
              .where(
                and(
                  eq(chatActions.endpointId, f.endpoint.id),
                  eq(chatActions.kind, "discord_command_registration"),
                ),
              );
          if (reason === "disabled capability")
            await db
              .update(chatEndpoints)
              .set({
                capabilities: { ...current.capabilities, slashCommands: false },
              })
              .where(eq(chatEndpoints.id, current.id));
          if (reason === "altered origin fence")
            await db
              .update(chatActions)
              .set({
                payload: {
                  ...before[0]!.payload,
                  runtimeFence: {
                    ...(before[0]!.payload.runtimeFence as object),
                    generation: 999999,
                  },
                },
              })
              .where(eq(chatActions.id, before[0]!.id));
          if (reason === "viewer")
            await db
              .update(companyMemberships)
              .set({ membershipRole: "viewer" })
              .where(
                and(
                  eq(companyMemberships.companyId, f.fixture.companyId),
                  eq(companyMemberships.principalId, "owner-user"),
                ),
              );
          if (reason === "disabled reach")
            await db
              .update(chatEndpointResources)
              .set({ enabled: false })
              .where(
                and(
                  eq(chatEndpointResources.endpointId, f.endpoint.id),
                  eq(chatEndpointResources.providerResourceId, channelId),
                ),
              );
          if (reason === "disabled connection")
            await db
              .update(toolConnections)
              .set({ enabled: false })
              .where(eq(toolConnections.id, current.connectionId));
          if (reason === "stale generation")
            await db
              .update(chatEndpoints)
              .set({
                setup: {
                  ...current.setup,
                  runtimeGeneration:
                    Number((current.setup as InternalSetupState).runtimeGeneration ?? 0) + 1,
                } as InternalSetupState,
              })
              .where(eq(chatEndpoints.id, current.id));
          if (reason === "replaced Gateway lease")
            await db
              .update(chatEndpointLeases)
              .set({ token: randomUUID() })
              .where(
                and(
                  eq(chatEndpointLeases.endpointId, f.endpoint.id),
                  eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
                ),
              );
          const afterRevocation = await f.actions();
          const replay = f.interaction("status", { id: first.id });
          await (await f.parser()).handleGatewayInteraction(replay);
          expect(replay.deferReply).toHaveBeenCalledExactlyOnceWith({
            flags: 64,
          });
          expect(replay.editReply).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              content: expect.stringContaining("not available"),
            }),
          );
          expect(await f.actions()).toEqual(afterRevocation);
          expect(await f.publications()).toHaveLength(0);
        } finally {
          await f.close();
        }
      },
    );

    it("serializes simultaneous exact close deliveries and denies a changed command or registered ID", async () => {
      const f = await commandFixture();
      try {
        const first = f.interaction("close");
        const duplicate = f.interaction("close", { id: first.id });
        const other = await f.parser();
        await Promise.all([
          f.adapter.handleGatewayInteraction(first),
          other.handleGatewayInteraction(duplicate),
        ]);
        for (const command of [first, duplicate])
          expect(command.editReply).toHaveBeenCalledWith(
            expect.objectContaining({
              content: expect.stringContaining("recorded"),
            }),
          );
        const before = await f.actions();
        expect(before).toHaveLength(1);
        expect(await f.publications()).toHaveLength(1);
        const changed = f.interaction("new", { id: first.id });
        await (await f.parser()).handleGatewayInteraction(changed);
        expect(changed.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("not available"),
          }),
        );
        const changedActor = f.interaction("close", {
          id: first.id,
          user: {
            id: "444444444444444420",
            username: "other",
            bot: false,
            discriminator: "0",
          },
        });
        await (await f.parser()).handleGatewayInteraction(changedActor);
        expect(changedActor.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("not available"),
          }),
        );
        const unregistered = f.interaction("close", {
          commandId: "888888888888888820",
        });
        await (await f.parser()).handleGatewayInteraction(unregistered);
        expect(unregistered.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("not available"),
          }),
        );
        expect(await f.actions()).toEqual(before);
        expect(await f.publications()).toHaveLength(1);
      } finally {
        await f.close();
      }
    });

    it("records DM new once and never applies its old replay to a replacement conversation", async () => {
      const f = await commandFixture();
      try {
        const dmId = "666666666666666619";
        const dmThreadId = `discord:@me:${dmId}`;
        const thread = f.runtime
          .get(f.endpoint.id)!
          .thread(dmThreadId) as unknown as Thread;
        const message = (id: string, text: string) =>
          ({
            ...makeMessage({ id, text, userId: externalUserId }),
            threadId: dmThreadId,
          }) as Message;
        const receive = async (id: string, text: string) => {
          await f.callbacks.onMessage({
            endpointId: f.endpoint.id,
            provider: "discord",
            trigger: "direct_message",
            thread,
            message: message(id, text),
          });
          const delivery = await db
            .select()
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, f.endpoint.id),
                eq(chatDeliveries.providerEventId, `${dmThreadId}:${id}`),
              ),
            )
            .then((rows) => rows[0]);
          if (!delivery) throw new Error("DM fixture delivery absent");
          await f.service.processPendingDeliveries(25, delivery.id);
          expect(
            await db
              .select({
                state: chatDeliveries.state,
                error: chatDeliveries.redactedError,
              })
              .from(chatDeliveries)
              .where(eq(chatDeliveries.id, delivery.id)),
          ).toEqual([expect.objectContaining({ state: "processed" })]);
        };
        await receive("555555555555555620", "Investigate the original DM task");
        const old = await db
          .select()
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.endpointId, f.endpoint.id),
              eq(chatConversations.externalThreadId, dmThreadId),
            ),
          )
          .then((rows) => rows[0]!);
        expect(old).toMatchObject({
          state: "active",
          isDirectMessage: true,
          sessionGeneration: 1,
        });
        const dm = {
          context: 1,
          guildId: null,
          channelId: dmId,
          channel: { id: dmId, type: 1 },
          authorizingIntegrationOwners: { guildId: "0", userId: null },
        };
        const next = f.interaction("new", dm);
        await f.adapter.handleGatewayInteraction(next);
        expect(next.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("recorded"),
          }),
        );
        expect((await f.publications())[0]).toMatchObject({
          state: "pending",
          conversationId: old.id,
        });
        await f.service.processPendingPublications(100);
        expect((await f.publications())[0]).toMatchObject({
          state: "published",
        });
        await receive(
          (((BigInt(Date.now()) - 1420070400000n) << 22n) + 1000n).toString(),
          "Start the replacement DM task",
        );
        const conversations = await db
          .select()
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.endpointId, f.endpoint.id),
              eq(chatConversations.externalThreadId, dmThreadId),
            ),
          )
          .orderBy(asc(chatConversations.sessionGeneration));
        expect(conversations).toHaveLength(2);
        expect(conversations[0]).toMatchObject({
          id: old.id,
          state: "completed",
          sessionGeneration: 1,
        });
        expect(conversations[1]).toMatchObject({
          state: "active",
          sessionGeneration: 2,
        });
        expect(conversations[1]!.issueId).not.toBe(old.issueId);
        const wakeCount = f.wakeup.mock.calls.length;
        const replay = f.interaction("new", { ...dm, id: next.id });
        await (await f.parser()).handleGatewayInteraction(replay);
        expect(replay.editReply).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining("recorded"),
          }),
        );
        expect(await f.actions()).toHaveLength(1);
        expect(await f.publications()).toHaveLength(1);
        expect(
          (
            await readChatConversationsById(conversations[1]!.id)
          )[0]?.state,
        ).toBe("active");
        expect(f.wakeup).toHaveBeenCalledTimes(wakeCount);
        for (const [offset, command] of [
          [1n, "new"],
          [2n, "close"],
        ] as const) {
          const stale = f.interaction(command, {
            ...dm,
            id: (BigInt(next.id) - offset).toString(),
          });
          await f.adapter.handleGatewayInteraction(stale);
          expect(stale.editReply).toHaveBeenCalledWith(
            expect.objectContaining({
              content: expect.stringContaining("predates"),
            }),
          );
          expect(await f.publications()).toHaveLength(1);
          expect(
            (
              await readChatConversationsById(conversations[1]!.id)
            )[0]?.state,
          ).toBe("active");
          expect(f.wakeup).toHaveBeenCalledTimes(wakeCount);
        }
      } finally {
        await f.close();
      }
    });

    it.each(["retired runtime", "replaced lease"] as const)(
      "acknowledges privately before a blocked DB wait but denies %s before commit",
      async (loss) => {
        const f = await commandFixture();
        let release = () => {};
        let blocker: Promise<unknown> | undefined;
        let delivery: Promise<void> | undefined;
        try {
          const current = await readChatEndpointsById(f.endpoint.id)
            .then((rows) => rows[0]!);
          let locked = () => {};
          const acquired = new Promise<void>((resolve) => {
            locked = resolve;
          });
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          blocker = db.transaction(async (tx) => {
            await tx
              .select()
              .from(toolConnections)
              .where(eq(toolConnections.id, current.connectionId))
              .for("no key update");
            locked();
            await held;
          });
          await acquired;
          const command = f.interaction("close");
          delivery = f.adapter.handleGatewayInteraction(command);
          await expect.poll(() => command.deferReply.mock.calls.length).toBe(1);
          await expect
            .poll(async () => {
              try {
                await db.transaction(async (tx) => {
                  await tx
                    .select()
                    .from(chatEndpoints)
                    .where(eq(chatEndpoints.id, f.endpoint.id))
                    .for("no key update", { noWait: true });
                });
                return false;
              } catch (error) {
                const code =
                  (error as { code?: unknown; cause?: { code?: unknown } })
                    .cause?.code ?? (error as { code?: unknown }).code;
                if (code !== "55P03") throw error;
                return true;
              }
            })
            .toBe(true);
          expect(command.editReply).not.toHaveBeenCalled();
          if (loss === "retired runtime")
            await f.runtime.removeEndpoint(f.endpoint.id);
          else
            await db
              .update(chatEndpointLeases)
              .set({ token: randomUUID() })
              .where(
                and(
                  eq(chatEndpointLeases.endpointId, f.endpoint.id),
                  eq(chatEndpointLeases.leaseKey, "discord_gateway_runtime"),
                ),
              );
          release();
          await blocker;
          await delivery;
          expect(command.editReply).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              content: expect.stringContaining("not available"),
            }),
          );
          expect(await f.actions()).toHaveLength(0);
          expect(await f.publications()).toHaveLength(0);
          expect(
            (
              await readChatConversationsById(f.conversation.id)
            )[0]?.state,
          ).toBe("active");
        } finally {
          release();
          try {
            await blocker;
            await delivery;
          } finally {
            await f.close();
          }
        }
      },
    );

    describe("fresh-after-close publication bindings", () => {
      let lastFreshDiscordMessageId = 0n;
      const freshDiscordMessageId = () => {
        const current = ((BigInt(Date.now()) - 1420070400000n) << 22n) + 1000n;
        lastFreshDiscordMessageId =
          current > lastFreshDiscordMessageId
            ? current
            : lastFreshDiscordMessageId + 1n;
        return lastFreshDiscordMessageId.toString();
      };
      async function reopenedFixture(includeDuringConfirmationSource = false, companyId?: string) {
        const f = await commandFixture(companyId);
        const threadId = `discord:${guildId}:${channelId}:${rootMessageId}`;
        const admitMessage = async (message: ReturnType<typeof makeMessage>) => {
          await deliverMessage({
            callbacks: f.callbacks,
            endpointId: f.endpoint.id,
            provider: "discord",
            thread: makeThread({
              id: threadId,
              channelId: f.conversation.externalConversationId,
              name: "reopened",
            }).thread,
            message,
            trigger: "mention",
          });
          const [delivery] = await db
            .select()
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, f.endpoint.id),
                sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${message.id}`,
              ),
            );
          if (!delivery) throw new Error("Expected exact source delivery");
          await f.service.processPendingDeliveries(25, delivery.id);
          return delivery;
        };
        const bindRun = async (messageId: string, admitted = true) => {
          const context = await chatWakeContext({
            endpointId: f.endpoint.id,
            issueId: f.conversation.issueId,
            provider: "discord",
            providerMessageId: messageId,
          });
          const [action] = await db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, f.endpoint.id),
                eq(chatActions.kind, "inbound_wakeup"),
                sql`${chatActions.payload}->>'commentId' = ${context.wakeCommentId}`,
              ),
            );
          if (!action) throw new Error("Expected admitted source action");
          const runId = randomUUID();
          // The fixture heartbeat does not execute a model. Persist the exact
          // scheduler linkage for the already admitted source, then exercise
          // real binding/milestone/final publication code, not an auth mock.
          await db.insert(heartbeatRuns).values({
            id: runId,
            companyId: f.fixture.companyId,
            agentId: f.fixture.assignedAgentId,
            runtimeMode: "native",
            nativeIssueId: f.conversation.issueId,
            status: "running",
            wakeupRequestId: admitted ? action.id : null,
            startedAt: new Date(),
            contextSnapshot: {
              ...context,
              endpointId: f.endpoint.id,
              paperclipHarnessCheckedOut: true,
            },
          });
          if (admitted) {
            const receipt = await db
              .update(agentWakeupRequests)
              .set({ runId, status: "claimed" })
              .where(eq(agentWakeupRequests.id, action.id))
              .returning({ id: agentWakeupRequests.id });
            expect(receipt).toHaveLength(1);
          }
          return { runId, action, context };
        };
        const historical = await bindRun(rootMessageId, false);
        const oldMessage = makeMessage({
          id: "555555555555555620",
          text: "@maya old request before close",
          mentioned: true,
          userId: externalUserId,
        });
        await admitMessage(oldMessage);
        const old = await bindRun(oldMessage.id);
        await db
          .update(heartbeatRuns)
          .set({ status: "succeeded", finishedAt: new Date() })
          .where(inArray(heartbeatRuns.id, [old.runId, historical.runId]));
        const controlInvocation = f.interaction("close");
        await f.adapter.handleGatewayInteraction(controlInvocation);
        let duringConfirmation: { runId: string; receivedAt: Date } | null = null;
        if (includeDuringConfirmationSource) {
          const messageId = freshDiscordMessageId();
          const message = makeMessage({
            id: messageId,
            text: "@maya this source was already admitted before close committed",
            mentioned: true,
            userId: externalUserId,
          });
          message.metadata.dateSent = new Date(
            Number((BigInt(messageId) >> 22n) + 1420070400000n),
          );
          const delivery = await admitMessage(message);
          const admitted = await bindRun(messageId);
          duringConfirmation = {
            runId: admitted.runId,
            receivedAt: delivery.receivedAt,
          };
        }
        await f.service.processPendingPublications();
        const [control] = await f.publications();
        expect(control).toMatchObject({
          state: "published",
          conversationId: f.conversation.id,
        });
        expect((await f.service.listConversations(f.endpoint.id))[0]?.state).toBe(
          "completed",
        );
        const messageId = freshDiscordMessageId();
        const freshMessage = makeMessage({
          id: messageId,
          text: "@maya reply to this fresh request",
          mentioned: true,
          userId: externalUserId,
        });
        const delivery = await admitMessage(freshMessage);
        const fresh = await bindRun(messageId);
        expect((await f.service.listConversations(f.endpoint.id))[0]).toMatchObject(
          {
            id: f.conversation.id,
            state: "active",
            sessionGeneration: f.conversation.sessionGeneration,
          },
        );
        return {
          ...f,
          old,
          historical,
          fresh,
          delivery,
          control,
          controlInvocation,
          duringConfirmation,
          admitMessage,
          bindRun,
        };
      }

      it.each(["action", "delivery"] as const)("wakes a post-close milestone when interrupted inbound acceptance settles its %s receipt", async receipt => {
        const f = await reopenedFixture();
        const onError = vi.fn();
        const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
        const notice = () => db.select().from(chatPublications).where(and(
          eq(chatPublications.issueId, f.conversation.issueId),
          eq(chatPublications.idempotencyKey, `run:${f.fresh.runId}:working:${f.endpoint.id}`),
        ));
        try {
          // Crash boundary: the run/wake is durable, but its inbound action has
          // not yet recorded settlement. Recovery must not dispatch it again.
          if (receipt === "action") {
            await db.update(chatActions).set({ status: "issued", result: {}, updatedAt: new Date() })
              .where(eq(chatActions.id, f.fresh.action.id));
          } else {
            // Operator repair of a failed ledger keeps the already-admitted
            // action/run. Only delivery acceptance needs to commit again.
            await db.update(chatDeliveries).set({ state: "retry", processedAt: null, nextAttemptAt: null })
              .where(eq(chatDeliveries.id, f.delivery.id));
          }
          await chatRunMilestoneWork(db).register(coordinator, () => true).ready;
          await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull());
          expect(await notice()).toEqual([]);
          const wakesBefore = f.wakeup.mock.calls.length;
          await expect.poll(async () => {
            await f.service.processPendingDeliveries(25, f.delivery.id);
            const [action] = await db.select().from(chatActions).where(eq(chatActions.id, f.fresh.action.id));
            const [delivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, f.delivery.id));
            return [action.status, delivery.state];
          }, { timeout: 10_000 }).toEqual(["processed", "processed"]);
          expect(f.wakeup.mock.calls.length).toBe(wakesBefore);
          await expect.poll(notice, { timeout: 5000 }).toEqual([
            expect.objectContaining({ idempotencyKey: `run:${f.fresh.runId}:working:${f.endpoint.id}` }),
          ]);
          await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull());
          expect(onError).not.toHaveBeenCalled();
        } finally { await coordinator.stop(); await f.close(); }
      });

      it.each(["connection", "identity", "visibility", "cloud_sync"])(
        "wakes a post-close milestone when %s authority is restored", async owner => {
          const stackId = randomUUID();
          const f = await reopenedFixture(false, owner === "cloud_sync" ? cloudTenantPrimaryCompanyId(stackId) : undefined);
          const previousToken = process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
          const [previousUser] = owner === "cloud_sync"
            ? await db.select().from(authUsers).where(eq(authUsers.id, "owner-user"))
            : [];
          const onError = vi.fn();
          const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
          const notice = () => db.select().from(chatPublications).where(and(
            eq(chatPublications.issueId, f.conversation.issueId),
            eq(chatPublications.idempotencyKey, `run:${f.fresh.runId}:working:${f.endpoint.id}`),
          ));
          const access = accessService(db);
          const membership = (await db.select().from(companyMemberships).where(and(
            eq(companyMemberships.companyId, f.fixture.companyId), eq(companyMemberships.principalId, "owner-user"),
          )))[0];
          try {
            let restore: () => Promise<unknown>;
            if (owner === "connection") {
              await toolAccessService(db).updateConnection(f.endpoint.connectionId, { enabled: false });
              restore = () => toolAccessService(db).updateConnection(f.endpoint.connectionId, { enabled: true });
            } else if (owner === "resource") {
              const [conversation] = await db.select().from(chatConversations).where(eq(chatConversations.id, f.conversation.id));
              expect(conversation.resourceId).not.toBeNull();
              await f.service.replaceResources(f.endpoint.id, [{ id: conversation.resourceId!, enabled: false }], "owner-user");
              restore = () => f.service.replaceResources(f.endpoint.id, [{ id: conversation.resourceId!, enabled: true }], "owner-user");
            } else if (owner === "identity" || owner === "unlinked") {
              await f.service.update(f.endpoint.id, { allowUnlinkedPeople: false }, "owner-user");
              await f.service.revokeLink(f.endpoint.id, f.fresh.action.principalId!);
              if (owner === "unlinked") {
                restore = () => f.service.update(f.endpoint.id, { allowUnlinkedPeople: true }, "owner-user");
              } else {
                const intent = await f.service.createLinkIntent(f.endpoint.id, f.fresh.action.principalId!, 1800);
                restore = () => f.service.confirmIdentityLink(new URL(intent.confirmationUrl).searchParams.get("token")!, "owner-user");
              }
            } else if (owner === "visibility") {
              await issueService(db).update(f.conversation.issueId, { hiddenAt: new Date() });
              restore = () => issueService(db).update(f.conversation.issueId, { hiddenAt: null });
            } else {
              // Model existing denied authority without exercising revocation's
              // unrelated credential cleanup; restoration uses its actual owner.
              await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.id, membership.id));
              if (owner === "member") restore = () => access.updateMember(f.fixture.companyId, membership.id, { status: "active" });
              else if (owner === "member_permissions") restore = () => access.updateMemberAndPermissions(f.fixture.companyId, membership.id, { status: "active", grants: [] }, "owner-user");
              else if (owner === "cloud_sync") {
                process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "milestone-cloud-sync-test";
                let request = 0;
                restore = () => resolveCloudTenantActor(db, cloudActorHeaderSourceFromHeaders({
                  "x-paperclip-cloud-tenant-token": "milestone-cloud-sync-test",
                  "x-paperclip-cloud-user-id": "owner-user",
                  "x-paperclip-cloud-user-email": "owner@example.test",
                  // Change the profile to force an actual sync on replay. The
                  // debounce must not hide repeated unchanged membership wakes.
                  "x-paperclip-cloud-user-name": `Owner ${request++}`,
                  "x-paperclip-cloud-stack-id": stackId,
                  "x-paperclip-cloud-stack-role": "owner",
                }));
              }
              else if (owner === "ensure_membership") restore = () => access.ensureMembership(f.fixture.companyId, "user", "owner-user", membership.membershipRole, "active");
              else {
                const existing = await db.select().from(companyMemberships).where(and(
                  eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, "owner-user"),
                ));
                restore = () => access.setUserCompanyAccess("owner-user", existing.map(row => row.companyId));
              }
            }
            await chatRunMilestoneWork(db).register(coordinator, () => true).ready;
            await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull());
            expect(await notice()).toEqual([]);
            await restore();
            await expect.poll(notice, { timeout: 5000 }).toEqual([
              expect.objectContaining({ idempotencyKey: `run:${f.fresh.runId}:working:${f.endpoint.id}` }),
            ]);
            await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull());
            if (owner !== "identity" && owner !== "connection") {
              const notices: string[] = [];
              const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatRunMilestones, event => notices.push(event));
              try { await restore(); expect(notices).toEqual([]); }
              finally { unsubscribe(); }
              expect(await notice()).toHaveLength(1);
            }
            expect(onError).not.toHaveBeenCalled();
          } finally {
            if (previousToken === undefined) delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
            else process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = previousToken;
            await coordinator.stop();
            if (previousUser) await db.update(authUsers).set({
              name: previousUser.name, email: previousUser.email,
              emailVerified: previousUser.emailVerified, updatedAt: previousUser.updatedAt,
            }).where(eq(authUsers.id, previousUser.id));
            await f.close();
          }
        },
      );

      it.each(["identity", "visibility"])(
        "wakes saved post-close native progress when %s authority returns", async owner => {
          const f = await reopenedFixture();
          const onError = vi.fn();
          const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
          const progress = () => db.select().from(chatPublications).where(and(
            eq(chatPublications.issueId, f.conversation.issueId), like(chatPublications.idempotencyKey, "%:native:%"),
          ));
          try {
            await db.insert(chatPublications).values({
              companyId: f.fixture.companyId, endpointId: f.endpoint.id,
              conversationId: f.conversation.id, issueId: f.conversation.issueId,
              idempotencyKey: `run:${f.fresh.runId}:working:${f.endpoint.id}`,
              payload: { text: "Maya is working…", progressState: "working" }, state: "published",
              createdAt: new Date(Date.now() - 60_000),
            });
            await db.insert(heartbeatRunEvents).values({
              companyId: f.fixture.companyId, agentId: f.fixture.assignedAgentId,
              runId: f.fresh.runId, seq: 1, eventType: "item.completed",
            });
            let restore: () => Promise<unknown>;
            if (owner === "identity") {
              await f.service.update(f.endpoint.id, { allowUnlinkedPeople: false }, "owner-user");
              await f.service.revokeLink(f.endpoint.id, f.fresh.action.principalId!);
              const intent = await f.service.createLinkIntent(f.endpoint.id, f.fresh.action.principalId!, 1800);
              restore = () => f.service.confirmIdentityLink(new URL(intent.confirmationUrl).searchParams.get("token")!, "owner-user");
            } else if (owner === "resource") {
              const [conversation] = await db.select().from(chatConversations).where(eq(chatConversations.id, f.conversation.id));
              expect(conversation.resourceId).not.toBeNull();
              await f.service.replaceResources(f.endpoint.id, [{ id: conversation.resourceId!, enabled: false }], "owner-user");
              restore = () => f.service.replaceResources(f.endpoint.id, [{ id: conversation.resourceId!, enabled: true }], "owner-user");
            } else {
              await issueService(db).update(f.conversation.issueId, { hiddenAt: new Date() });
              restore = () => issueService(db).update(f.conversation.issueId, { hiddenAt: null });
            }
            await nativeChatProgressWork(db).register(coordinator, () => true).ready;
            await vi.waitFor(() => { expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0); });
            expect(await progress()).toEqual([]);
            await restore();
            await expect.poll(progress, { timeout: 5000 }).toEqual([
              expect.objectContaining({ idempotencyKey: `run:${f.fresh.runId}:working:${f.endpoint.id}:native:making_progress:1` }),
            ]);
            await vi.waitFor(() => { expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0); });
            const select = vi.spyOn(db, "select");
            try { await new Promise(resolve => setTimeout(resolve, 250)); expect(select).not.toHaveBeenCalled(); }
            finally { select.mockRestore(); }
            expect(onError).not.toHaveBeenCalled();
          } finally { await coordinator.stop(); await f.close(); }
        },
      );

      it("publishes working and the exact fresh final after pinned close without resurrecting the old source", async () => {
        const f = await reopenedFixture();
        try {
          const scope = {
            companyId: f.fixture.companyId,
            issueId: f.conversation.issueId,
          };
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              ...scope,
              runId: f.old.runId,
            }),
          ).resolves.toBe("internal_agent_write");
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              ...scope,
              runId: f.historical.runId,
            }),
          ).resolves.toBe("internal_agent_write");
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              ...scope,
              runId: f.fresh.runId,
            }),
          ).resolves.toBe("allow_chat_run_presentation");
          await enqueueChatRunMilestones(db);
          await f.service.processPendingPublications();
          expect(
            f.runtime.get(f.endpoint.id)?.posts.map((post) => post.text),
          ).toContain("Maya is working…");
          await db
            .update(heartbeatRuns)
            .set({ status: "succeeded", finishedAt: new Date() })
            .where(eq(heartbeatRuns.id, f.fresh.runId));
          const comment = await addSelectedChatFinal({
            ...scope,
            agentId: f.fixture.assignedAgentId,
            runId: f.fresh.runId,
            body: "DISCORD-FRESH-AFTER-CLOSE",
          });
          await f.service.processPendingPublications();
          const publications = await readChatPublicationsByCommentId(comment.id);
          expect(publications).toEqual([
            expect.objectContaining({
              conversationId: f.conversation.id,
              state: "published",
              attempts: 1,
              payload: { text: "DISCORD-FRESH-AFTER-CLOSE" },
            }),
          ]);
          expect((await f.publications())[0]).toEqual(f.control);
        } finally {
          await f.close();
        }
      });

      it("allows an admitted source sent after close command but before close confirmation to present", async () => {
        const f = await reopenedFixture();
        try {
          const commandTime = Number(
            (BigInt(f.controlInvocation.id) >> 22n) + 1420070400000n,
          );
          const sourceTime = commandTime + 1;
          expect(sourceTime).toBeLessThan(f.control.publishedAt!.getTime());
          const message = makeMessage({
            id: (((BigInt(sourceTime) - 1420070400000n) << 22n) + 1001n).toString(),
            text: "@maya answer this genuinely post-command request",
            mentioned: true,
            userId: externalUserId,
          });
          message.metadata.dateSent = new Date(sourceTime);
          const delivery = await f.admitMessage(message);
          expect(delivery).toMatchObject({
            state: "processed",
            conversationId: f.conversation.id,
          });
          expect(delivery.receivedAt.getTime()).toBeGreaterThan(
            f.control.publishedAt!.getTime(),
          );
          const admitted = await f.bindRun(message.id);
          expect(admitted.action.status).toBe("processed");
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              companyId: f.fixture.companyId,
              issueId: f.conversation.issueId,
              runId: admitted.runId,
            }),
          ).resolves.toBe("allow_chat_run_presentation");
        } finally {
          await f.close();
        }
      });

      it("keeps a source admitted before close confirmation internal after a fresh source reopens", async () => {
        const f = await reopenedFixture(true);
        try {
          expect(f.duringConfirmation).not.toBeNull();
          expect(f.duringConfirmation!.receivedAt.getTime()).toBeLessThan(
            f.control.publishedAt!.getTime(),
          );
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              companyId: f.fixture.companyId,
              issueId: f.conversation.issueId,
              runId: f.duringConfirmation!.runId,
            }),
          ).resolves.toBe("internal_agent_write");
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              companyId: f.fixture.companyId,
              issueId: f.conversation.issueId,
              runId: f.fresh.runId,
            }),
          ).resolves.toBe("allow_chat_run_presentation");
        } finally {
          await f.close();
        }
      });

      it.each(["only_unproven", "newer_issue_mismatch"] as const)(
        "does not grant presentation across a published control with %s proof",
        async (mode) => {
          const f = await reopenedFixture();
          try {
            let control = f.control;
            let source = f.fresh;
            if (mode !== "only_unproven") {
              await f.adapter.handleGatewayInteraction(f.interaction("close"));
              await f.service.processPendingPublications();
              control = (await f.publications()).find(
                (row) => row.id !== f.control.id,
              )!;
              expect(control.state).toBe("published");
              const messageId = freshDiscordMessageId();
              const message = makeMessage({
                id: messageId,
                text: "@maya a genuinely fresh source still needs every control proof",
                mentioned: true,
                userId: externalUserId,
              });
              message.metadata.dateSent = new Date(
                Number((BigInt(messageId) >> 22n) + 1420070400000n),
              );
              expect((await f.admitMessage(message)).state).toBe("processed");
              source = await f.bindRun(messageId);
              await expect(
                resolveChatRunPresentationAuthorizationReason(db, {
                  companyId: f.fixture.companyId,
                  issueId: f.conversation.issueId,
                  runId: source.runId,
                }),
              ).resolves.toBe("allow_chat_run_presentation");
            }
            if (mode === "newer_issue_mismatch") {
              const unrelated = await issueService(db).create(f.fixture.companyId, {
                title: "Independent task must not supply control proof",
                createdByUserId: "owner-user",
              });
              await db
                .update(chatPublications)
                .set({ issueId: unrelated.id })
                .where(eq(chatPublications.id, control.id));
            } else {
              await db
                .update(chatActions)
                .set({ status: "issued" })
                .where(
                  eq(
                    chatActions.providerActionId,
                    `task-control-authorization:${control.id}`,
                  ),
                );
            }
            if (mode !== "only_unproven") {
              expect(
                (
                  await readChatActionsByProviderActionId(`task-control-authorization:${f.control.id}`)
                )[0]?.status,
              ).toBe("processed");
            }
            await expect(
              resolveChatRunPresentationAuthorizationReason(db, {
                companyId: f.fixture.companyId,
                issueId: f.conversation.issueId,
                runId: source.runId,
              }),
            ).resolves.toBe("internal_agent_write");
          } finally {
            await f.close();
          }
        },
      );

      it.each(["old_source", "fresh_source"] as const)(
        "does not let an automatic child copy %s presentation authority",
        async (source) => {
          const f = await reopenedFixture();
          try {
            const parent = source === "old_source" ? f.old : f.fresh;
            const runId = randomUUID(),
              wakeId = randomUUID();
            await db.insert(agentWakeupRequests).values({
              id: wakeId,
              companyId: f.fixture.companyId,
              agentId: f.fixture.assignedAgentId,
              source: "automation",
              triggerDetail: "system",
              reason: "issue_continuation_needed",
              requestedByActorType: "system",
              status: "queued",
              payload: {
                issueId: f.conversation.issueId,
                retryOfRunId: parent.runId,
              },
            });
            await db.insert(heartbeatRuns).values({
              id: runId,
              companyId: f.fixture.companyId,
              agentId: f.fixture.assignedAgentId,
              nativeIssueId: f.conversation.issueId,
              runtimeMode: "native",
              status: "running",
              startedAt: new Date(),
              wakeupRequestId: wakeId,
              retryOfRunId: parent.runId,
              contextSnapshot: {
                ...parent.context,
                endpointId: f.endpoint.id,
                paperclipHarnessCheckedOut: true,
              },
            });
            await db
              .update(agentWakeupRequests)
              .set({ runId, status: "claimed" })
              .where(eq(agentWakeupRequests.id, wakeId));
            await expect(
              resolveChatRunPresentationAuthorizationReason(db, {
                companyId: f.fixture.companyId,
                issueId: f.conversation.issueId,
                runId,
              }),
            ).resolves.toBe("internal_agent_write");
          } finally {
            await f.close();
          }
        },
      );

      it("does not drop an older coalesced source while selecting the fresh batch", async () => {
        const f = await reopenedFixture();
        try {
          await db
            .update(agentWakeupRequests)
            .set({
              status: "coalesced",
              runId: f.fresh.runId,
              payload: sql`${agentWakeupRequests.payload} || ${JSON.stringify({ coalescedIntoWakeupRequestId: f.fresh.action.id })}::jsonb`,
            })
            .where(eq(agentWakeupRequests.id, f.old.action.id));
          // The submitted context omits the old sibling. The receipt set, not
          // this mutable subset, must determine whether the batch is fresh.
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              companyId: f.fixture.companyId,
              issueId: f.conversation.issueId,
              runId: f.fresh.runId,
            }),
          ).resolves.toBe("internal_agent_write");
          await db
            .update(heartbeatRuns)
            .set({
              contextSnapshot: {
                ...f.fresh.context,
                endpointId: f.endpoint.id,
                paperclipHarnessCheckedOut: true,
                wakeCommentIds: [
                  f.old.context.wakeCommentId,
                  f.fresh.context.wakeCommentId,
                ],
              },
            })
            .where(eq(heartbeatRuns.id, f.fresh.runId));
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              companyId: f.fixture.companyId,
              issueId: f.conversation.issueId,
              runId: f.fresh.runId,
            }),
          ).resolves.toBe("internal_agent_write");
        } finally {
          await f.close();
        }
      });

      it("allows a complete freshly admitted coalesced batch", async () => {
        const f = await reopenedFixture();
        try {
          const secondMessage = makeMessage({
            id: freshDiscordMessageId(),
            text: "@maya include this fresh detail",
            mentioned: true,
            userId: externalUserId,
          });
          await f.admitMessage(secondMessage);
          const second = await chatWakeContext({
            endpointId: f.endpoint.id,
            issueId: f.conversation.issueId,
            provider: "discord",
            providerMessageId: secondMessage.id,
          });
          const [action] = await db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, f.endpoint.id),
                eq(chatActions.kind, "inbound_wakeup"),
                sql`${chatActions.payload}->>'commentId' = ${second.wakeCommentId}`,
              ),
            );
          const receipt = await db
            .update(agentWakeupRequests)
            .set({
              status: "coalesced",
              runId: f.fresh.runId,
              payload: sql`${agentWakeupRequests.payload} || ${JSON.stringify({ coalescedIntoWakeupRequestId: f.fresh.action.id })}::jsonb`,
            })
            .where(eq(agentWakeupRequests.id, action.id))
            .returning({ id: agentWakeupRequests.id });
          expect(receipt).toHaveLength(1);
          // Model the scheduler's queued-batch claim only after both actual
          // admissions. Coalescing execution itself has its own heartbeat tests.
          await db
            .update(heartbeatRuns)
            .set({
              startedAt: new Date(),
              contextSnapshot: {
                ...f.fresh.context,
                endpointId: f.endpoint.id,
                paperclipHarnessCheckedOut: true,
                wakeCommentIds: [
                  f.fresh.context.wakeCommentId,
                  second.wakeCommentId,
                ],
              },
            })
            .where(eq(heartbeatRuns.id, f.fresh.runId));
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              companyId: f.fixture.companyId,
              issueId: f.conversation.issueId,
              runId: f.fresh.runId,
            }),
          ).resolves.toBe("allow_chat_run_presentation");
        } finally {
          await f.close();
        }
      });

      it("keeps a newly closed source internal after a still newer source reopens the thread", async () => {
        const f = await reopenedFixture();
        try {
          await f.adapter.handleGatewayInteraction(f.interaction("close"));
          await f.service.processPendingPublications();
          const controls = await f.publications();
          expect(controls).toHaveLength(2);
          expect(controls.every((control) => control.state === "published")).toBe(
            true,
          );
          const nextMessage = makeMessage({
            id: freshDiscordMessageId(),
            text: "@maya genuinely new request after second close",
            mentioned: true,
            userId: externalUserId,
          });
          await f.admitMessage(nextMessage);
          const next = await f.bindRun(nextMessage.id);
          expect((await f.service.listConversations(f.endpoint.id))[0]?.state).toBe(
            "active",
          );
          const scope = {
            companyId: f.fixture.companyId,
            issueId: f.conversation.issueId,
          };
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              ...scope,
              runId: f.fresh.runId,
            }),
          ).resolves.toBe("internal_agent_write");
          await expect(
            resolveChatRunPresentationAuthorizationReason(db, {
              ...scope,
              runId: next.runId,
            }),
          ).resolves.toBe("allow_chat_run_presentation");
        } finally {
          await f.close();
        }
      });

      it.each(["delayed", "missing"] as const)(
        "refuses %s provider chronology at intake when first ingested after close",
        async (mode) => {
          const f = await reopenedFixture();
          try {
            const before = await db
              .select({ id: issueComments.id })
              .from(issueComments)
              .where(eq(issueComments.issueId, f.conversation.issueId))
              .orderBy(asc(issueComments.id));
            const message = makeMessage({
              id:
                mode === "delayed"
                  ? (BigInt(f.controlInvocation.id) - (5000n << 22n)).toString()
                  : "missing-provider-snowflake",
              text: "@maya this unseen source must not become fresh work",
              mentioned: true,
              userId: externalUserId,
            });
            const delivery = await f.admitMessage(message);
            expect(delivery.receivedAt.getTime()).toBeGreaterThan(
              f.control.publishedAt!.getTime(),
            );
            expect(delivery).toMatchObject({
              state: "filtered",
              conversationId: null,
            });
            expect(
              await db
                .select({ id: issueComments.id })
                .from(issueComments)
                .where(eq(issueComments.issueId, f.conversation.issueId))
                .orderBy(asc(issueComments.id)),
            ).toEqual(before);
            expect(
              await db
                .select()
                .from(chatActions)
                .where(
                  and(
                    eq(chatActions.deliveryId, delivery.id),
                    eq(chatActions.kind, "inbound_wakeup"),
                  ),
                ),
            ).toEqual([]);
          } finally {
            await f.close();
          }
        },
      );

      it("orders same-millisecond Discord sources only within the same worker and process", async () => {
        const f = await reopenedFixture();
        try {
          for (const offset of [-1n, 1n << 12n, 1n << 17n, 1n]) {
            const message = makeMessage({
              id: (BigInt(f.controlInvocation.id) + offset).toString(),
              text: "@maya same provider millisecond",
              mentioned: true,
              userId: externalUserId,
            });
            const delivery = await f.admitMessage(message);
            expect(delivery.state).toBe(offset === 1n ? "processed" : "filtered");
          }
        } finally {
          await f.close();
        }
      });

      it.each(["close", "new"] as const)(
        "does not let an unseen stale native Discord %s act on reopened work",
        async (command) => {
          const f = await reopenedFixture();
          try {
            const before = await f.publications();
            const stale = f.interaction(command, {
              id: (BigInt(f.controlInvocation.id) - 1n).toString(),
            });
            await f.adapter.handleGatewayInteraction(stale);
            expect(await f.publications()).toEqual(before);
            expect(
              (await f.service.listConversations(f.endpoint.id))[0]?.state,
            ).toBe("active");
            if (command === "close")
              expect(stale.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                  content: expect.stringContaining("predates"),
                }),
              );
            // Guild-thread /new remains guidance-only regardless of age.
          } finally {
            await f.close();
          }
        },
      );

      it.each([
        "edited",
        "generation",
        "revoked_access",
        "reassigned",
      ])(
        "does not cross a historical close after current %s authority changes",
        async (mode) => {
          const f = await reopenedFixture();
          try {
            if (mode === "edited")
              await db
                .update(issueComments)
                .set({ body: "Edited source", updatedAt: new Date() })
                .where(eq(issueComments.id, f.fresh.context.wakeCommentId));
            if (mode === "deleted")
              await db
                .update(issueComments)
                .set({ deletedAt: new Date() })
                .where(eq(issueComments.id, f.fresh.context.wakeCommentId));
            if (mode === "pending_lifecycle")
              await db.insert(chatDeliveries).values({
                companyId: f.fixture.companyId,
                endpointId: f.endpoint.id,
                conversationId: f.conversation.id,
                providerEventId: `edit:${randomUUID()}`,
                deduplicationKey: randomUUID(),
                eventKind: "message_updated",
                state: "received",
                normalizedEvent: {
                  runtimeContext: f.delivery.normalizedEvent.runtimeContext,
                  message: {
                    targetProviderEventId: f.delivery.providerEventId,
                  },
                },
              });
            if (mode === "generation")
              await db
                .update(chatConversations)
                .set({
                  sessionGeneration: f.conversation.sessionGeneration + 1,
                })
                .where(eq(chatConversations.id, f.conversation.id));
            if (mode === "runtime")
              await db
                .update(chatEndpoints)
                .set({
                  setup: sql`jsonb_set(${chatEndpoints.setup}, '{runtimeGeneration}', to_jsonb(coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::integer, 0) + 1))`,
                })
                .where(eq(chatEndpoints.id, f.endpoint.id));
            if (mode === "credentials")
              await db
                .update(toolConnections)
                .set({ credentialSecretRefs: [] })
                .where(eq(toolConnections.id, f.endpoint.connectionId));
            if (mode === "revoked_access") {
              await db
                .update(chatEndpoints)
                .set({ allowUnlinkedPeople: false })
                .where(eq(chatEndpoints.id, f.endpoint.id));
              await db
                .update(chatIdentityLinks)
                .set({ status: "revoked" })
                .where(
                  and(
                    eq(chatIdentityLinks.endpointId, f.endpoint.id),
                    eq(chatIdentityLinks.principalId, f.principal.id),
                  ),
                );
            }
            if (mode === "reach")
              await db
                .update(chatEndpointResources)
                .set({ enabled: false })
                .where(eq(chatEndpointResources.endpointId, f.endpoint.id));
            if (mode === "thread")
              await db
                .update(chatDeliveries)
                .set({
                  normalizedEvent: {
                    ...f.delivery.normalizedEvent,
                    conversation: {
                      ...(f.delivery.normalizedEvent.conversation as Record<
                        string,
                        unknown
                      >),
                      externalThreadId: "discord:foreign:thread",
                    },
                  },
                })
                .where(eq(chatDeliveries.id, f.delivery.id));
            if (mode === "unadmitted")
              await db
                .update(agentWakeupRequests)
                .set({ status: "skipped" })
                .where(eq(agentWakeupRequests.id, f.fresh.action.id));
            if (mode === "reassigned")
              await db
                .update(issues)
                .set({ assigneeAgentId: f.fixture.replacementAgentId })
                .where(eq(issues.id, f.conversation.issueId));
            await expect(
              resolveChatRunPresentationAuthorizationReason(db, {
                companyId: f.fixture.companyId,
                issueId: f.conversation.issueId,
                runId: f.fresh.runId,
              }),
            ).resolves.toBe("internal_agent_write");
            await enqueueChatRunMilestones(db);
            expect(
              await db
                .select()
                .from(chatPublications)
                .where(
                  like(chatPublications.idempotencyKey, `run:${f.fresh.runId}:%`),
                ),
            ).toEqual([]);
          } finally {
            await f.close();
          }
        },
      );
    });

    it("rolls back staged public control when the durable command receipt fails", async () => {
      const f = await commandFixture();
      const functionName = `discord_command_failure_${randomUUID().replaceAll("-", "")}`;
      const triggerName = `${functionName}_trigger`;
      try {
        // Synthetic PostgreSQL fault after the outbox insert, scoped only to
        // this endpoint. Provider error text must never become private content.
        await db.execute(
          sql.raw(
            `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.endpoint_id = '${f.endpoint.id}'::uuid AND NEW.kind = 'discord_native_command' THEN RAISE EXCEPTION 'PRIVATE-COMMAND-PERSISTENCE-DETAIL'; END IF; RETURN NEW; END $$`,
          ),
        );
        await db.execute(
          sql.raw(
            `CREATE TRIGGER ${triggerName} BEFORE INSERT ON chat_actions FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
          ),
        );
        const close = f.interaction("close");
        await f.adapter.handleGatewayInteraction(close);
        expect(close.deferReply).toHaveBeenCalledExactlyOnceWith({ flags: 64 });
        expect(close.editReply).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            content: expect.stringContaining("could not be confirmed"),
          }),
        );
        expect(JSON.stringify(close.editReply.mock.calls)).not.toContain(
          "PRIVATE-COMMAND",
        );
        expect(await f.actions()).toHaveLength(0);
        expect(await f.publications()).toHaveLength(0);
        expect(
          (
            await readChatConversationsById(f.conversation.id)
          )[0]?.state,
        ).toBe("active");
      } finally {
        try {
          await db.execute(
            sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON chat_actions`),
          );
          await db.execute(
            sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`),
          );
        } finally {
          await f.close();
        }
      }
    });
  });
});
