import { guardSlackFixtureNetwork } from "../helpers/slack-cloud/transport.js";
import { createChatRuntime } from "../../services/chat-runtime.js";
import { createHash, createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import request from "supertest";
import { and, eq, like, or, sql } from "drizzle-orm";
import { beforeAll, expect, it, vi } from "vitest";
import { activityLog, authUsers, chatActions, chatDeliveries, chatEndpoints, chatExternalPrincipals, chatPublications, chatSdkState, companyMemberships, issueQuestionResponseDeliveries, issueThreadInteractions } from "@paperclipai/db";
import { chatChannelService, type ChatChannelService } from "../../services/chat-channels.js";
import type { InternalSetupState } from "../../services/chat-channels/runtime-types.js";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import { type TestDb, slackProtocolCapture, describeEmbeddedPostgres, fakeSlackFetch, makeThread, makeMessage } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";

describeEmbeddedPostgres("chat channels: slack protocol", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const { fixtureServices, seedCompany, readChatDeliveriesByEndpointId, readIssueCommentsByCompanyId, receiptBackedWakeup, retirePublicationFixture, qualifySetupRoundTrip, configuredSlackEndpoint, deliverMessage } = h;

  it("recovers the visible receipt exactly once after wake acceptance contention", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    const first = makeThread({
      channelId: "C-RECEIPT-RETRY",
      id: "slack:C-RECEIPT-RETRY:1000.1",
      name: "receipt-retry",
    });
    const message = makeMessage({
      id: "1000.1",
      text: "@maya acknowledge this after retry",
      mentioned: true,
    });
    let releaseLock!: () => void;
    let lockEntered!: () => void;
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      lockEntered = resolve;
    });
    let lockTransaction: Promise<unknown> | undefined;
    first.subscribe.mockImplementationOnce(async () => {
      lockTransaction = db.transaction(async (tx) => {
        await tx
          .select({ id: chatEndpoints.id })
          .from(chatEndpoints)
          .where(eq(chatEndpoints.id, endpoint.id))
          .for("update");
        lockEntered();
        await holdLock;
      });
      await entered;
    });
    try {
      await expect(
        deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          thread: first.thread,
          message,
          trigger: "mention",
        }),
      ).rejects.toMatchObject({ cause: { code: "55P03" } });
      expect(wakeup).not.toHaveBeenCalled();
      expect(runtime.endpoints.get(endpoint.id)?.reactions).toEqual([]);
    } finally {
      releaseLock();
      await lockTransaction;
    }
    await vi.waitFor(
      async () => {
        await service.processPendingDeliveries();
        expect(wakeup).toHaveBeenCalledTimes(1);
        expect(runtime.endpoints.get(endpoint.id)?.reactions).toEqual([
          { threadId: first.thread.id, messageId: message.id, emoji: "eyes" },
        ]);
      },
      { timeout: 10_000 },
    );
    await service.processPendingDeliveries();
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(runtime.endpoints.get(endpoint.id)?.reactions).toHaveLength(1);
    const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(delivery).toMatchObject({ state: "processed" });
    expect(
      await readIssueCommentsByCompanyId(fixture.companyId),
    ).toHaveLength(1);
    await service.shutdown();
  });

  it.each(slackProtocolCapture ? ["warm", "command-delayed", "action-delayed", "submission-delayed"] as const : ["warm"] as const)("captures signed Slack forwarding protocol with registered owners (%s)", async mode => {
    const network = guardSlackFixtureNetwork({ requirePreload: slackProtocolCapture });
    let configured: Awaited<ReturnType<typeof configuredSlackEndpoint>> | undefined;
    let routedService: ChatChannelService | undefined;
    let actualRuntime: ReturnType<typeof createChatRuntime> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const fixture = await seedCompany();
      configured = await configuredSlackEndpoint(fixture);
      const { callbacks, endpoint, runtime, service, wakeup } = configured;
      actualRuntime = createChatRuntime();
      const custody: Array<{ lane: string; elapsedMs: number; acknowledgedWithin3s: boolean; originalTimestamp: string | null }> = [];
      const protocol: Array<{ method: string; triggerAgeMs?: number; outcome: string }> = [];
      let triggerCreatedAt = 0;
      const channelId = "C-SIGNED-MODAL";
      const threadTs = "1788.100";
      const externalUserId = `U-MODAL-${randomUUID()}`;
      const channel = makeThread({
        channelId,
        id: `slack:${channelId}:${threadTs}`,
        name: "signed-modal",
      });
      // Existing fixture helpers establish the endpoint, conversation and
      // published question. From block_actions onward, signed envelopes pass
      // through the real adapter/SDK/runtime and unmocked service callbacks.
      // Provider HTTP and the scheduler remain deterministic test boundaries.
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: channel.thread,
        message: makeMessage({
          id: threadTs,
          text: "@maya collect deployment details",
          mentioned: true,
          userId: externalUserId,
        }),
        trigger: "mention",
      });
      await qualifySetupRoundTrip(service, endpoint.id, externalUserId);
      await service.test(endpoint.id);
      const [conversation] = await service.listConversations(endpoint.id);
      if (!conversation) throw new Error("Expected signed modal conversation");
      const [principal] = await db
        .select()
        .from(chatExternalPrincipals)
        .where(
          and(
            eq(chatExternalPrincipals.companyId, fixture.companyId),
            eq(chatExternalPrincipals.provider, "slack"),
            eq(chatExternalPrincipals.externalId, externalUserId),
          ),
        );
      const linkedUserId = `signed-modal-user-${randomUUID()}`;
      const now = new Date();
      await db.insert(authUsers).values({
        id: linkedUserId,
        name: "Modal Operator",
        email: `${linkedUserId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(companyMemberships).values({
        companyId: fixture.companyId,
        principalType: "user",
        principalId: linkedUserId,
        status: "active",
        membershipRole: "operator",
      });
      const intent = await service.createLinkIntent(
        endpoint.id,
        principal.id,
        1_800,
      );
      const identityToken = new URL(intent.confirmationUrl).searchParams.get(
        "token",
      );
      if (!identityToken) throw new Error("Expected modal identity token");
      await service.confirmIdentityLink(identityToken, linkedUserId);
      const interaction = await issueThreadInteractionService(db).create(
        { id: conversation.issueId, companyId: fixture.companyId },
        {
          kind: "ask_user_questions",
          continuationPolicy: "wake_assignee",
          title: "Deployment details",
          payload: {
            version: 1,
            title: "Deployment details",
            submitLabel: "Continue",
            questions: [
              {
                id: "environment",
                prompt: "Where should I deploy?",
                selectionMode: "single",
                required: true,
                allowOther: false,
                options: [
                  { id: "staging", label: "Staging" },
                  { id: "production", label: "Production" },
                ],
              },
              {
                id: "reason",
                prompt: "What should the release note say?",
                selectionMode: "single",
                required: true,
                allowOther: true,
                options: [
                  {
                    id: "__paperclip_text__",
                    label: "Type an answer",
                    freeText: true,
                  },
                ],
              },
            ],
          },
        },
        { agentId: fixture.assignedAgentId },
      );
      runtime.endpoints.get(endpoint.id)!.postResultIds.push("1788.200");
      await service.processPendingPublications();
      const publication = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.endpointId, endpoint.id),
            eq(chatPublications.conversationId, conversation.id),
          ),
        )
        .then((rows) =>
          rows.find((row) => row.payload.interactionId === interaction.id),
        );
      const openAction = publication?.payload.card?.actions?.find(
        (action) => action.type === "callback",
      );
      if (!publication?.providerMessageId || openAction?.type !== "callback") {
        throw new Error("Expected published question form action");
      }
      const configuration = runtime.configurations.get(endpoint.id)!;
      if (
        configuration.providerConfig.provider !== "slack" ||
        !callbacks.onModalSubmit
      ) {
        throw new Error("Expected Slack provider and service modal callback");
      }
      const credentials = configuration.providerConfig.credentials;
      type SlackView = {
        callback_id: string;
        private_metadata: string;
        blocks: Array<{
          block_id: string;
          element: {
            type: string;
            action_id: string;
            options?: Array<{ text: { text: string }; value: string }>;
          };
        }>;
      };
      const views: SlackView[] = [];
      const exchangedTriggers = new Set<string>();
      const providerMethods: string[] = [];
      const unexpectedProviderMethods: string[] = [];
      const providerErrors: unknown[] = [];
      const providerTransport = vi.fn(async (config: { url: string; baseURL: string; data: string }) => {
        const target = new URL(config.url, config.baseURL);
        expect(target.hostname).toBe("127.0.0.1");
        const params = new URLSearchParams(config.data);
        const method = target.pathname.split("/").at(-1) ?? "";
        providerMethods.push(method);
        let result: unknown;
        if (method === "conversations.replies") {
          result = {
            ok: true,
            messages: [
              {
                type: "message",
                ts: publication.providerMessageId,
                thread_ts: threadTs,
                channel: channelId,
                user: credentials.botUserId,
                text: "Deployment details",
              },
            ],
          };
        } else if (method === "users.info") {
          result = {
            ok: true,
            user: {
              id: params.get("user"),
              name: "maya",
              real_name: "Maya",
              is_bot: true,
              profile: { display_name: "Maya" },
            },
          };
        } else if (method === "conversations.info") {
          result = { ok: true, channel: { id: channelId, name: "signed-modal", is_im: false } };
        } else if (method === "chat.postEphemeral") {
          result = { ok: true, message_ts: "1788.250" };
        } else if (method === "views.open") {
          const triggerAgeMs = Date.now() - triggerCreatedAt;
          const trigger = params.get("trigger_id")!;
          const expired = triggerAgeMs >= 3_000;
          const reused = exchangedTriggers.has(trigger);
          protocol.push({ method, triggerAgeMs, outcome: expired ? "trigger_expired" : reused ? "trigger_exchanged" : "opened" });
          if (expired || reused) result = { ok: false, error: expired ? "trigger_expired" : "trigger_exchanged" };
          else {
            exchangedTriggers.add(trigger);
            views.push(JSON.parse(params.get("view")!) as SlackView);
            result = { ok: true, view: { id: "V-SIGNED-MODAL" } };
          }
        } else {
          unexpectedProviderMethods.push(method);
          result = { ok: false, error: "unexpected_test_provider_method" };
        }
        return { data: result, status: 200, statusText: "OK", headers: {}, config, request: { path: target.pathname } };
      });
      const onSubmit = vi.fn(callbacks.onModalSubmit);
      const onAction = vi.fn(callbacks.onAction);
      const onCommand = vi.fn(callbacks.onSlashCommand);
      const replace = actualRuntime.replaceEndpoint.bind(actualRuntime);
      vi.spyOn(actualRuntime, "replaceEndpoint").mockImplementation(async input => {
        if (input.providerConfig.provider !== "slack") throw new Error("Unexpected fixture provider");
        onSubmit.mockImplementation(input.callbacks.onModalSubmit!);
        onAction.mockImplementation(input.callbacks.onAction!);
        onCommand.mockImplementation(input.callbacks.onSlashCommand!);
        const value = await replace({ ...input, logger: "silent",
          callbacks: { ...input.callbacks, onModalSubmit: onSubmit, onAction, onSlashCommand: onCommand },
          providerConfig: { ...input.providerConfig,
            credentials: { ...input.providerConfig.credentials, apiUrl: "http://127.0.0.1:1/api/" } } });
        const client = (value.getProviderAdapter() as unknown as { _client: {
          axios: { defaults: { adapter: unknown } }; views: { open(options: unknown): Promise<unknown> };
        } })._client;
        const open = client.views.open.bind(client.views);
        client.views.open = async options => {
          try { return await open(options); } catch (error) { providerErrors.push(error); throw error; }
        };
        client.axios.defaults.adapter = providerTransport;
        return value;
      });
      routedService = chatChannelService(db, { runtime: actualRuntime,
        fetch: fakeSlackFetch() as typeof globalThis.fetch,
        heartbeat: { wakeup: receiptBackedWakeup(wakeup) }, publicBaseUrl: "https://paperclip.example" });
      fixtureServices.add(routedService);
      const callbackUrl = `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/slack`;
      const forward = async (request: Request, lane: string) => {
        const startedAt = Date.now();
        const originalTimestamp = request.headers.get("x-slack-request-timestamp");
        const originalSignature = request.headers.get("x-slack-signature");
        const originalBody = await request.clone().text();
        if (mode === "command-delayed" && lane === "command" || mode === "action-delayed" && lane === "action" || mode === "submission-delayed" && lane === "invalid_submission")
          await new Promise(resolve => setTimeout(resolve, 3_500)); // test-budget:allow-sleep: tests Slack 3s webhook acknowledgment deadline
        const response = await routedService!.handleWebhook(endpoint.publicId, "slack", request);
        const elapsedMs = Date.now() - startedAt;
        custody.push({ lane, elapsedMs, acknowledgedWithin3s: elapsedMs < 3_000, originalTimestamp });
        expect(request.headers.get("x-slack-request-timestamp")).toBe(originalTimestamp);
        expect(request.headers.get("x-slack-signature")).toBe(originalSignature);
        expect(originalSignature).toBe(`v0=${createHmac("sha256", credentials.signingSecret!).update(`v0:${originalTimestamp}:${originalBody}`).digest("hex")}`);
        return response;
      };
      const signed = (payload: unknown) => {
        const body = new URLSearchParams({
          payload: JSON.stringify(payload),
        }).toString();
        const timestamp = String(Math.floor(Date.now() / 1_000));
        const signature = createHmac("sha256", credentials.signingSecret!)
          .update(`v0:${timestamp}:${body}`)
          .digest("hex");
        return new Request(callbackUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": `v0=${signature}`,
          },
          body,
        });
      };
      const wireUser = {
        id: externalUserId,
        username: "operator",
        name: "Modal Operator",
      };
      const beforeEvidence = ((await db.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id)))[0]!.setup as InternalSetupState).slackCallbackSurfaces;
      const invalidAuth = signed({ type: "block_actions", team: { id: "T-PAPERCLIP" }, user: wireUser, actions: [] });
      invalidAuth.headers.set("x-slack-signature", `v0=${"0".repeat(64)}`);
      expect((await routedService.handleWebhook(endpoint.publicId, "slack", invalidAuth)).status).toBe(401);
      expect(onAction).not.toHaveBeenCalled();
      expect(((await db.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id)))[0]!.setup as InternalSetupState).slackCallbackSurfaces).toEqual(beforeEvidence);
      const commandBody = new URLSearchParams({ command: endpoint.setup.command!, text: "", user_id: externalUserId,
        user_name: "operator", channel_id: channelId, team_id: "T-PAPERCLIP", trigger_id: "synthetic-command-trigger" }).toString();
      const commandTimestamp = String(Math.floor(Date.now() / 1_000));
      const commandRequest = new Request(callbackUrl, { method: "POST", headers: {
        "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": commandTimestamp,
        "x-slack-signature": `v0=${createHmac("sha256", credentials.signingSecret!).update(`v0:${commandTimestamp}:${commandBody}`).digest("hex")}`,
      }, body: commandBody });
      const commandResponse = await forward(commandRequest, "command");
      expect(commandResponse.status).toBe(200);
      expect(onCommand).toHaveBeenCalledOnce();
      expect(await db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id),
        eq(chatActions.kind, "provider_effect"), sql`${chatActions.providerActionId} like 'provider_effect:slash_notice:%'`)))
        .toEqual([expect.objectContaining({ companyId: fixture.companyId, endpointId: endpoint.id,
          payload: expect.objectContaining({ effect: "ephemeral_message", authorizationMode: "safe_notice", userId: externalUserId }) })]);
      expect(custody.find(value => value.lane === "command")!.acknowledgedWithin3s).toBe(mode !== "command-delayed");
      const actionPayload = {
          type: "block_actions",
          team: { id: "T-PAPERCLIP" },
          user: wireUser,
          channel: { id: channelId },
          container: {
            type: "message",
            channel_id: channelId,
            message_ts: publication.providerMessageId,
            thread_ts: threadTs,
          },
          message: { ts: publication.providerMessageId, thread_ts: threadTs },
          actions: [{ action_id: openAction.actionId, value: interaction.id }],
          trigger_id: "synthetic-signed-modal-trigger",
      };
      const actionRequest = signed(actionPayload);
      triggerCreatedAt = Date.now();
      const opened = await forward(actionRequest, "action");
      expect(opened.status).toBe(200);
      if (mode === "action-delayed") {
        expect(protocol).toEqual([{ method: "views.open", triggerAgeMs: expect.any(Number), outcome: "trigger_expired" }]);
        expect(protocol[0]!.triggerAgeMs).toBeGreaterThanOrEqual(3_000);
        expect(views).toHaveLength(0);
        const attempts = await db.select().from(chatActions).where(and(
          eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "question_form_open_attempt"),
        ));
        expect(attempts).toEqual([expect.objectContaining({ status: "failed", result: expect.objectContaining({ retryable: false }) })]);
        const pending = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id));
        expect(pending).toEqual([expect.objectContaining({ status: "pending" })]);
        expect(await db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.interactionId, interaction.id))).toEqual([]);
        await forward(signed(actionPayload), "duplicate_action");
        expect(protocol).toHaveLength(1);
        expect(onSubmit).not.toHaveBeenCalled();
        expect(unexpectedProviderMethods).toEqual([]);
        expect(providerErrors).toEqual([expect.objectContaining({ code: "slack_webapi_platform_error", data: expect.objectContaining({ error: "trigger_expired" }) })]);
        await Promise.all(providerTransport.mock.results.map(result => result.value));
        expect(custody.find(value => value.lane === "action")!.acknowledgedWithin3s).toBe(false);
        const observed = (await db.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id)))[0]!.setup as InternalSetupState;
        expect(observed.slackCallbackSurfaces?.interactivity?.url).toBe(callbackUrl);
        expect(observed.slackCallbackSurfaces?.slashCommands?.url).toBe(callbackUrl);
        if (process.env.PAPERCLIP_SLACK_PROTOCOL_CAPTURE === "1") console.info(JSON.stringify({ mode, protocol, custody }));
        return;
      }
      expect(protocol[0]).toMatchObject({ method: "views.open", outcome: "opened" });
      expect(protocol[0]!.triggerAgeMs).toBeLessThan(3_000);
      expect(views).toHaveLength(1);
      await forward(signed(actionPayload), "duplicate_action");
      expect(protocol).toHaveLength(1);
      expect(views).toHaveLength(1);
      const view = views[0]!;
      const metadata = JSON.parse(view.private_metadata) as {
        c: string;
        m: string;
      };
      expect(metadata).toEqual({ c: expect.any(String), m: view.callback_id });
      const select = view.blocks.find(
        (block) => block.element?.type === "radio_buttons",
      )!;
      const text = view.blocks.find(
        (block) => block.element?.type === "plain_text_input",
      )!;
      const production = select.element.options!.find(
        (option) => option.text.text === "Production",
      )!;
      expect(production.value).not.toBe("production");
      const submit = (value: string) =>
        signed({
          type: "view_submission",
          team: { id: "T-PAPERCLIP" },
          user: wireUser,
          view: {
            id: "V-SIGNED-MODAL",
            callback_id: view.callback_id,
            private_metadata: view.private_metadata,
            state: {
              values: {
                [select.block_id]: {
                  [select.element.action_id]: {
                    type: "radio_buttons",
                    selected_option: production,
                  },
                },
                [text.block_id]: {
                  [text.element.action_id]: { type: "plain_text_input", value },
                },
              },
            },
          },
        });
      const sdkContextRows = () =>
        db
          .select({ id: chatSdkState.id })
          .from(chatSdkState)
          .where(
            and(
              eq(chatSdkState.companyId, fixture.companyId),
              eq(chatSdkState.endpointId, endpoint.id),
              eq(
                chatSdkState.stateKey,
                `cache:${createHash("sha256").update(`modal-context:slack:${metadata.c}`).digest("hex")}`,
              ),
            ),
          );
      const submissionState = async () => ({
        interactions: await db
          .select()
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, interaction.id)),
        tokens: await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.providerActionId, view.callback_id),
            ),
          ),
        deliveries: await db
          .select()
          .from(issueQuestionResponseDeliveries)
          .where(
            eq(issueQuestionResponseDeliveries.interactionId, interaction.id),
          ),
        audits: await db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, fixture.companyId),
              eq(activityLog.entityId, conversation.issueId),
              eq(activityLog.action, "issue.thread_interaction_answered"),
            ),
          ),
      });
      await expect(sdkContextRows()).resolves.toHaveLength(1);
      const before = await submissionState();
      expect(before.interactions).toEqual([
        expect.objectContaining({ status: "pending" }),
      ]);
      expect(before.tokens).toEqual([
        expect.objectContaining({ status: "issued" }),
      ]);
      expect(before.deliveries).toEqual([]);
      expect(before.audits).toEqual([]);
      const wakeupsBefore = wakeup.mock.calls.length;
      const invalidStartedAt = Date.now();
      const invalid = await forward(submit(""), "invalid_submission");
      expect(custody.find(value => value.lane === "invalid_submission")!.acknowledgedWithin3s).toBe(mode !== "submission-delayed");
      if (mode === "submission-delayed") expect(Date.now() - invalidStartedAt).toBeGreaterThanOrEqual(3_500);
      expect(invalid.status).toBe(200);
      expect(await invalid.json()).toEqual({
        response_action: "errors",
        errors: { [text.block_id]: "Enter a response" },
      });
      expect(onSubmit.mock.calls[0]![0].event).toMatchObject({
        relatedThread: { id: conversation.externalThreadId },
        relatedMessage: { id: publication.providerMessageId },
      });
      await expect(sdkContextRows()).resolves.toEqual([]);
      expect(await submissionState()).toEqual(before);
      expect(wakeup).toHaveBeenCalledTimes(wakeupsBefore);

      const setRole = (membershipRole: "viewer" | "operator") =>
        db
          .update(companyMemberships)
          .set({ membershipRole, updatedAt: new Date() })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, linkedUserId),
            ),
          );
      await setRole("viewer");
      const denied = await forward(submit("Add regional failover"), "current_authority_submission");
      expect(denied.status).toBe(200);
      expect(await denied.json()).toEqual({
        response_action: "errors",
        errors: {
          [select.block_id]:
            "This form is no longer authorized. Close it and open the linked Paperclip task.",
        },
      });
      expect(await submissionState()).toEqual(before);
      expect(wakeup).toHaveBeenCalledTimes(wakeupsBefore);
      const denials = await db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            sql`${chatDeliveries.normalizedEvent}->'modal'->>'code' = 'chat_modal_principal_not_authorized'`,
          ),
        );
      expect(denials).toHaveLength(1);
      expect(denials[0]).toMatchObject({
        state: "filtered",
        conversationId: conversation.id,
      });
      await setRole("operator");
      const corrected = await forward(submit("  Add regional failover  "), "corrected_submission");
      expect(corrected.status).toBe(200);
      expect(await corrected.json()).toEqual({ response_action: "clear" });
      await vi.waitFor(async () => {
        expect(wakeup).toHaveBeenCalledTimes(wakeupsBefore + 1);
        expect((await submissionState()).deliveries).toEqual([
          expect.objectContaining({
            status: "fallback_queued",
            deliveryMode: "wake_fallback",
          }),
        ]);
      });
      expect(wakeup).toHaveBeenLastCalledWith(
        fixture.assignedAgentId,
        expect.objectContaining({
          idempotencyKey: `question-response:${interaction.id}`,
          requestedByActorType: "user",
          requestedByActorId: linkedUserId,
          contextSnapshot: expect.objectContaining({
            issueId: conversation.issueId,
            interactionId: interaction.id,
            source: "issue.interaction.respond",
          }),
        }),
      );
      const accepted = await submissionState();
      expect(accepted.interactions).toEqual([
        expect.objectContaining({
          companyId: fixture.companyId,
          issueId: conversation.issueId,
          status: "answered",
          resolvedByUserId: linkedUserId,
          result: {
            version: 1,
            summaryMarkdown: null,
            answers: [
              { questionId: "environment", optionIds: ["production"] },
              {
                questionId: "reason",
                optionIds: [],
                otherText: "Add regional failover",
              },
            ],
          },
        }),
      ]);
      expect(accepted.tokens).toEqual([
        expect.objectContaining({
          status: "processed",
          conversationId: conversation.id,
          principalId: principal.id,
          result: {
            code: "question_form_answered",
            interactionId: interaction.id,
          },
        }),
      ]);
      expect(accepted.deliveries).toHaveLength(1);
      expect(accepted.audits).toEqual([
        expect.objectContaining({
          actorId: linkedUserId,
          details: expect.objectContaining({
            source: "external_chat_modal",
            endpointId: endpoint.id,
            conversationId: conversation.id,
            publicationId: publication.id,
          }),
        }),
      ]);
      const duplicate = await forward(submit("  Add regional failover  "), "duplicate_submission");
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toEqual({ response_action: "clear" });
      expect(await submissionState()).toEqual(accepted);
      expect(wakeup).toHaveBeenCalledTimes(wakeupsBefore + 1);
      expect(onSubmit).toHaveBeenCalledTimes(4);
      for (const [event] of onSubmit.mock.calls.slice(1)) {
        expect(event).toMatchObject({
          endpointId: endpoint.id,
          provider: "slack",
          event: {
            callbackId: view.callback_id,
            privateMetadata: view.callback_id,
            user: { userId: externalUserId },
          },
        });
        expect(event.event.relatedThread).toBeUndefined();
        expect(event.event.relatedMessage).toBeUndefined();
      }
      await expect(service.listConversations(endpoint.id)).resolves.toEqual([
        expect.objectContaining({
          id: conversation.id,
          issueId: conversation.issueId,
          externalThreadId: channel.thread.id,
        }),
      ]);
      expect(
        providerMethods.filter((method) => method === "views.open"),
      ).toHaveLength(1);
      expect(unexpectedProviderMethods).toEqual([]);
      await Promise.all(providerTransport.mock.results.map(result => result.value));
      expect(providerErrors).toEqual([]);
      const observed = (await db.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id)))[0]!.setup as InternalSetupState;
      expect(observed.slackCallbackSurfaces?.interactivity?.url).toBe(callbackUrl);
      expect(observed.slackCallbackSurfaces?.slashCommands?.url).toBe(callbackUrl);
      if (process.env.PAPERCLIP_SLACK_PROTOCOL_CAPTURE === "1") console.info(JSON.stringify({ mode, protocol, custody, invalidSubmission: "errors", correctedSubmission: "clear", answerDeliveries: accepted.deliveries.length }));
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      const errors: unknown[] = [];
      for (const cleanup of [
        () => routedService?.shutdown(),
        () => actualRuntime?.shutdown(),
        () => configured ? retirePublicationFixture(configured.service, configured.endpoint.id) : undefined,
        () => network.assertQuiet(),
        () => network.restore(),
      ]) {
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError([...(failure ? [failure.error] : []), ...errors], "Slack protocol work or cleanup failed");
    }
  });
});
