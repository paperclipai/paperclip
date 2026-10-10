import { notifyChatActionWork } from "./chat-work-notifications.js";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  chatActions,
  chatDeliveries,
  chatEndpoints,
  chatMessageLinks,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import {
  parseGitHubReceiptIdentity,
  type GitHubReceiptIdentity,
} from "./chat-github-receipt-reactions.js";

export type ReceiptReactionPayload = {
  version: 1;
  operation: "add" | "remove";
  threadId: string;
  messageId: string;
  reaction: "eyes";
  runtimeGeneration: number;
  credentialFingerprint: string;
  githubReceipt?: GitHubReceiptIdentity;
};

export function receiptReactionPayload(
  payload: Record<string, unknown>,
): ReceiptReactionPayload | null {
  const operation = payload.operation ?? "add";
  if (
    payload.version !== 1 ||
    (operation !== "add" && operation !== "remove") ||
    typeof payload.threadId !== "string" ||
    !payload.threadId ||
    typeof payload.messageId !== "string" ||
    !payload.messageId ||
    payload.reaction !== "eyes" ||
    typeof payload.runtimeGeneration !== "number" ||
    !Number.isSafeInteger(payload.runtimeGeneration) ||
    typeof payload.credentialFingerprint !== "string" ||
    (payload.githubReceipt !== undefined &&
      !parseGitHubReceiptIdentity(payload.githubReceipt))
  ) {
    return null;
  }
  return { ...payload, operation } as ReceiptReactionPayload;
}

/** Stage exact-source cleanup after a confirmed reply or terminal run. The existing
 * reaction worker performs provider I/O and rechecks current credentials. */
export async function stageReceiptReactionRemovals(
  tx: Db,
  input: {
    endpoint: typeof chatEndpoints.$inferSelect;
    binding: {
      companyId: string;
      endpointId: string;
      conversationId: string;
      issueId: string;
    };
    runId: string;
    runtimeContext: { generation: number; credentialFingerprint: string };
  },
): Promise<string[]> {
  const runId = input.runId;
  if (
    !Number.isSafeInteger(input.runtimeContext?.generation) ||
    typeof input.runtimeContext?.credentialFingerprint !== "string"
  )
    return [];
  const receipts = await tx
    .select({
      actionId: chatActions.id,
      deliveryId: chatMessageLinks.deliveryId,
      payload: chatActions.payload,
      result: chatActions.result,
      status: chatActions.status,
      normalizedEvent: chatDeliveries.normalizedEvent,
    })
    .from(heartbeatRuns)
    .innerJoin(
      chatMessageLinks,
      and(
        eq(chatMessageLinks.companyId, heartbeatRuns.companyId),
        eq(chatMessageLinks.endpointId, input.binding.endpointId),
        eq(chatMessageLinks.conversationId, input.binding.conversationId),
        eq(chatMessageLinks.direction, "inbound"),
        or(
          sql`${chatMessageLinks.commentId}::text = ${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId'`,
          sql`${chatMessageLinks.commentId}::text = ${heartbeatRuns.contextSnapshot} ->> 'commentId'`,
          sql`coalesce(${heartbeatRuns.contextSnapshot} -> 'wakeCommentIds', '[]'::jsonb) ? ${chatMessageLinks.commentId}::text`,
        ),
      ),
    )
    .leftJoin(
      chatDeliveries,
      and(
        eq(chatDeliveries.id, chatMessageLinks.deliveryId),
        eq(chatDeliveries.companyId, chatMessageLinks.companyId),
        eq(chatDeliveries.endpointId, chatMessageLinks.endpointId),
        eq(chatDeliveries.conversationId, chatMessageLinks.conversationId),
        ["slack", "telegram", "github"].includes(input.endpoint.provider)
          ? eq(chatDeliveries.state, "processed")
          : undefined,
      ),
    )
    .leftJoin(
      chatActions,
      and(
        eq(chatActions.endpointId, chatMessageLinks.endpointId),
        eq(chatActions.deliveryId, chatMessageLinks.deliveryId),
        eq(chatActions.kind, "receipt_reaction"),
        sql`${chatActions.providerActionId} = 'receipt_reaction:' || ${chatMessageLinks.deliveryId}::text`,
      ),
    )
    .where(
      and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.companyId, input.binding.companyId),
        eq(
          sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
          input.binding.issueId,
        ),
      ),
    );
  const removals = receipts.flatMap((receipt) => {
    if (!receipt.deliveryId) return [];
    let payload = receipt.payload
      ? receiptReactionPayload(receipt.payload)
      : null;
    if (
      input.endpoint.provider === "github" &&
      payload &&
      (payload.runtimeGeneration !== input.runtimeContext.generation ||
        payload.credentialFingerprint !==
          input.runtimeContext.credentialFingerprint)
    )
      return [];
    if (["slack", "telegram", "github"].includes(input.endpoint.provider)) {
      // Eyes acknowledge this admitted message, not each model/retry run.
      // A fast reply can win before addReceiptReaction inserts its row.
      // Persist the one-shot marker from the original admitted source now;
      // the late add will observe it under the same credential fence.
      const normalized = receipt.normalizedEvent;
      if (!normalized) return [];
      if (input.endpoint.provider === "github") {
        const originalFence = normalized.runtimeContext as
          Record<string, unknown> | undefined;
        if (
          originalFence?.generation !== input.runtimeContext.generation ||
          originalFence.credentialFingerprint !==
            input.runtimeContext.credentialFingerprint
        )
          return [];
      }
      const acknowledgement = normalized.acknowledgement as
        Record<string, unknown> | undefined;
      const message = normalized.message as Record<string, unknown> | undefined;
      const conversation = normalized.conversation as
        Record<string, unknown> | undefined;
      const source = receiptReactionPayload({
        version: 1,
        operation: "add",
        reaction: "eyes",
        threadId: conversation?.externalThreadId,
        messageId: message?.providerMessageId,
        runtimeGeneration: input.runtimeContext.generation,
        credentialFingerprint: input.runtimeContext.credentialFingerprint,
      });
      if (
        acknowledgement?.receiptReactionSupported !== true ||
        !source ||
        (payload &&
          (payload.threadId !== source.threadId ||
            payload.messageId !== source.messageId))
      )
        return [];
      payload = source;
    }
    if (!payload || payload.operation !== "add") return [];
    return [
      {
        companyId: input.binding.companyId,
        endpointId: input.binding.endpointId,
        conversationId: input.binding.conversationId,
        deliveryId: receipt.deliveryId,
        kind: "receipt_reaction",
        providerActionId: `receipt_reaction_remove:${receipt.deliveryId}`,
        payload: {
          ...payload,
          ...(input.endpoint.provider === "github" &&
          parseGitHubReceiptIdentity(receipt.result?.githubReceipt)
            ? {
                githubReceipt: parseGitHubReceiptIdentity(
                  receipt.result?.githubReceipt,
                )!,
              }
            : {}),
          operation: "remove" as const,
          runtimeGeneration: input.runtimeContext.generation,
          credentialFingerprint: input.runtimeContext.credentialFingerprint,
        } satisfies ReceiptReactionPayload,
        status: "received",
      },
    ];
  });
  if (removals.length === 0) return [];
  await notifyChatActionWork(tx, "receipt_reaction");
  const removalDeliveryIds = new Set(
    removals.map((removal) => removal.deliveryId),
  );
  for (const receipt of receipts) {
    if (
      !receipt.deliveryId ||
      !removalDeliveryIds.has(receipt.deliveryId) ||
      !receipt.actionId ||
      !receipt.status ||
      !["received", "failed", "processing"].includes(receipt.status)
    ) {
      continue;
    }
    await tx
      .update(chatActions)
      .set({
        status: "cancelled",
        result: {
          ...(typeof receipt.result?.attempts === "number"
            ? { attempts: receipt.result.attempts }
            : {}),
          code: "receipt_reaction_superseded_by_terminal_publication",
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatActions.id, receipt.actionId),
          eq(chatActions.status, receipt.status),
        ),
      );
  }
  await tx.insert(chatActions).values(removals).onConflictDoNothing();
  return tx
    .select({ id: chatActions.id })
    .from(chatActions)
    .where(
      and(
        eq(chatActions.endpointId, input.binding.endpointId),
        inArray(
          chatActions.providerActionId,
          removals.map((removal) => removal.providerActionId),
        ),
      ),
    )
    .then((rows) => rows.map((row) => row.id));
}
