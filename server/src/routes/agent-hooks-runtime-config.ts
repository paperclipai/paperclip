import { agentHooksConfigSchema } from "@paperclipai/shared";
import { forbidden, unprocessable } from "../errors.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeRuntimeConfigHooks(value: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...value };

  if (!Object.prototype.hasOwnProperty.call(normalized, "hooks")) {
    return normalized;
  }

  const parsedHooks = agentHooksConfigSchema.safeParse(normalized.hooks);
  if (!parsedHooks.success) {
    const issue = parsedHooks.error.issues[0];
    throw unprocessable(issue?.message ?? "Invalid runtimeConfig.hooks configuration");
  }

  normalized.hooks = parsedHooks.data;
  return normalized;
}

function normalizedHooksForComparison(runtimeConfig: unknown): unknown {
  const record = asRecord(runtimeConfig);
  if (!record || !Object.prototype.hasOwnProperty.call(record, "hooks")) {
    return null;
  }

  const parsedHooks = agentHooksConfigSchema.safeParse(record.hooks);
  return parsedHooks.success ? parsedHooks.data : record.hooks;
}

export function runtimeConfigHooksDiffer(leftRuntimeConfig: unknown, rightRuntimeConfig: unknown): boolean {
  return JSON.stringify(normalizedHooksForComparison(leftRuntimeConfig)) !== JSON.stringify(normalizedHooksForComparison(rightRuntimeConfig));
}

export function normalizeRuntimeConfigForCreate(input: {
  runtimeConfig: unknown;
  allowHooksConfig: boolean;
}): Record<string, unknown> {
  const runtimeConfig = asRecord(input.runtimeConfig) ?? {};
  if (!input.allowHooksConfig && Object.prototype.hasOwnProperty.call(runtimeConfig, "hooks")) {
    throw forbidden("Only board can configure agent hooks");
  }
  return normalizeRuntimeConfigHooks(runtimeConfig);
}

export function normalizeRuntimeConfigForPatch(input: {
  runtimeConfig: unknown;
  existingRuntimeConfig: unknown;
  allowHooksConfig: boolean;
}): Record<string, unknown> {
  const runtimeConfig = asRecord(input.runtimeConfig);
  if (!runtimeConfig) {
    throw unprocessable("runtimeConfig must be an object");
  }

  if (!input.allowHooksConfig && Object.prototype.hasOwnProperty.call(runtimeConfig, "hooks")) {
    throw forbidden("Only board can modify agent hook configuration");
  }

  const normalized = normalizeRuntimeConfigHooks(runtimeConfig);
  const existingRuntimeConfig = asRecord(input.existingRuntimeConfig) ?? {};

  if (
    !input.allowHooksConfig &&
    Object.prototype.hasOwnProperty.call(existingRuntimeConfig, "hooks") &&
    !Object.prototype.hasOwnProperty.call(normalized, "hooks")
  ) {
    normalized.hooks = existingRuntimeConfig.hooks;
  }

  return normalized;
}
