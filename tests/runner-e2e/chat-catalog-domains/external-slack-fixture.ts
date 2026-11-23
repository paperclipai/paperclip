import type {
  ChatCatalogContext,
  ChatSlackIngressReceipt,
} from "../chat-catalog-contract.js";
import type {
  ChatConversation,
  ChatEndpoint,
  ChatEndpointResource,
} from "../../../packages/shared/src/types/chat-channels.js";
import {
  selectedExternalBinding,
  selectedExternalCredential,
} from "./external-fixtures.js";
import {
  slackProvider,
  assertSlackFixture,
  slackCompanionFields,
} from "./external-slack-provider.js";
import { startSlackRelay } from "./external-slack-relay.js";
import { pollUntil } from "../api.js";
import {
  privateBrowserEntry,
  type PrivateBrowserReceipt,
} from "./external-private-browser.js";
import { privateSlackHumanConnect } from "./external-slack-human.js";
import type { SlackHumanConnectReceipt } from "./external-slack-human-contract.js";
import { root } from "./external-support.js";
export { slackCompanionFields };
interface Principal {
  principalId: string;
  externalLabel: string;
  externalDetail: string;
  paperclipUserId: string | null;
  status: string;
  lastConnectAt?: string | null;
}
export interface SlackMessage {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  files?: Array<{
    id: string;
    permalink?: string;
    url_private_download?: string;
    size?: number;
  }>;
}
/** Preserve the selected app's actual scopes/events; only point its existing
 * callback surfaces at this attempt's signed product webhook. */
export function slackCallbackManifest(
  original: Record<string, unknown>,
  webhook: string,
) {
  const url = new URL(webhook);
  if (
    url.protocol !== "https:" ||
    !/^\/api\/chat-webhooks\/[a-zA-Z0-9_-]+\/slack$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(
      "Disposable Slack callback is not the actual supported HTTPS product route",
    );
  const manifest = structuredClone(original) as Record<string, any>;
  manifest.settings ??= {};
  manifest.settings.event_subscriptions ??= {};
  if (
    !Array.isArray(manifest.settings.event_subscriptions.bot_events) ||
    !manifest.settings.event_subscriptions.bot_events.some((event: string) =>
      ["message.channels", "message.groups"].includes(event),
    )
  )
    throw new Error(
      "Setup blocker: allowlisted Slack app must already have authorized message event subscriptions; fixture will not silently widen scopes",
    );
  manifest.settings.event_subscriptions.request_url = webhook;
  manifest.settings.interactivity = {
    ...manifest.settings.interactivity,
    is_enabled: true,
    request_url: webhook,
  };
  for (const command of manifest.features?.slash_commands ?? [])
    command.url = webhook;
  return manifest;
}
export async function prepareSlackFixture(
  ctx: ChatCatalogContext,
  options: {
    unlinkBeforeCanonical?: boolean;
    observeWithRepairCredential?: boolean;
    useExistingAppCommand?: boolean;
    normalWizard?: { endpointId: string; agentId: string };
  } = {},
) {
  const binding = selectedExternalBinding(ctx);
  assertSlackFixture(binding);
  const p = binding.prerequisites;
  if (!ctx.input.privateSecrets)
    throw new Error("Slack fixture requires private credential redaction");
  const port = Number(p.webhookRelayPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error(
      "Setup blocker: dedicated webhookRelayPort for the isolated HTTPS tunnel is required",
    );
  const priorExperiments = await ctx.input.api.get<{
    enableChatConnectors?: boolean;
  }>("/api/instance/settings/experimental");
  const provider = slackProvider(
    ctx,
    options.observeWithRepairCredential
      ? {
          ...binding,
          prerequisites: { ...p, botTokenEnv: p.repairBotTokenEnv! },
        }
      : binding,
  );
  let endpoint: ChatEndpoint | undefined,
    relay: Awaited<ReturnType<typeof startSlackRelay>> | undefined,
    originalManifest: Record<string, unknown> | undefined,
    manifestChanged = false;
  const createdThreads: string[] = [],
    createdFiles: string[] = [];
  let credentialUiReceipt: PrivateBrowserReceipt | undefined,
    identityUiReceipt: PrivateBrowserReceipt | undefined,
    humanCommandReceipt: SlackHumanConnectReceipt | undefined;
  async function cleanup() {
    try {
      if (endpoint)
        await ctx.input.api.post(`/api/chat-endpoints/${endpoint.id}/setup`, {
          action: "remove",
        });
    } finally {
      try {
        if (manifestChanged && originalManifest)
          await provider.call("configuration", "apps.manifest.update", {
            app_id: p.appId,
            manifest: originalManifest,
          });
      } finally {
        try {
          await provider.cleanupOwned();
        } finally {
          try {
            await relay?.close();
          } finally {
            await ctx.input.api.patch("/api/instance/settings/experimental", {
              enableChatConnectors:
                priorExperiments.enableChatConnectors === true,
            });
          }
        }
      }
    }
  }
  try {
    await ctx.input.api.patch("/api/instance/settings/experimental", {
      enableChatConnectors: true,
    });
    if (options.normalWizard) {
      endpoint = await ctx.input.api.get<ChatEndpoint>(
        `/api/chat-endpoints/${options.normalWizard.endpointId}`,
      );
      if (
        endpoint.companyId !== ctx.input.fixtures.company.id ||
        endpoint.provider !== "slack" ||
        endpoint.assignedAgentId !== options.normalWizard.agentId ||
        endpoint.setup.slackSetupMethod !== "existing" ||
        endpoint.providerAccountId
      )
        throw new Error(
          "Normal Slack setup must use the exact human-created fresh existing-app draft",
        );
    } else
      endpoint = await ctx.input.api.post<ChatEndpoint>(
        `${root(ctx)}/chat-endpoints`,
        {
          provider: "slack",
          assignedAgentId: ctx.input.fixtures.agent.id,
          name: "Disposable catalog Slack",
          slackSetupMethod: "manual",
        },
      );
    const webhook = endpoint.setup.webhookUrl;
    if (
      !webhook ||
      new URL(webhook).origin !== new URL(p.registeredWebhookOrigin!).origin
    )
      throw new Error(
        "Setup blocker: actual server PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL must match designated registeredWebhookOrigin before any Slack operation",
      );
    if (options.useExistingAppCommand) {
      const current = await provider.call<{
        ok: true;
        manifest: {
          features?: { slash_commands?: Array<{ command: string }> };
        };
      }>("configuration", "apps.manifest.export", { app_id: p.appId });
      const commands = current.manifest.features?.slash_commands ?? [];
      if (
        commands.length !== 1 ||
        !/^\/[a-z0-9_-]{1,31}$/.test(commands[0]!.command) ||
        !endpoint.setup.slackApp
      )
        throw new Error(
          "Setup blocker: selected installed Slack app must expose one supported saved command",
        );
      endpoint = await ctx.input.api.patch<ChatEndpoint>(
        `/api/chat-endpoints/${endpoint.id}`,
        {
          slackSetupMethod: "existing",
          slackApp: {
            ...endpoint.setup.slackApp,
            command: commands[0]!.command,
          },
        },
      );
    }
    relay = await startSlackRelay({
      port,
      endpointPublicId: endpoint.publicId,
      baseURL: ctx.input.api.baseURL,
      signingSecret: selectedExternalCredential(
        ctx,
        binding,
        "signingSecretEnv",
      ),
      workspaceId: p.workspaceId!,
      senderUserId: p.senderUserId!,
      channelId: p.channelId!,
    });
    const sender = await provider.call<{
        ok: true;
        team_id: string;
        user_id: string;
        bot_id?: string;
      }>("sender", "auth.test", {}),
      bot = await provider.call<{
        ok: true;
        team_id: string;
        user_id: string;
        bot_id?: string;
      }>("bot", "auth.test", {});
    if (
      sender.team_id !== p.workspaceId ||
      sender.user_id !== p.senderUserId ||
      sender.bot_id ||
      bot.team_id !== p.workspaceId ||
      bot.user_id !== p.botUserId ||
      !bot.bot_id
    )
      throw new Error(
        "Setup blocker: selected Slack credentials do not identify the designated disposable workspace/human/bot",
      );
    const app = await provider.call<{ ok: true; bot: { app_id: string } }>(
      "bot",
      "bots.info",
      { bot: bot.bot_id },
    );
    if (app.bot?.app_id !== p.appId)
      throw new Error(
        "Setup blocker: actual Slack bot token belongs to a different app than the allowlisted disposable app",
      );
    const human = await provider.call<{
      ok: true;
      user: {
        id: string;
        team_id: string;
        name: string;
        is_bot?: boolean;
        deleted?: boolean;
      };
    }>("bot", "users.info", { user: p.senderUserId });
    if (
      human.user.id !== p.senderUserId ||
      human.user.team_id !== p.workspaceId ||
      human.user.is_bot ||
      human.user.deleted ||
      !human.user.name
    )
      throw new Error(
        "Setup blocker: designated Slack sender is not the selected active human",
      );
    if (options.normalWizard) {
      credentialUiReceipt = await privateBrowserEntry({
        mode: "slack-endpoint-configure",
        companyId: ctx.input.fixtures.company.id,
        slackSetup: {
          endpointId: endpoint.id,
          agentId: options.normalWizard.agentId,
          workspaceId: p.workspaceId!,
          signingSecret: selectedExternalCredential(
            ctx,
            binding,
            "signingSecretEnv",
          ),
        },
        baseURL: ctx.input.api.baseURL,
        providerURL: ctx.input.api.baseURL,
        setupURL: `${ctx.input.api.baseURL}/${ctx.input.fixtures.company.issuePrefix}/apps/chat/connect?provider=slack&purpose=chat&resume=${endpoint.id}&stage=credentials`,
        credential: selectedExternalCredential(ctx, binding, "botTokenEnv"),
        cookies: await ctx.input.page.context().cookies(ctx.input.api.baseURL),
      });
      if (credentialUiReceipt.credentialUiRejected) {
        await ctx.input.evidence(
          "chat-catalog-Slack-credential-UI-rejected.json",
          credentialUiReceipt,
        );
        throw new Error(
          "Product Slack credential form rejected the actual selected bot-token format; connectivity remains incomplete",
        );
      }
      endpoint = await ctx.input.api.get<ChatEndpoint>(
        `/api/chat-endpoints/${endpoint.id}`,
      );
    } else
      endpoint = await ctx.input.api.postSensitive<ChatEndpoint>(
        `/api/chat-endpoints/${endpoint.id}/setup`,
        {
          action: "configure",
          credentials: {
            botToken: selectedExternalCredential(ctx, binding, "botTokenEnv"),
            signingSecret: selectedExternalCredential(
              ctx,
              binding,
              "signingSecretEnv",
            ),
          },
        },
      );
    const exported = await provider.call<{
      ok: true;
      manifest: Record<string, unknown>;
    }>("configuration", "apps.manifest.export", { app_id: p.appId });
    originalManifest = exported.manifest;
    if (!originalManifest || typeof originalManifest !== "object")
      throw new Error(
        "Setup blocker: disposable Slack app manifest could not be independently read",
      );
    const manifest = slackCallbackManifest(originalManifest, webhook);
    manifestChanged = true;
    await provider.call("configuration", "apps.manifest.update", {
      app_id: p.appId,
      manifest,
    });
    endpoint = await pollUntil({
      label: "actual Slack signed callback verification",
      deadlineAt: Date.now() + 60000,
      load: () =>
        ctx.input.api.get<ChatEndpoint>(`/api/chat-endpoints/${endpoint!.id}`),
      accept: (row) => !!row.setup.webhookVerifiedAt,
    });
    if (options.normalWizard) {
      const page = await ctx.input.page.context().newPage();
      try {
        await page.goto(
          `${ctx.input.api.baseURL}/${ctx.input.fixtures.company.issuePrefix}/apps/chat/connect?provider=slack&purpose=chat&resume=${endpoint.id}`,
          { waitUntil: "domcontentloaded" },
        );
        await page
          .getByRole("heading", {
            name: "Verify Slack connection",
            exact: true,
          })
          .waitFor();
        const verification = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
              `/api/chat-endpoints/${endpoint!.id}/setup` &&
            response.request().method() === "POST" &&
            response.ok(),
        );
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        const response = await verification;
        if (response.request().postDataJSON()?.action !== "verify")
          throw new Error("Slack verification UI submitted another action");
        endpoint = (await response.json()) as ChatEndpoint;
      } finally {
        await page.close();
      }
    } else
      endpoint = await ctx.input.api.post<ChatEndpoint>(
        `/api/chat-endpoints/${endpoint.id}/setup`,
        { action: "verify" },
      );
    await ctx.input.api.patch(`/api/chat-endpoints/${endpoint.id}`, {
      requireAtMention: false,
      allowGroupChats: true,
      allowUnlinkedPeople: false,
    });
    const resources = await ctx.input.api.get<ChatEndpointResource[]>(
      `/api/chat-endpoints/${endpoint.id}/resources`,
    );
    if (
      !resources.some(
        (row) =>
          row.providerResourceId === p.channelId &&
          row.availability === "available",
      )
    )
      throw new Error(
        "Setup blocker: app bot is not an actual member of the allowlisted disposable Slack channel",
      );
    await ctx.input.api.putSensitive(
      `/api/chat-endpoints/${endpoint.id}/resources`,
      {
        resources: resources.map((row) => ({
          id: row.id,
          enabled: row.providerResourceId === p.channelId,
        })),
      },
    );
    async function postRoot(text: string) {
      const result = await provider.call<{
        ok: true;
        channel: string;
        ts: string;
        message: { user: string; text: string };
      }>("sender", "chat.postMessage", {
        channel: p.channelId,
        text,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (
        result.channel !== p.channelId ||
        result.message?.user !== p.senderUserId ||
        !/^\d+\.\d{6}$/.test(result.ts)
      )
        throw new Error(
          "Actual Slack root did not bind the designated human/channel",
        );
      createdThreads.push(result.ts);
      return result.ts;
    }
    const threadId = await postRoot(
      `Disposable launch discussion ${ctx.input.nonce}`,
    );
    const principals = await pollUntil({
      label: "actual unlinked Slack sender discovery",
      deadlineAt: Date.now() + 60000,
      load: () =>
        ctx.input.api.get<Principal[]>(
          `/api/chat-endpoints/${endpoint!.id}/principals`,
        ),
      accept: (rows) =>
        rows.some((row) => row.externalDetail === `@${human.user.name}`),
    });
    const principal = principals.filter(
      (row) => row.externalDetail === `@${human.user.name}`,
    );
    if (principal.length !== 1 || principal[0]!.status === "linked")
      throw new Error(
        "Setup blocker: the genuine Slack human must have one unlinked discovered identity in the new endpoint",
      );
    if (options.normalWizard) {
      const command = endpoint.setup.command;
      if (
        typeof command !== "string" ||
        !/^\/[a-zA-Z0-9_-]{1,100}$/.test(command) ||
        !(
          originalManifest.features as
            { slash_commands?: Array<{ command: string }> } | undefined
        )?.slash_commands?.some((row) => row.command === command)
      )
        throw new Error(
          "Setup blocker: actual saved app command does not match the selected installed Slack app",
        );
      const selectedChannel = await provider.call<{
        ok: true;
        channel: { id: string; name: string };
      }>("bot", "conversations.info", { channel: p.channelId });
      if (
        selectedChannel.channel.id !== p.channelId ||
        !/^[a-z0-9_-]{1,80}$/.test(selectedChannel.channel.name)
      )
        throw new Error(
          "Setup blocker: selected Slack channel identity is unavailable for independent human UI verification",
        );
      const startedAt = Date.now();
      relay.expectHumanConnect(command);
      humanCommandReceipt = await privateSlackHumanConnect(
        {
          workspaceId: p.workspaceId!,
          channelId: p.channelId!,
          channelName: selectedChannel.channel.name,
          senderUserId: p.senderUserId!,
          command,
          sessionJson: selectedExternalCredential(
            ctx,
            binding,
            "slackBrowserSessionEnv",
          ),
        },
        ctx.input.privateSecrets,
      );
      await pollUntil({
        label: "genuine Slack-signed human connect command callback",
        deadlineAt: Date.now() + 60000,
        load: async () => relay!.receipt(),
        accept: (row) => row.humanConnectCaptured,
      });
      await pollUntil({
        label: "actual processed current Slack connect discovery",
        deadlineAt: Date.now() + 60000,
        load: () =>
          ctx.input.api.get<Principal[]>(
            `/api/chat-endpoints/${endpoint!.id}/principals`,
          ),
        accept: (rows) =>
          rows.some(
            (row) =>
              row.principalId === principal[0]!.principalId &&
              !!row.lastConnectAt &&
              Date.parse(row.lastConnectAt) >= startedAt - 1000,
          ),
      });
      const session = await ctx.input.api.get<{ user: { id: string } }>(
        "/api/auth/get-session",
      );
      identityUiReceipt = await privateBrowserEntry({
        mode: "slack-wizard-confirm",
        companyId: ctx.input.fixtures.company.id,
        slackIdentity: {
          endpointId: endpoint.id,
          principalId: principal[0]!.principalId,
          userId: session.user.id,
          externalDetail: principal[0]!.externalDetail,
          externalLabel: principal[0]!.externalLabel,
        },
        baseURL: ctx.input.api.baseURL,
        providerURL: ctx.input.api.baseURL,
        setupURL: `${ctx.input.api.baseURL}/${ctx.input.fixtures.company.issuePrefix}/apps/chat/connect?provider=slack&purpose=chat&resume=${endpoint.id}`,
        credential: "finite-slack-normal-wizard-confirmation",
        cookies: await ctx.input.page.context().cookies(ctx.input.api.baseURL),
      });
    } else {
      const intent = await ctx.input.api.postSensitive<{
          confirmationUrl: string;
        }>(
          `/api/chat-endpoints/${endpoint.id}/principals/${principal[0]!.principalId}/link-intent`,
          { expiresInSeconds: 600 },
        ),
        url = new URL(intent.confirmationUrl, ctx.input.api.baseURL),
        token = url.searchParams.get("token");
      if (url.pathname !== "/chat-identity/confirm" || !token)
        throw new Error(
          "Actual Slack identity link returned an unsupported confirmation surface",
        );
      ctx.input.privateSecrets.push(token);
      // Fixture setup uses the same supported signed-in confirmation route as the
      // human UI, through the noninstrumented sensitive transport. The bearer link
      // never enters a Test browser URL/trace; this is labelled operator API setup.
      await ctx.input.api.postSensitive("/api/chat-identity-links/confirm", {
        token,
      });
    }
    const linked = (
      await ctx.input.api.get<Principal[]>(
        `/api/chat-endpoints/${endpoint.id}/principals`,
      )
    ).filter(
      (row) =>
        row.principalId === principal[0]!.principalId &&
        row.status === "linked",
    );
    if (linked.length !== 1 || !linked[0]!.paperclipUserId)
      throw new Error(
        "Actual signed-in person did not complete the selected Slack identity link",
      );
    endpoint = options.normalWizard
      ? await ctx.input.api.get<ChatEndpoint>(
          `/api/chat-endpoints/${endpoint.id}`,
        )
      : await ctx.input.api.post<ChatEndpoint>(
          `/api/chat-endpoints/${endpoint.id}/finish`,
          {},
        );
    if (endpoint.status !== "active")
      throw new Error(
        "Setup blocker: supported Slack finish did not activate the actual endpoint",
      );
    let linkedPaperclipUserId: string | null = linked[0]!.paperclipUserId;
    const principalId = principal[0]!.principalId;
    if (options.unlinkBeforeCanonical) {
      await ctx.input.api.delete(
        `/api/chat-endpoints/${endpoint.id}/principals/${principalId}/link`,
      );
      const current = (
        await ctx.input.api.get<Principal[]>(
          `/api/chat-endpoints/${endpoint.id}/principals`,
        )
      ).filter((row) => row.principalId === principalId);
      if (current.length !== 1 || current[0]!.status === "linked")
        throw new Error(
          "Public unlink did not revoke the exact qualified sender",
        );
      linkedPaperclipUserId = null;
    }
    return {
      binding,
      provider,
      relay,
      endpoint,
      threadId,
      createdThreads,
      createdFiles,
      principalId,
      credentialUiReceipt,
      identityUiReceipt,
      humanCommandReceipt,
      senderIdentity: {
        userId: human.user.id,
        workspaceId: human.user.team_id,
        handle: human.user.name,
      },
      get linkedPaperclipUserId() {
        return linkedPaperclipUserId;
      },
      async readPrincipal() {
        const rows = await ctx.input.api.get<Principal[]>(
          `/api/chat-endpoints/${endpoint!.id}/principals`,
        );
        const matches = rows.filter((row) => row.principalId === principalId);
        if (matches.length !== 1)
          throw new Error(
            "Exact Slack principal is no longer uniquely inspectable",
          );
        return matches[0]!;
      },
      async refreshLinkedIdentity() {
        const rows = await ctx.input.api.get<Principal[]>(
            `/api/chat-endpoints/${endpoint!.id}/principals`,
          ),
          current = rows.filter(
            (row) =>
              row.principalId === principalId &&
              row.status === "linked" &&
              !!row.paperclipUserId,
          );
        if (current.length !== 1)
          throw new Error(
            "Actual Slack principal has no current confirmed identity",
          );
        linkedPaperclipUserId = current[0]!.paperclipUserId;
        return linkedPaperclipUserId!;
      },
      async createDistractor(text: string) {
        return postRoot(text);
      },
      async readThread(rootTs: string) {
        if (!createdThreads.includes(rootTs))
          throw new Error("Slack egress read escaped an owned thread");
        const result = await provider.call<{
          ok: true;
          messages: SlackMessage[];
          has_more?: boolean;
        }>("bot", "conversations.replies", {
          channel: p.channelId,
          ts: rootTs,
          limit: 100,
        });
        if (result.has_more || !Array.isArray(result.messages))
          throw new Error("Slack thread exceeds bounded fixture observation");
        return result.messages;
      },
      async resolveIngress(
        query: string,
        messageId: string,
        providerCalls: number,
        rootTs = threadId,
      ): Promise<ChatSlackIngressReceipt> {
        if (!createdThreads.includes(rootTs))
          throw new Error(
            "Slack ingress resolution escaped an owned actual root",
          );
        if (!linkedPaperclipUserId)
          throw new Error(
            "Slack source cannot resolve before actual identity confirmation",
          );
        const conversations = await pollUntil({
            label: "actual Slack canonical source persistence",
            deadlineAt: Date.now() + 60000,
            load: () =>
              ctx.input.api.get<ChatConversation[]>(
                `/api/chat-endpoints/${endpoint!.id}/conversations`,
              ),
            accept: (rows) =>
              rows.some(
                (row) =>
                  row.externalThreadId === `slack:${p.channelId}:${rootTs}`,
              ),
          }),
          conversation = conversations.find(
            (row) => row.externalThreadId === `slack:${p.channelId}:${rootTs}`,
          )!;
        const comments = await ctx.input.api.get<
            Array<{
              id: string;
              body: string;
              authorUserId: string;
              metadata?: { sourceChannel?: string };
            }>
          >(`/api/issues/${conversation.issueId}/comments?order=asc`),
          humanComments = comments.filter(
            (row) =>
              row.body === query &&
              row.authorUserId === linkedPaperclipUserId &&
              row.metadata?.sourceChannel === "slack",
          );
        if (!humanComments.length)
          throw new Error(
            "Canonical Slack input did not persist under the linked human identity",
          );
        return {
          query,
          endpointId: endpoint!.id,
          conversationId: conversation.id,
          issueId: conversation.issueId,
          humanCommentId: humanComments.at(-1)!.id,
          linkedPaperclipUserId: linkedPaperclipUserId!,
          providerCalls,
          provider: {
            workspaceId: p.workspaceId!,
            channelId: p.channelId!,
            senderUserId: p.senderUserId!,
            threadId: rootTs,
            canonicalMessageId: messageId,
          },
        };
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
