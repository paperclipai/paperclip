import type { PluginContext, PluginEntityRecord } from "@paperclipai/plugin-sdk";
import {
  ACCOUNT_ENTITY_TYPE,
  COMPANY_INDEX_STATE_KEY,
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
    sessionSecretId: asString(data.sessionSecretId) ?? "",
    live: liveAccountIds.has(telegramUserId),
  };
}

export function publicConnection(connection: TelegramConnection): Omit<TelegramConnection, "sessionSecretId"> & { hasSession: boolean } {
  return {
    companyId: connection.companyId,
    telegramUserId: connection.telegramUserId,
    username: connection.username,
    displayName: connection.displayName,
    assignedAgentId: connection.assignedAgentId,
    incomingMode: connection.incomingMode,
    paused: connection.paused,
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
    assignedAgentId?: string | null;
    incomingMode?: IncomingMode;
    paused?: boolean;
  },
): Promise<TelegramConnection> {
  const existing = await findConnection(ctx, input.companyId, input.account.telegramUserId, new Set());
  const incomingMode = input.incomingMode ?? existing?.incomingMode ?? DEFAULT_INCOMING_MODE;
  const assignedAgentId = input.assignedAgentId === undefined
    ? existing?.assignedAgentId ?? null
    : input.assignedAgentId;
  const paused = input.paused ?? existing?.paused ?? false;
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
      sessionSecretId: input.sessionSecretId,
    },
  });
  await rememberCompanyId(ctx, input.companyId);
  return {
    companyId: input.companyId,
    telegramUserId: input.account.telegramUserId,
    username: input.account.username,
    displayName: input.account.displayName,
    assignedAgentId,
    incomingMode,
    paused,
    sessionSecretId: input.sessionSecretId,
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
    assignedAgentId: patch.assignedAgentId === undefined ? existing.assignedAgentId : patch.assignedAgentId,
    incomingMode: patch.incomingMode ?? existing.incomingMode,
    paused: patch.paused ?? existing.paused,
  }).then((connection) => ({ ...connection, live: liveAccountIds.has(telegramUserId) }));
}

export async function rememberCompanyId(ctx: PluginContext, companyId: string): Promise<void> {
  const current = await ctx.state.get({
    scopeKind: "instance",
    stateKey: COMPANY_INDEX_STATE_KEY,
  });
  const ids = Array.isArray(current)
    ? current.filter((value): value is string => typeof value === "string")
    : [];
  if (ids.includes(companyId)) return;
  await ctx.state.set({
    scopeKind: "instance",
    stateKey: COMPANY_INDEX_STATE_KEY,
  }, [...ids, companyId]);
}

export async function listKnownCompanyIds(ctx: PluginContext): Promise<string[]> {
  const current = await ctx.state.get({
    scopeKind: "instance",
    stateKey: COMPANY_INDEX_STATE_KEY,
  });
  return Array.isArray(current)
    ? current.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
}
