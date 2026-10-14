import type { EndpointRow, DbTransaction, DbOrTransaction, RuntimeContext, LifecycleRuntimeFence } from "../../chat-channels/runtime-types.js";

import { notifyChatPublicationWork } from "../../chat-work-notifications.js";

import { type ChatRuntime } from "../../chat-runtime.js";
import type { ChatEndpointRuntime } from "../../voice/voice-runtime.js";

import { type CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";

import {
  and,
  eq,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatConversations,
  chatPublications,
  toolConnections,
} from "@paperclipai/db";
import type {
  ToolCredentialSecretRef,
} from "@paperclipai/shared";

import {
  TELEGRAM_DRAFT_ACTION_KIND,
  TELEGRAM_DRAFT_STOPPED_REASON,
  parseTelegramDraftBinding,
  telegramDraftTextSha256,
  telegramGenerationStoppedReceipt,
  telegramPrivateDraftDestination,
  type TelegramDraftControl,
  type TelegramGenerationStoppedProof,
} from "../../chat-telegram-draft-stop.js";

import {
  type ChatSdkCallbackEvent,
  type ChatSdkRuntime,
} from "../../chat-sdk-runtime.js";

import {
  renderPublicationTransportText,
} from "../../chat-publication-text-parts.js";

import type { EndpointRecord } from "../runtime-types.js";

type ConversationRow = typeof chatConversations.$inferSelect;
type TelegramPublicationDraftsOptions = {
  runtimeCallbackRecord: (endpointId: string, context: RuntimeContext, statuses: EndpointRow["status"][]) => Promise<EndpointRecord | null>;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  runtimeFor: (endpoint: EndpointRow) => Promise<ChatEndpointRuntime>;
  runtime: Pick<ChatSdkRuntime | ChatRuntime, "get">;
  runtimeContexts: WeakMap<object, RuntimeContext>;
  credentialFingerprint: (refs: ToolCredentialSecretRef[]) => string;
  authorizeRetainedChatSourcePublication: (tx: DbOrTransaction, publication: typeof chatPublications.$inferSelect) => Promise<boolean>;
};

export function createTelegramPublicationDrafts(db: Db, options: TelegramPublicationDraftsOptions) {
  const { runtimeCallbackRecord, runtimeCallbackEndpoint, runtimeFor, runtime, runtimeContexts, credentialFingerprint, authorizeRetainedChatSourcePublication } = options;


  async function handleTelegramGenerationStopped(
    callback: ChatSdkCallbackEvent<TelegramGenerationStoppedProof>,
    context: RuntimeContext,
  ): Promise<void> {
    const receipt = telegramGenerationStoppedReceipt(callback.event);
    if (callback.provider !== "telegram" || !receipt) return;
    const record = await runtimeCallbackRecord(callback.endpointId, context, [
      "verifying",
      "active",
    ]);
    if (
      record?.endpoint.provider !== "telegram" ||
      record.endpoint.botExternalId !== receipt.botUserId
    )
      return;
    const candidates = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, record.endpoint.companyId),
          eq(chatActions.endpointId, callback.endpointId),
          eq(chatActions.kind, TELEGRAM_DRAFT_ACTION_KIND),
          sql`${chatActions.payload}->>'botUserId' = ${receipt.botUserId}`,
          sql`${chatActions.payload}->>'draftId' = ${String(receipt.draftId)}`,
        ),
      )
      .limit(2);
    if (candidates.length !== 1) return;
    const candidate = candidates[0]!;
    const binding = parseTelegramDraftBinding(candidate.payload);
    if (
      !binding ||
      binding.chatId !== receipt.chatId ||
      binding.messageThreadId !== receipt.messageThreadId ||
      binding.runtimeGeneration !== context.generation ||
      binding.credentialFingerprint !== context.credentialFingerprint
    )
      return;
    await db.transaction(async (tx) => {
      // The sender holds a renewable credential lease during draft HTTP. Do
      // not acquire that lease here: a Stop can arrive inside the first RPC.
      // Both Stop and final-send use the publication→endpoint→draft lock order.
      const publication = await tx
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, record.endpoint.companyId),
            eq(chatPublications.endpointId, callback.endpointId),
            eq(chatPublications.conversationId, binding.conversationId),
            eq(chatPublications.id, binding.publicationId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      const endpoint = await runtimeCallbackEndpoint(
        tx,
        callback.endpointId,
        context,
        ["verifying", "active"],
      );
      if (
        !publication ||
        !endpoint ||
        endpoint.provider !== "telegram" ||
        endpoint.botExternalId !== receipt.botUserId ||
        runtime.get(endpoint.id) !== context.endpointRuntime ||
        publication.attempts !== binding.publicationAttempt ||
        telegramDraftTextSha256(
          renderPublicationTransportText(publication.payload),
        ) !== binding.textSha256
      )
        return;
      const connection = await tx
        .select()
        .from(toolConnections)
        .where(
          and(
            eq(toolConnections.companyId, endpoint.companyId),
            eq(toolConnections.id, endpoint.connectionId),
          ),
        )
        .for("share")
        .then((rows) => rows[0] ?? null);
      if (
        !connection?.enabled ||
        connection.status !== "active" ||
        credentialFingerprint(connection.credentialSecretRefs) !==
          binding.credentialFingerprint
      )
        return;
      const conversation = await tx
        .select()
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.companyId, endpoint.companyId),
            eq(chatConversations.endpointId, endpoint.id),
            eq(chatConversations.id, binding.conversationId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (
        !conversation ||
        !conversation.isDirectMessage ||
        conversation.sessionGeneration !== binding.sessionGeneration ||
        conversation.externalThreadId !==
          `telegram:${binding.chatId}${binding.messageThreadId === null ? "" : `:${binding.messageThreadId}`}`
      )
        return;
      const action = await tx
        .select()
        .from(chatActions)
        .where(eq(chatActions.id, candidate.id))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (
        !action ||
        JSON.stringify(action.payload) !== JSON.stringify(candidate.payload)
      )
        return;
      // final_sending is an irreversible local I/O claim, not a delivery
      // receipt. A late Stop must not claim that an in-flight final was undone.
      if (
        action.result?.phase !== "drafting" ||
        action.status !== "processing" ||
        !["streaming", "delivery_unknown"].includes(publication.state)
      )
        return;
      const stoppedAt = new Date();
      await tx
        .update(chatActions)
        .set({
          status: "cancelled",
          result: {
            phase: "stopped",
            updateId: receipt.updateId,
            stoppedAt: stoppedAt.toISOString(),
          },
          updatedAt: stoppedAt,
        })
        .where(eq(chatActions.id, action.id));
      await notifyChatPublicationWork(tx);
      await tx
        .update(chatPublications)
        .set({
          state: "cancelled",
          nextAttemptAt: null,
          redactedError: TELEGRAM_DRAFT_STOPPED_REASON,
          updatedAt: stoppedAt,
        })
        .where(eq(chatPublications.id, publication.id));
      await tx
        .update(chatActions)
        .set({
          status: "cancelled",
          result: {
            code: "telegram_draft_presentation_stopped",
            attempts: publication.attempts,
          },
          updatedAt: stoppedAt,
        })
        .where(
          and(
            eq(chatActions.companyId, publication.companyId),
            eq(chatActions.endpointId, publication.endpointId),
            eq(
              chatActions.providerActionId,
              `task-control-authorization:${publication.id}`,
            ),
            eq(chatActions.status, "processing"),
            sql`${chatActions.result}->>'attempts' = ${String(publication.attempts)}`,
          ),
        );
    });
  }

  async function reserveTelegramPublicationDraft(input: {
    endpoint: EndpointRow;
    conversation: ConversationRow;
    publication: typeof chatPublications.$inferSelect;
    text: string;
    credentialLease: CredentialMutationLeaseGuard;
    runtimeContext: RuntimeContext;
  }): Promise<{ actionId: string; control: TelegramDraftControl }> {
    const endpointRuntime = await runtimeFor(input.endpoint);
    const registeredContext = runtimeContexts.get(endpointRuntime as object);
    if (
      !registeredContext ||
      registeredContext.generation !== input.runtimeContext.generation ||
      registeredContext.credentialFingerprint !==
        input.runtimeContext.credentialFingerprint ||
      registeredContext.version !== input.runtimeContext.version
    )
      throw new Error("Telegram draft runtime authority changed");
    const draftRuntimeContext = { ...input.runtimeContext, endpointRuntime };
    const destination = telegramPrivateDraftDestination(
      input.conversation.externalThreadId,
    );
    if (
      !destination ||
      !input.conversation.isDirectMessage ||
      !input.endpoint.botExternalId
    )
      throw new Error("Telegram private draft destination is invalid");
    const bindingBase = {
      version: 1 as const,
      publicationId: input.publication.id,
      publicationAttempt: input.publication.attempts + 1,
      conversationId: input.conversation.id,
      sessionGeneration: input.conversation.sessionGeneration,
      runtimeGeneration: input.runtimeContext.generation,
      credentialFingerprint: input.runtimeContext.credentialFingerprint,
      botUserId: input.endpoint.botExternalId,
      ...destination,
      textSha256: telegramDraftTextSha256(input.text),
    };
    const reserved = await db.transaction(async (tx) => {
      await input.credentialLease.assertOwned(tx);
      const publication = await tx
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.id, input.publication.id),
            eq(chatPublications.state, "streaming"),
            eq(chatPublications.attempts, bindingBase.publicationAttempt),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!publication)
        throw new Error("Telegram draft publication ownership changed");
      const providerActionId = `telegram-draft-publication:${publication.id}:${publication.attempts}`;
      const existing = await tx
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, input.endpoint.id),
            eq(chatActions.providerActionId, providerActionId),
          ),
        )
        .limit(1);
      // A second invocation of the same attempt cannot create another draft or
      // replay an uncertain final. A new explicit publication attempt gets a
      // fresh, never-before-used bot-global ID.
      if (existing.length)
        throw new Error("Telegram draft attempt already exists");
      // NO CYCLE and no company/endpoint ownership: rollback, endpoint deletion
      // and bot re-binding cannot recycle a provider-visible draft identity.
      // Exhaustion is a refusal, never a fallback to a process-local/random ID.
      const allocated = await tx.execute(
        sql`select nextval('chat_telegram_draft_ids')::integer as "draftId"`,
      );
      const binding = parseTelegramDraftBinding({
        ...bindingBase,
        draftId: allocated[0]?.draftId,
      });
      if (!binding)
        throw new Error("Telegram draft identity allocation was invalid");
      const [action] = await tx
        .insert(chatActions)
        .values({
          companyId: input.endpoint.companyId,
          endpointId: input.endpoint.id,
          conversationId: input.conversation.id,
          kind: TELEGRAM_DRAFT_ACTION_KIND,
          providerActionId,
          payload: binding,
          status: "issued",
          result: { phase: "reserved" },
        })
        .returning();
      return { action: action!, binding };
    });
    const before = (final: boolean): Promise<boolean> =>
      db.transaction(async (tx) => {
        await input.credentialLease.assertOwned(tx);
        const publication = await tx
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.companyId, input.endpoint.companyId),
              eq(chatPublications.id, input.publication.id),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        const endpoint = await runtimeCallbackEndpoint(
          tx,
          input.endpoint.id,
          draftRuntimeContext,
          ["verifying", "active"],
        );
        if (
          !endpoint ||
          endpoint.provider !== "telegram" ||
          !endpoint.allowDirectMessages ||
          endpoint.botExternalId !== reserved.binding.botUserId ||
          runtime.get(endpoint.id) !== endpointRuntime
        )
          throw new Error("Telegram draft endpoint authority changed");
        const connection = await tx
          .select()
          .from(toolConnections)
          .where(
            and(
              eq(toolConnections.companyId, endpoint.companyId),
              eq(toolConnections.id, endpoint.connectionId),
            ),
          )
          .for("share")
          .then((rows) => rows[0] ?? null);
        if (
          !connection?.enabled ||
          connection.status !== "active" ||
          credentialFingerprint(connection.credentialSecretRefs) !==
            reserved.binding.credentialFingerprint
        )
          throw new Error("Telegram draft credential authority changed");
        const conversation = await tx
          .select()
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.companyId, endpoint.companyId),
              eq(chatConversations.endpointId, endpoint.id),
              eq(chatConversations.id, input.conversation.id),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        const action = await tx
          .select()
          .from(chatActions)
          .where(eq(chatActions.id, reserved.action.id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !action ||
          JSON.stringify(action.payload) !==
            JSON.stringify(reserved.action.payload) ||
          !publication ||
          publication.attempts !== reserved.binding.publicationAttempt
        )
          throw new Error("Telegram draft attempt authority changed");
        if (
          action.status === "cancelled" &&
          action.result?.phase === "stopped" &&
          publication.state === "cancelled"
        )
          return false;
        if (
          publication.state !== "streaming" ||
          !conversation ||
          telegramDraftTextSha256(
            renderPublicationTransportText(publication.payload),
          ) !== reserved.binding.textSha256 ||
          conversation.sessionGeneration !==
            reserved.binding.sessionGeneration ||
          conversation.externalThreadId !==
            input.conversation.externalThreadId ||
          !["active", "waiting", "completed"].includes(conversation.state) ||
          !["reserved", "drafting"].includes(String(action.result?.phase)) ||
          !["issued", "processing"].includes(action.status) ||
          !(await authorizeRetainedChatSourcePublication(tx, publication))
        )
          throw new Error("Telegram draft source authority changed");
        await tx
          .update(chatActions)
          .set({
            status: "processing",
            result: {
              phase: final ? "final_sending" : "drafting",
            },
            updatedAt: new Date(),
          })
          .where(eq(chatActions.id, action.id));
        await input.credentialLease.assertOwned(tx);
        return true;
      });
    return {
      actionId: reserved.action.id,
      control: {
        version: 1,
        draftId: reserved.binding.draftId,
        beforeDraft: () => before(false),
        beforeFinal: () => before(true),
      },
    };
  }
  return { handleTelegramGenerationStopped, reserveTelegramPublicationDraft };
}
