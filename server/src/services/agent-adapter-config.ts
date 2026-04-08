import { generateKeyPairSync } from "node:crypto";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { ensureOpenCodeModelConfiguredAndAvailable } from "@paperclipai/adapter-opencode-local/server";
import { unprocessable } from "../errors.js";

export type AdapterConfigSecretsService = {
  normalizeAdapterConfigForPersistence(
    companyId: string,
    adapterConfig: Record<string, unknown>,
    options: { strictMode: boolean },
  ): Promise<Record<string, unknown>>;
  resolveAdapterConfigForRuntime(
    companyId: string,
    adapterConfig: Record<string, unknown>,
  ): Promise<{ config: Record<string, unknown> }>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return null;
}

function generateEd25519PrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function ensureGatewayDeviceKey(
  adapterType: string | null | undefined,
  adapterConfig: Record<string, unknown>,
): Record<string, unknown> {
  if (adapterType !== "openclaw_gateway") return adapterConfig;
  const disableDeviceAuth = parseBooleanLike(adapterConfig.disableDeviceAuth) === true;
  if (disableDeviceAuth) return adapterConfig;
  if (asNonEmptyString(adapterConfig.devicePrivateKeyPem)) return adapterConfig;
  return { ...adapterConfig, devicePrivateKeyPem: generateEd25519PrivateKeyPem() };
}

export function applyCreateDefaultsByAdapterType(
  adapterType: string | null | undefined,
  adapterConfig: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...adapterConfig };
  if (adapterType === "codex_local") {
    if (!asNonEmptyString(next.model)) {
      next.model = DEFAULT_CODEX_LOCAL_MODEL;
    }
    const hasBypassFlag =
      typeof next.dangerouslyBypassApprovalsAndSandbox === "boolean"
      || typeof next.dangerouslyBypassSandbox === "boolean";
    if (!hasBypassFlag) {
      next.dangerouslyBypassApprovalsAndSandbox = DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
    }
    return ensureGatewayDeviceKey(adapterType, next);
  }
  if (adapterType === "gemini_local" && !asNonEmptyString(next.model)) {
    next.model = DEFAULT_GEMINI_LOCAL_MODEL;
    return ensureGatewayDeviceKey(adapterType, next);
  }
  if (adapterType === "cursor" && !asNonEmptyString(next.model)) {
    next.model = DEFAULT_CURSOR_LOCAL_MODEL;
  }
  return ensureGatewayDeviceKey(adapterType, next);
}

export async function assertAdapterConfigConstraints(
  companyId: string,
  adapterType: string | null | undefined,
  adapterConfig: Record<string, unknown>,
  secretsSvc: AdapterConfigSecretsService,
) {
  if (adapterType !== "opencode_local") return;
  const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(companyId, adapterConfig);
  const runtimeEnv = asRecord(runtimeConfig.env) ?? {};
  const configuredModel = asNonEmptyString(runtimeConfig.model);
  if (!configuredModel || !configuredModel.includes("/")) {
    throw unprocessable("OpenCode requires an explicit model in provider/model format.");
  }
  try {
    await ensureOpenCodeModelConfiguredAndAvailable({
      model: configuredModel,
      command: runtimeConfig.command,
      cwd: runtimeConfig.cwd,
      env: runtimeEnv,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw unprocessable(`Invalid opencode_local adapterConfig: ${reason}`);
  }
}

export async function prepareAdapterConfigForPersistence(input: {
  companyId: string;
  adapterType: string | null | undefined;
  adapterConfig: Record<string, unknown>;
  strictMode: boolean;
  secretsSvc: AdapterConfigSecretsService;
}): Promise<Record<string, unknown>> {
  const withDefaults = applyCreateDefaultsByAdapterType(input.adapterType, input.adapterConfig);
  const normalized = await input.secretsSvc.normalizeAdapterConfigForPersistence(
    input.companyId,
    withDefaults,
    { strictMode: input.strictMode },
  );
  await assertAdapterConfigConstraints(
    input.companyId,
    input.adapterType,
    normalized,
    input.secretsSvc,
  );
  return normalized;
}
