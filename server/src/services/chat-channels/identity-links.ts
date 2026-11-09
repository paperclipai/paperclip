import { githubIdentityFields } from "./github/identity-links.js";
import { createSlackIdentityLinks, type SlackIdentityEffectStager } from "./slack/identity-links.js";
import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, gt, inArray, ne, sql } from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import { authUsers, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, companies, companyMemberships } from "@paperclipai/db";

import { conflict, forbidden, notFound, unprocessable } from "../../errors.js";

type EndpointRow = typeof chatEndpoints.$inferSelect;
type ConfirmationRuntime = { credentialFingerprint: string; generation: number };

type ChatIdentityLinkOptions = {
  endpointRecord: (endpointId: string) => Promise<{ endpoint: EndpointRow } | null>;
  getPublicBaseUrl: () => string | null;
  confirmationRuntimeFor: (endpoint: EndpointRow) => Promise<ConfirmationRuntime | undefined>;
  stageProviderEffect: SlackIdentityEffectStager;
  scheduleProviderEffect: (actionId: string) => void;
};

export function createChatIdentityLinks(db: Db, options: ChatIdentityLinkOptions) {
  const { endpointRecord, getPublicBaseUrl, confirmationRuntimeFor, stageProviderEffect, scheduleProviderEffect } = options;
  const slackIdentityLinks = createSlackIdentityLinks(db, { previewIdentityLink, stageProviderEffect });

  async function listPrincipals(endpointId: string) {
    const record = await endpointRecord(endpointId);
    if (!record) throw notFound("Chat endpoint not found");
    const principals = await db
      .select()
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, record.endpoint.companyId),
          eq(chatExternalPrincipals.provider, record.endpoint.provider),
          eq(
            chatExternalPrincipals.providerAccountId,
            record.endpoint.providerAccountId ?? "unknown",
          ),
        ),
      )
      .orderBy(asc(chatExternalPrincipals.displayName));
    const links = await db
      .select()
      .from(chatIdentityLinks)
      .where(eq(chatIdentityLinks.endpointId, endpointId));
    const connects = record.endpoint.provider === "slack" ? await slackIdentityLinks.listConnects(record.endpoint) : [];
    const connectByPrincipal = new Map(connects.map((row) => [row.principalId, new Date(row.lastConnectAt).toISOString()]));
    const userIds = links.flatMap((link) =>
      link.paperclipUserId ? [link.paperclipUserId] : [],
    );
    const users = userIds.length
      ? await db
          .select({
            id: authUsers.id,
            name: authUsers.name,
            email: authUsers.email,
            image: authUsers.image,
          })
          .from(authUsers)
          .where(inArray(authUsers.id, userIds))
      : [];
    const linkByPrincipal = new Map(
      links.map((link) => [link.principalId, link]),
    );
    const userById = new Map(users.map((user) => [user.id, user]));
    return principals.map((principal) => {
      const link = linkByPrincipal.get(principal.id);
      const user = link?.paperclipUserId
        ? userById.get(link.paperclipUserId)
        : null;
      return {
        id: link?.id ?? principal.id,
        principalId: principal.id,
        ...(record.endpoint.provider === "github" ? githubIdentityFields(principal) : {}),
        externalLabel:
          principal.displayName ?? principal.handle ?? principal.externalId,
        externalDetail: principal.handle
          ? `@${principal.handle.replace(/^@/, "")}`
          : principal.externalId,
        paperclipUserId: link?.paperclipUserId ?? null,
        paperclipUserLabel: user?.name ?? user?.email ?? null,
        paperclipUserImage: user?.image ?? null,
        status: link?.status ?? "pending",
        lastConnectAt: connectByPrincipal.get(principal.id) ?? null,
      };
    });
  }

  async function createLinkIntent(
    endpointId: string,
    principalId: string,
    expiresInSeconds: number,
  ) {
    const record = await endpointRecord(endpointId);
    if (!record) throw notFound("Chat endpoint not found");
    const principal = await db
      .select()
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, record.endpoint.companyId),
          eq(chatExternalPrincipals.id, principalId),
          eq(chatExternalPrincipals.provider, record.endpoint.provider),
          eq(
            chatExternalPrincipals.providerAccountId,
            record.endpoint.providerAccountId ?? "",
          ),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!principal) throw notFound("External identity not found");
    if (principal.isBot || principal.kind !== "user") {
      throw unprocessable("Only a human external identity can be linked");
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${record.endpoint.companyId}:${principalId}`}, 0))`,
      );
      const existingLink = await tx
        .select({ status: chatIdentityLinks.status })
        .from(chatIdentityLinks)
        .where(
          and(
            eq(chatIdentityLinks.endpointId, endpointId),
            eq(chatIdentityLinks.principalId, principalId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (existingLink?.status === "linked") {
        throw conflict("This external identity is already linked", {
          code: "chat_identity_already_linked",
        });
      }
      await tx
        .insert(chatIdentityLinks)
        .values({
          companyId: record.endpoint.companyId,
          endpointId,
          principalId,
          status: "pending",
          confirmationTokenHash: tokenHash,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: [chatIdentityLinks.endpointId, chatIdentityLinks.principalId],
          set: {
            paperclipUserId: null,
            status: "pending",
            confirmationTokenHash: tokenHash,
            expiresAt,
            confirmedAt: null,
            revokedAt: null,
            updatedAt: new Date(),
          },
        });
    });
    const path = `/chat-identity/confirm?token=${encodeURIComponent(token)}`;
    return {
      confirmationUrl: getPublicBaseUrl() ? `${getPublicBaseUrl()}${path}` : path,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async function previewIdentityLink(token: string, userId?: string | null) {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const row = await db
      .select({
        link: chatIdentityLinks,
        principal: chatExternalPrincipals,
        endpoint: chatEndpoints,
        companyName: companies.name,
        companyPrefix: companies.issuePrefix,
      })
      .from(chatIdentityLinks)
      .innerJoin(
        chatExternalPrincipals,
        and(
          eq(chatExternalPrincipals.companyId, chatIdentityLinks.companyId),
          eq(chatExternalPrincipals.id, chatIdentityLinks.principalId),
        ),
      )
      .innerJoin(
        chatEndpoints,
        and(
          eq(chatEndpoints.companyId, chatIdentityLinks.companyId),
          eq(chatEndpoints.id, chatIdentityLinks.endpointId),
        ),
      )
      .innerJoin(companies, eq(companies.id, chatIdentityLinks.companyId))
      .where(
        and(
          eq(chatIdentityLinks.confirmationTokenHash, tokenHash),
          eq(chatIdentityLinks.status, "pending"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!row || !row.link.expiresAt || row.link.expiresAt <= new Date()) {
      throw unprocessable("This identity-link request is invalid or expired");
    }
    if (!["active", "verifying"].includes(row.endpoint.status)) throw unprocessable("This connection is not available");
    const selfService = await slackIdentityLinks.isSelfService(row.link, tokenHash);
    const membership = userId ? await db.select({ status: companyMemberships.status }).from(companyMemberships).where(and(
      eq(companyMemberships.companyId, row.link.companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId),
    )).then((rows) => rows[0]) : null;
    return {
      selfService,
      canConfirm: membership?.status === "active",
      endpointId: row.endpoint.id,
      companyId: row.endpoint.companyId,
      companyName: row.companyName,
      companyPrefix: row.companyPrefix,
      provider: row.endpoint.provider,
      providerAccountLabel: row.endpoint.providerAccountLabel,
      botLabel: row.endpoint.botDisplayName,
      externalLabel:
        row.principal.displayName ??
        row.principal.handle ??
        row.principal.externalId,
      externalDetail: row.principal.handle
        ? `@${row.principal.handle.replace(/^@/, "")}`
        : row.principal.externalId,
      expiresAt: row.link.expiresAt.toISOString(),
    };
  }

  async function confirmIdentityLink(token: string, paperclipUserId: string) {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const link = await db
      .select()
      .from(chatIdentityLinks)
      .where(
        and(
          eq(chatIdentityLinks.confirmationTokenHash, tokenHash),
          eq(chatIdentityLinks.status, "pending"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!link || !link.expiresAt || link.expiresAt <= new Date())
      throw unprocessable("This identity-link request is invalid or expired");
    const endpointRecordForLink = await endpointRecord(link.endpointId);
    if (!endpointRecordForLink || !["active", "verifying"].includes(endpointRecordForLink.endpoint.status)) throw unprocessable("This connection is not available");
    const connectReceipt = endpointRecordForLink.endpoint.provider === "slack" ? await slackIdentityLinks.latestConnect(link) : null;
    const confirmationRuntime = connectReceipt ? await confirmationRuntimeFor(endpointRecordForLink.endpoint) : null;
    let confirmationEffectId: string | null = null;
    const confirmed = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${link.companyId}:${link.principalId}`}, 0))`,
      );
      const currentLink = await tx
        .select({
          id: chatIdentityLinks.id,
          companyId: chatIdentityLinks.companyId,
          endpointId: chatIdentityLinks.endpointId,
          principalId: chatIdentityLinks.principalId,
          expiresAt: chatIdentityLinks.expiresAt,
        })
        .from(chatIdentityLinks)
        .where(
          and(
            eq(chatIdentityLinks.id, link.id),
            eq(chatIdentityLinks.status, "pending"),
            eq(chatIdentityLinks.confirmationTokenHash, tokenHash),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      const now = new Date();
      if (
        !currentLink ||
        !currentLink.expiresAt ||
        currentLink.expiresAt <= now
      ) {
        return null;
      }
      const membership = await tx
        .select({ status: companyMemberships.status })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, currentLink.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, paperclipUserId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (membership?.status !== "active") {
        throw forbidden(
          "The signed-in Paperclip account is not a member of this company",
        );
      }
      const conflictingLink = await tx
        .select({
          id: chatIdentityLinks.id,
          paperclipUserId: chatIdentityLinks.paperclipUserId,
        })
        .from(chatIdentityLinks)
        .where(
          and(
            eq(chatIdentityLinks.companyId, link.companyId),
            eq(chatIdentityLinks.principalId, link.principalId),
            eq(chatIdentityLinks.status, "linked"),
            ne(chatIdentityLinks.paperclipUserId, paperclipUserId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (conflictingLink) {
        throw conflict(
          "This provider identity is linked to a different Paperclip account",
          {
            code: "chat_identity_link_conflict",
          },
        );
      }
      const confirmedLink = await tx
        .update(chatIdentityLinks)
        .set({
          paperclipUserId,
          status: "linked",
          confirmationTokenHash: null,
          confirmedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(chatIdentityLinks.id, link.id),
            eq(chatIdentityLinks.status, "pending"),
            eq(chatIdentityLinks.confirmationTokenHash, tokenHash),
            gt(chatIdentityLinks.expiresAt, now),
          ),
        )
        .returning({ endpointId: chatIdentityLinks.endpointId })
        .then((rows) => rows[0] ?? null);
      if (confirmedLink && connectReceipt && confirmationRuntime &&
          typeof connectReceipt.payload.channelId === "string" && typeof connectReceipt.payload.userId === "string") {
        confirmationEffectId = await slackIdentityLinks.stageConfirmation(tx, {
          endpoint: endpointRecordForLink.endpoint, link, tokenHash,
          channelId: connectReceipt.payload.channelId, userId: connectReceipt.payload.userId,
          confirmationRuntime,
        });
      }
      return confirmedLink;
    });
    if (!confirmed) {
      throw conflict("This identity-link request was already used or expired", {
        code: "chat_identity_link_consumed",
      });
    }
    if (confirmationEffectId) scheduleProviderEffect(confirmationEffectId);
    return { ok: true, endpointId: confirmed.endpointId };
  }

  async function revokeLink(endpointId: string, principalId: string) {
    const link = await db
      .select({ companyId: chatIdentityLinks.companyId })
      .from(chatIdentityLinks)
      .where(
        and(
          eq(chatIdentityLinks.endpointId, endpointId),
          eq(chatIdentityLinks.principalId, principalId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!link) throw notFound("Identity link not found");
    const revoked = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${link.companyId}:${principalId}`}, 0))`,
      );
      return tx
        .update(chatIdentityLinks)
        .set({
          paperclipUserId: null,
          status: "revoked",
          confirmationTokenHash: null,
          revokedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatIdentityLinks.companyId, link.companyId),
            eq(chatIdentityLinks.endpointId, endpointId),
            eq(chatIdentityLinks.principalId, principalId),
          ),
        )
        .returning({ id: chatIdentityLinks.id })
        .then((rows) => rows[0] ?? null);
    });
    if (!revoked) throw notFound("Identity link not found");
  }

  return { listPrincipals, createLinkIntent, previewIdentityLink, requestIdentityAccess: slackIdentityLinks.requestIdentityAccess, confirmIdentityLink, revokeLink };
}
