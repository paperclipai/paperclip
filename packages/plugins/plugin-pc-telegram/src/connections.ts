import type { PluginContext, PluginEntityRecord } from "@paperclipai/plugin-sdk";
import {
  ACCOUNT_ENTITY_TYPE,
  DEFAULT_INCOMING_MODE,
} from "./constants.js";
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

function asPeerIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = typeof item === "string" ? item.trim() : "";
    if (!/^[1-9]\d{0,15}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
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
    allowedPeerIds: asPeerIds(data.allowedPeerIds),
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
  const allowedPeerIds = input.allowedPeerIds ?? existing?.allowedPeerIds ?? [];
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
  const ids: string[] = [];
  const seen = new Set<string>();
  const limit = 100;
  let offset = 0;
  for (;;) {
    const page = await ctx.companies.list({ limit, offset });
    let added = 0;
    for (const company of page) {
      if (!company.id || seen.has(company.id)) continue;
      seen.add(company.id);
      ids.push(company.id);
      added += 1;
    }
    if (page.length < limit || added === 0) break;
    offset += page.length;
  }
  return ids;
}
