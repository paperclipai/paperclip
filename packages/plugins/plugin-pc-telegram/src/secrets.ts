import { randomUUID } from "node:crypto";
import type { EnvSecretRefBinding, PluginContext } from "@paperclipai/plugin-sdk";
import { SESSION_SECRET_NAMESPACE } from "./constants.js";
import type { TelegramAppCredentials } from "./types.js";

function isSecretRef(value: unknown): value is EnvSecretRefBinding {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { type?: unknown }).type === "secret_ref"
    && typeof (value as { secretId?: unknown }).secretId === "string",
  );
}

function readConfigSecretRef(config: Record<string, unknown>, key: string): EnvSecretRefBinding | string {
  const value = config[key];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (isSecretRef(value)) return value;
  throw new Error(`Plugin config is missing ${key}. Set Telegram api_id and api_hash in plugin settings.`);
}

function parseApiId(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Telegram api_id must resolve to a positive integer.");
  }
  return parsed;
}

export async function resolveTelegramAppCredentials(
  ctx: PluginContext,
  companyId: string,
): Promise<TelegramAppCredentials> {
  const config = await ctx.config.get(companyId);
  const apiIdRef = readConfigSecretRef(config, "apiId");
  const apiHashRef = readConfigSecretRef(config, "apiHash");
  const [apiIdValue, apiHash] = await Promise.all([
    ctx.secrets.resolve(apiIdRef, { companyId, configPath: "apiId" }),
    ctx.secrets.resolve(apiHashRef, { companyId, configPath: "apiHash" }),
  ]);
  if (typeof apiHash !== "string" || apiHash.trim().length === 0) {
    throw new Error("Telegram api_hash is empty.");
  }
  return {
    apiId: parseApiId(apiIdValue.trim()),
    apiHash: apiHash.trim(),
  };
}

export function newSessionSecretId(): string {
  return randomUUID();
}

export async function putAccountSession(
  ctx: PluginContext,
  companyId: string,
  secretId: string,
  session: string,
): Promise<void> {
  if (!session) throw new Error("Refusing to persist an empty Telegram session.");
  await ctx.state.set({
    scopeKind: "company",
    scopeId: companyId,
    namespace: SESSION_SECRET_NAMESPACE,
    stateKey: secretId,
  }, { session });
}

export async function getAccountSession(
  ctx: PluginContext,
  companyId: string,
  secretId: string,
): Promise<string | null> {
  const value = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    namespace: SESSION_SECRET_NAMESPACE,
    stateKey: secretId,
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const session = (value as { session?: unknown }).session;
  return typeof session === "string" && session.length > 0 ? session : null;
}

export async function deleteAccountSession(
  ctx: PluginContext,
  companyId: string,
  secretId: string,
): Promise<void> {
  await ctx.state.delete({
    scopeKind: "company",
    scopeId: companyId,
    namespace: SESSION_SECRET_NAMESPACE,
    stateKey: secretId,
  });
}
