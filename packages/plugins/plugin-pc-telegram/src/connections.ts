import type { PluginContext, PluginEntityRecord } from "@paperclipai/plugin-sdk";
import {
  ACCOUNT_ENTITY_TYPE,
  DEFAULT_INCOMING_MODE,
} from "./constants.js";
import { normalizeAllowedPeerIds } from "./inbound.js";
import type { IncomingMode, PublicTelegramAccount, TelegramConnection, TelegramConnectionPatch } from "./types.js";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asIncomingMode(value: unknown): IncomingMode {
  return value === DEFAULT_INCOMING_MODE ? value : DEFAULT_INCOMING_MODE;
}

export function connectionFromEntity(entity: PluginEntityRecord, liveAccountIds: ReadonlySet<string>): TelegramConnection {
  const data = entity.data ?? {};
  const companyId = entity.scopeId ?? asString(data.companyId) ?? "";
  const telegramUserId = asString(data.telegramUserId) ?? entity.externalId ?? "";
  return {
    companyId,
    telegramUserId,
    username: asString(data.username),
    displayName: asString(data.displayName) ?? telegramUserId,
    assignedAgentId: asString(data.assignedAgentId),
    incomingMode: asIncomingMode(data.incomingMode),
    paused: asBoolean(data.paused, false),
    acceptUnlistedSenders: asBoolean(data.acceptUnlistedSenders, false),
    allowedPeerIds: normalizeAllowedPeerIds(data.allowedPeerIds),
    sessionSecretId: asString(data.sessionSecretId) ?? "",
    sessionConfigPath: asString(data.sessionConfigPath) ?? "",
    live: liveAccountIds.has(telegramUserId),
  };
}

export function publicConnection(connection: TelegramConnection): Omit<TelegramConnection, "sessionSecretId" | "sessionConfigPath"> & { hasSession: boolean } {
  return {
    companyId: connection.companyId,
    telegramUserId: connection.telegramUserId,
    username: connection.username,
    displayName: connection.displayName,
    assignedAgentId: connection.assignedAgentId,
    incomingMode: connection.incomingMode,
    paused: connection.paused,
    acceptUnlistedSenders: connection.acceptUnlistedSenders,
    allowedPeerIds: connection.allowedPeerIds,
    live: connection.live,
    hasSession: connection.sessionSecretId.length > 0,
  };
}

export async function listConnections(
  ctx: PluginContext,
  companyId: string,
  liveAccountIds: ReadonlySet<string>,
): Promise<TelegramConnection[]> {
  const records = await ctx.entities.list({
    scopeKind: "company",
    scopeId: companyId,
    entityType: ACCOUNT_ENTITY_TYPE,
    limit: 200,
  });
  return records.map((record) => connectionFromEntity(record, liveAccountIds));
}

export async function findConnection(
  ctx: PluginContext,
  companyId: string,
  telegramUserId: string,
  liveAccountIds: ReadonlySet<string>,
): Promise<TelegramConnection | null> {
  const records = await ctx.entities.list({
    scopeKind: "company",
    scopeId: companyId,
    entityType: ACCOUNT_ENTITY_TYPE,
    externalId: telegramUserId,
    limit: 1,
  });
  const record = records[0];
  return record ? connectionFromEntity(record, liveAccountIds) : null;
}

export async function upsertConnection(
  ctx: PluginContext,
  input: {
    companyId: string;
    account: PublicTelegramAccount;
    sessionSecretId: string;
    sessionConfigPath?: string;
    assignedAgentId?: string | null;
    incomingMode?: IncomingMode;
    paused?: boolean;
    acceptUnlistedSenders?: boolean;
    allowedPeerIds?: string[];
  },
): Promise<TelegramConnection> {
  const existing = await findConnection(ctx, input.companyId, input.account.telegramUserId, new Set());
  const incomingMode = input.incomingMode ?? existing?.incomingMode ?? DEFAULT_INCOMING_MODE;
  const assignedAgentId = input.assignedAgentId === undefined
    ? existing?.assignedAgentId ?? null
    : input.assignedAgentId;
  const paused = input.paused ?? existing?.paused ?? false;
  const acceptUnlistedSenders = input.acceptUnlistedSenders ?? existing?.acceptUnlistedSenders ?? false;
  const allowedPeerIds = normalizeAllowedPeerIds(input.allowedPeerIds ?? existing?.allowedPeerIds ?? []);
  await ctx.entities.upsert({
    entityType: ACCOUNT_ENTITY_TYPE,
    scopeKind: "company",
    scopeId: input.companyId,
    externalId: input.account.telegramUserId,
    title: input.account.displayName,
    status: paused ? "paused" : "connected",
    data: {
      companyId: input.companyId,
      telegramUserId: input.account.telegramUserId,
      username: input.account.username,
      displayName: input.account.displayName,
      assignedAgentId,
      incomingMode,
      paused,
      acceptUnlistedSenders,
      allowedPeerIds,
      sessionSecretId: input.sessionSecretId,
      sessionConfigPath: input.sessionConfigPath ?? existing?.sessionConfigPath ?? "",
    },
  });
  return {
    companyId: input.companyId,
    telegramUserId: input.account.telegramUserId,
    username: input.account.username,
    displayName: input.account.displayName,
    assignedAgentId,
    incomingMode,
    paused,
    acceptUnlistedSenders,
    allowedPeerIds,
    sessionSecretId: input.sessionSecretId,
    sessionConfigPath: input.sessionConfigPath ?? existing?.sessionConfigPath ?? "",
    live: false,
  };
}

export async function patchConnection(
  ctx: PluginContext,
  companyId: string,
  telegramUserId: string,
  patch: TelegramConnectionPatch,
  liveAccountIds: ReadonlySet<string>,
): Promise<TelegramConnection> {
  const existing = await findConnection(ctx, companyId, telegramUserId, liveAccountIds);
  if (!existing) throw new Error("Telegram account is not connected.");
  return upsertConnection(ctx, {
    companyId,
    account: {
      telegramUserId: existing.telegramUserId,
      username: existing.username,
      displayName: existing.displayName,
    },
    sessionSecretId: existing.sessionSecretId,
    sessionConfigPath: existing.sessionConfigPath,
    assignedAgentId: patch.assignedAgentId === undefined ? existing.assignedAgentId : patch.assignedAgentId,
    incomingMode: patch.incomingMode ?? existing.incomingMode,
    paused: patch.paused ?? existing.paused,
    acceptUnlistedSenders: patch.acceptUnlistedSenders ?? existing.acceptUnlistedSenders,
    allowedPeerIds: patch.allowedPeerIds ?? existing.allowedPeerIds,
  }).then((connection) => ({ ...connection, live: liveAccountIds.has(telegramUserId) }));
}

export async function listKnownCompanyIds(ctx: PluginContext): Promise<string[]> {
  const ids = new Set<string>();
  const limit = 100;
  let offset = 0;
  for (;;) {
    const records = await ctx.entities.list({
      entityType: ACCOUNT_ENTITY_TYPE,
      scopeKind: "company",
      limit,
      offset,
    });
    for (const record of records) {
      if (record.scopeId) ids.add(record.scopeId);
    }
    if (records.length < limit) break;
    offset += records.length;
  }
  return [...ids];
}
