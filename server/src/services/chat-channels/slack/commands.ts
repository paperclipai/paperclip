import { createProviderEffects, type ProviderEffectTarget } from "../provider-effects.js";

import { createSlackTaskStart } from "./task-start.js";

import type { EndpointRow, DbTransaction, RuntimeContext, LifecycleRuntimeFence } from "../runtime-types.js";

import { notifyChatActionWork } from "../../chat-work-notifications.js";

import { type ChatRuntime } from "../../chat-runtime.js";
import type { ChatEndpointRuntime } from "../../voice/voice-runtime.js";

import {
  createHash,
  randomBytes,
} from "node:crypto";
import {
  and,
  eq,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatEndpointResources,
  chatExternalPrincipals,
  chatIdentityLinks,
} from "@paperclipai/db";
import type {
  ChatProvider,
} from "@paperclipai/shared";

import {
  conflict,
} from "../../../errors.js";

import {
  type ChatSdkCallbackEvent,
  type ChatSdkMessageCallbackEvent,
  type ChatSdkRuntime,
} from "../../chat-sdk-runtime.js";

import {
  logActivity,
} from "../../activity-log.js";

import type {
  Author,
  Message,
  SlashCommandEvent,
  Thread,
} from "chat";

import type { EndpointRecord } from "../runtime-types.js";

export function slackCommandForAgent(agentName: string, publicId: string): string {
  const slug = agentName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
  const suffix = publicId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 6);
  return `/${slug || "paperclip"}-${suffix || "agent"}`;
}

type SlackCommandsOptions = {
  runtime: Pick<ChatSdkRuntime | ChatRuntime, "get">;
  runtimeFor: (endpoint: EndpointRow) => Promise<ChatEndpointRuntime>;
  handleSdkMessage: (event: ChatSdkMessageCallbackEvent, context: RuntimeContext, input?: { receiptReactionSupported?: boolean; slackSlashControl?: boolean }) => Promise<void>;
  stageProviderEffect: ReturnType<typeof createProviderEffects>["stageProviderEffect"];
  scheduleProviderEffect: (actionId: string, liveTarget?: ProviderEffectTarget) => void;
  ensurePrincipal: (endpoint: EndpointRow, author: Author, raw?: unknown) => Promise<{ principal: typeof chatExternalPrincipals.$inferSelect; userId: string | null; linkedDenied: boolean }>;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  getPublicBaseUrl: () => string | null;
  canonicalProviderResourceId: (provider: ChatProvider, thread: Pick<Thread, "channelId" | "id">) => string;
  nonDirectDestinationAllowed: (endpoint: EndpointRow, resource: typeof chatEndpointResources.$inferSelect | null | undefined) => boolean;
  sponsorAllowsGuest: (endpoint: EndpointRow) => Promise<boolean>;
  latestSlackDmControlThreadId: (endpointId: string, channelId: string) => Promise<string | null>;
  scheduleMessageProcessing: (task: () => Promise<void>) => void;
  processSlackTaskStart: ReturnType<typeof createSlackTaskStart>["processSlackTaskStart"];
  deferWebhookProcessing?: boolean;
};

export function createSlackCommands(db: Db, options: SlackCommandsOptions) {
  const { runtime, runtimeFor, handleSdkMessage, stageProviderEffect, scheduleProviderEffect, ensurePrincipal, runtimeCallbackEndpoint, getPublicBaseUrl, canonicalProviderResourceId, nonDirectDestinationAllowed, sponsorAllowsGuest, latestSlackDmControlThreadId, scheduleMessageProcessing, processSlackTaskStart } = options;
  async function handleSlackSlashCommand(event: ChatSdkCallbackEvent<SlashCommandEvent>, runtimeContext: RuntimeContext, record: EndpointRecord, command: string, text: string) {
    const providerCommandId =
      event.event.triggerId ??
      createHash("sha256")
        .update(JSON.stringify(event.event.raw))
        .digest("hex");
    const stageSlackNotice = (tx: DbTransaction, notice: string, principalId?: string | null) =>
      stageProviderEffect(tx, {
        endpoint: record.endpoint,
        principalId: principalId ?? null,
        providerActionId: `provider_effect:slash_notice:${createHash("sha256").update(JSON.stringify([
          event.event.command, event.event.user.userId, providerCommandId, event.event.text,
        ])).digest("hex")}`,
        payload: {
          version: 1, effect: "ephemeral_message", authorizationMode: "safe_notice",
          threadId: event.event.channel.id, userId: event.event.user.userId,
          text: notice, settleDelivery: false,
        },
        runtimeContext,
      });
    const queueSlackNotice = async (notice: string, principalId?: string | null) => {
      const effect = await db.transaction((tx) => stageSlackNotice(tx, notice, principalId));
      if (!effect) throw new Error("Slack notice was not persisted");
      scheduleProviderEffect(effect.id, event.event.channel);
    };
    if (!["verifying", "active"].includes(record.endpoint.status)) {
      await queueSlackNotice("This Paperclip connection is not active.");
      return;
    }
    const expectedCommand =
      typeof record.endpoint.setup.command === "string"
        ? record.endpoint.setup.command
        : slackCommandForAgent(
            record.assignedAgentName,
            record.endpoint.publicId,
          );
    if (event.provider !== "slack" || command !== expectedCommand) {
      await queueSlackNotice(
        `This connection only accepts ${expectedCommand}.`,
      );
      return;
    }
    const principal = await ensurePrincipal(
      record.endpoint,
      event.event.user,
      event.event.raw,
    );
    if (text.toLowerCase() === "connect") {
      // Discovery must work before identity and channel access are granted.
      // It records no task and grants no permissions; linking still requires
      // explicit confirmation by a company member in the board.
      if (principal.principal.kind !== "user" || principal.principal.isBot) return;
      const effect = await db.transaction(async (tx) => {
        if (!(await runtimeCallbackEndpoint(tx, event.endpointId, runtimeContext, ["verifying", "active"]))) {
          throw conflict("This Slack connection changed; send the connect command again");
        }
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${record.endpoint.companyId}:${principal.principal.id}`}, 0))`);
        const inserted = await tx.insert(chatActions).values({
          companyId: record.endpoint.companyId, endpointId: event.endpointId,
          principalId: principal.principal.id, kind: "slack_connect",
          providerActionId: `slack_connect:${providerCommandId}`,
          payload: { version: 1, channelId: event.event.channel.id, userId: event.event.user.userId },
          status: "processed", result: { code: "slack_identity_discovered" },
        }).onConflictDoNothing().returning({ id: chatActions.id });
        if (!inserted.length) return null;
        const currentLink = await tx.select().from(chatIdentityLinks).where(and(
          eq(chatIdentityLinks.endpointId, event.endpointId), eq(chatIdentityLinks.principalId, principal.principal.id),
        )).then((rows) => rows[0]);
        let notice = "Your Slack account is already connected to Paperclip. You can return to Slack and message the agent.";
        if (currentLink?.status !== "linked") {
          const token = randomBytes(32).toString("base64url");
          const tokenHash = createHash("sha256").update(token).digest("hex");
          const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
          await tx.insert(chatIdentityLinks).values({
            companyId: record.endpoint.companyId, endpointId: event.endpointId, principalId: principal.principal.id,
            status: "pending", confirmationTokenHash: tokenHash, expiresAt,
          }).onConflictDoUpdate({
            target: [chatIdentityLinks.endpointId, chatIdentityLinks.principalId],
            set: { paperclipUserId: null, status: "pending", confirmationTokenHash: tokenHash, expiresAt, confirmedAt: null, revokedAt: null, updatedAt: new Date() },
          });
          await tx.update(chatActions).set({ payload: {
            version: 1, channelId: event.event.channel.id, userId: event.event.user.userId, identityLinkHash: tokenHash,
          } }).where(eq(chatActions.id, inserted[0].id));
          const url = `${getPublicBaseUrl()}/chat-identity/confirm?token=${encodeURIComponent(token)}`;
          notice = getPublicBaseUrl()
            ? `[Connect your Paperclip account](${url}) — sign in and confirm this Slack identity. This private link expires in 15 minutes and works once. You can also confirm in the setup wizard. No agent work has started.`
            : "Return to the Paperclip setup wizard to confirm your Slack account. No agent work has started.";
        }
        await logActivity(tx as unknown as Db, {
          companyId: record.endpoint.companyId, actorType: "system", actorId: `chat:${principal.principal.id}`,
          action: "chat.slack_identity_discovered", entityType: "chat_endpoint", entityId: event.endpointId,
          details: { principalId: principal.principal.id },
        });
        const staged = await stageSlackNotice(tx, notice, principal.principal.id);
        if (!staged) throw new Error("Slack identity link notice was not persisted");
        return staged;
      });
      if (effect) scheduleProviderEffect(effect.id, event.event.channel);
      return;
    }
    const resource = await db
      .select()
      .from(chatEndpointResources)
      .where(
        and(
          eq(chatEndpointResources.endpointId, event.endpointId),
          eq(
            chatEndpointResources.providerResourceId,
            canonicalProviderResourceId(event.provider, {
              channelId: event.event.channel.id,
              id: event.event.channel.id,
            }),
          ),
        ),
      )
      .then((rows) => rows[0] ?? null);
    // Slack's SDK channel wrapper has reported false for isDM on real slash
    // callbacks even though the signed payload contains a D-prefixed channel
    // id. The provider id is authoritative for this routing decision.
    const rawSlackChannelId = event.event.channel.id.replace(/^slack:/, "");
    const slashIsDirectMessage = /^D[A-Z0-9]+$/i.test(rawSlackChannelId)
      ? true
      : event.event.channel.isDM;
    const destinationAllowed = slashIsDirectMessage
      ? record.endpoint.allowDirectMessages
      : nonDirectDestinationAllowed(record.endpoint, resource);
    const authorized =
      destinationAllowed &&
      !principal.linkedDenied &&
      (principal.userId !== null ||
        (record.endpoint.allowUnlinkedPeople &&
          (await sponsorAllowsGuest(record.endpoint))));
    if (!authorized) {
      await queueSlackNotice(
        "This channel or account is not allowed to start Paperclip work.",
        principal.principal.id,
      );
      return;
    }
    const slackControl = /^(status|new|close)$/i
      .exec(text)?.[1]
      ?.toLowerCase() as "status" | "new" | "close" | undefined;
    if (slackControl) {
      if (!slashIsDirectMessage) {
        // Slack slash-command payloads are channel-scoped and do not carry a
        // thread timestamp, so they cannot safely identify one of several
        // Paperclip tasks in the channel. Native @mention threads remain the
        // task-management surface there; the control vocabulary is exact only
        // in a DM, whose provider channel identity is stable.
        await queueSlackNotice(
          "Use status, new, and close in a direct message with this agent. In a channel, open the Paperclip task from its Slack thread.",
          principal.principal.id,
        );
        return;
      }
      const endpointRuntime =
        runtime.get(event.endpointId) ?? (await runtimeFor(record.endpoint));
      // A slash-command task starts a real Slack root and binds Paperclip to
      // that returned thread id. Later slash controls carry only the DM channel
      // id, so target the most recently active task instead of synthesizing an
      // unrelated base-DM thread that cannot find the binding.
      const activeThreadId = await latestSlackDmControlThreadId(
        event.endpointId,
        rawSlackChannelId,
      );
      const thread = endpointRuntime.thread(
        activeThreadId ?? `slack:${rawSlackChannelId}:`,
      );
      const synthetic = {
        id: createHash("sha256")
          .update(
            `${event.event.command}:${event.event.user.userId}:${providerCommandId}:${slackControl}`,
          )
          .digest("hex"),
        threadId: thread.id,
        text: `/${slackControl}`,
        formatted: { type: "root", children: [] },
        raw: event.event.raw,
        author: event.event.user,
        metadata: { dateSent: new Date(), edited: false },
        attachments: [],
        links: [],
        isMention: true,
      } as unknown as Message;
      await handleSdkMessage(
        {
          endpointId: event.endpointId,
          provider: event.provider,
          thread,
          message: synthetic,
          trigger: "direct_message",
        },
        runtimeContext,
        { receiptReactionSupported: false, slackSlashControl: true },
      );
      return;
    }
    if (!text) {
      await queueSlackNotice(
        `Use ${expectedCommand} followed by a task, or ${expectedCommand} status, new, or close in a direct message.`,
        principal.principal.id,
      );
      return;
    }
    const providerActionId = `slash_task:${createHash("sha256")
      .update(
        `${event.event.command}:${event.event.user.userId}:${providerCommandId}`,
      )
      .digest("hex")}`;
    const syntheticMessageId = createHash("sha256")
      .update(
        `${event.event.command}:${event.event.user.userId}:${providerCommandId}`,
      )
      .digest("hex");
    // A duplicate Slack retry must acknowledge from the already-durable row
    // without waiting for the first worker's endpoint/identity locks or Web
    // API request. Slack otherwise treats a healthy in-flight command as an
    // acknowledgement timeout and retries it again.
    const existingAction = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, record.endpoint.id),
          eq(chatActions.providerActionId, providerActionId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    const insertedAction = existingAction
      ? null
      : await db.transaction(async (tx) => {
          if (
            !(await runtimeCallbackEndpoint(
              tx,
              event.endpointId,
              runtimeContext,
              ["verifying", "active"],
            ))
          )
            return null;
          await notifyChatActionWork(tx, "slash_task_start");
          return tx
            .insert(chatActions)
            .values({
              companyId: record.endpoint.companyId,
              endpointId: record.endpoint.id,
              principalId: principal.principal.id,
              kind: "slash_task_start",
              providerActionId,
              payload: {
                version: 1,
                channelId: event.event.channel.id,
                command,
                syntheticMessageId,
                taskText: text,
              },
              status: "queued",
            })
            .onConflictDoNothing()
            .returning()
            .then((rows) => rows[0] ?? null);
        });
    const action =
      existingAction ??
      insertedAction ??
      (await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, record.endpoint.id),
            eq(chatActions.providerActionId, providerActionId),
          ),
        )
        .then((rows) => rows[0] ?? null));
    if (!action) throw new Error("Slack command admission was not persisted");
    // Slack has a tight acknowledgement budget. The unique action row is the
    // durable receipt; provider publication and Paperclip admission run behind
    // the acknowledgement under an atomic `received -> resolving` claim.
    // Duplicate callbacks schedule the same id and converge without waiting
    // on Slack's Web API or creating a second root.
    scheduleMessageProcessing(async () => {
      await processSlackTaskStart(
        action.id,
        options.deferWebhookProcessing === true,
      );
    });

  }
  return { handleSlackSlashCommand };
}
