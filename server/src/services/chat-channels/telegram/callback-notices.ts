import type { EndpointRow, DbTransaction, DbOrTransaction } from "../runtime-types.js";

import {
  createHash,
} from "node:crypto";
import {
  and,
  eq,
} from "drizzle-orm";

import {
  chatEndpointResources,
  chatExternalPrincipals,
  chatIdentityLinks,
} from "@paperclipai/db";

import {
  type TelegramCallbackReceipt,
} from "../../chat-telegram-ephemeral.js";

type TelegramCallbackNoticeAuthorityOptions = {
  nonDirectDestinationAllowed: (endpoint: EndpointRow, resource: typeof chatEndpointResources.$inferSelect | null | undefined) => boolean;
  lockCurrentPrincipalAuthorization: (tx: DbOrTransaction, endpoint: EndpointRow, principalId: string) => Promise<{ allowed: boolean; linkedDenied: boolean; userId: string | null; sponsorUserId?: string | null }>;
};

export function createTelegramCallbackNoticeAuthority(options: TelegramCallbackNoticeAuthorityOptions) {
  const { nonDirectDestinationAllowed, lockCurrentPrincipalAuthorization } = options;


  // This is permission to return one fixed, neutral callback denial, not
  // permission to execute the denied action or publish to the conversation.
  // Retain the initial identity-policy snapshot so queued notices cannot cross
  // a subsequent actor/link/reach change. No provider I/O occurs under locks.
  async function lockTelegramCallbackNoticeAuthority(
    tx: DbTransaction,
    endpoint: EndpointRow,
    receipt: TelegramCallbackReceipt,
    principalId: string | null,
  ): Promise<string | null> {
    if (
      endpoint.provider !== "telegram" ||
      endpoint.status !== "active" ||
      endpoint.companyId !== receipt.companyId ||
      endpoint.id !== receipt.endpointId ||
      endpoint.botExternalId !== receipt.botUserId ||
      !endpoint.providerAccountId ||
      !principalId ||
      Date.now() < receipt.receivedAtMs ||
      Date.now() >= receipt.deadlineAtMs
    )
      return null;
    const resource =
      receipt.chatType === "private"
        ? null
        : await tx
            .select()
            .from(chatEndpointResources)
            .where(
              and(
                eq(chatEndpointResources.companyId, endpoint.companyId),
                eq(chatEndpointResources.endpointId, endpoint.id),
                eq(chatEndpointResources.providerResourceId, receipt.chatId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
    if (
      receipt.chatType === "private"
        ? !endpoint.allowDirectMessages
        : !resource || !nonDirectDestinationAllowed(endpoint, resource)
    )
      return null;
    const principal = await tx
      .select()
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, endpoint.companyId),
          eq(chatExternalPrincipals.provider, endpoint.provider),
          eq(
            chatExternalPrincipals.providerAccountId,
            endpoint.providerAccountId,
          ),
          eq(chatExternalPrincipals.id, principalId),
          eq(chatExternalPrincipals.externalId, receipt.receiverUserId),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!principal || principal.kind !== "user" || principal.isBot) return null;
    const authorization = await lockCurrentPrincipalAuthorization(
      tx,
      endpoint,
      principal.id,
    );
    const link = await tx
      .select({
        status: chatIdentityLinks.status,
        userId: chatIdentityLinks.paperclipUserId,
      })
      .from(chatIdentityLinks)
      .where(
        and(
          eq(chatIdentityLinks.companyId, endpoint.companyId),
          eq(chatIdentityLinks.endpointId, endpoint.id),
          eq(chatIdentityLinks.principalId, principal.id),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return createHash("sha256")
      .update(
        JSON.stringify([
          endpoint.companyId,
          endpoint.id,
          receipt.botUserId,
          resource?.id ?? null,
          principal.id,
          principal.externalId,
          link,
          authorization,
          endpoint.allowUnlinkedPeople,
          endpoint.sponsorUserId,
        ]),
      )
      .digest("hex");
  }
  return { lockTelegramCallbackNoticeAuthority };
}
