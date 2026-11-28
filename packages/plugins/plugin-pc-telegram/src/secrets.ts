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

export async function putAccountSession(
  ctx: PluginContext,
  companyId: string,
  session: string,
): Promise<{ secretId: string; configPath: string }> {
  if (!session) throw new Error("Refusing to persist an empty Telegram session.");
  return ctx.secrets.store({ companyId, value: session });
}

export async function getAccountSession(
  ctx: PluginContext,
  companyId: string,
  secretId: string,
  configPath: string,
): Promise<string | null> {
  if (!secretId || !configPath) return null;
  try {
    const session = await ctx.secrets.resolve(
      { type: "secret_ref", secretId, version: "latest" },
      { companyId, configPath },
    );
    return typeof session === "string" && session.length > 0 ? session : null;
  } catch {
    return null;
  }
}

export async function deleteAccountSession(
  ctx: PluginContext,
  companyId: string,
  secretId: string,
): Promise<void> {
  if (secretId) {
    await ctx.secrets.discard({ companyId, secretId }).catch(() => undefined);
  }
  await ctx.state.delete({
    scopeKind: "company",
    scopeId: companyId,
    namespace: SESSION_SECRET_NAMESPACE,
    stateKey: secretId,
  }).catch(() => undefined);
}
