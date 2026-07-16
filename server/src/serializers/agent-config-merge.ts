import { PUBLIC_AGENT_ADAPTER_CONFIG_KEYS } from "./agent-response.js";

type UnknownRecord = Record<string, unknown>;

const PUBLIC_RUNTIME_KEYS = new Set(["heartbeat", "modelProfiles"]);
const PUBLIC_HEARTBEAT_KEYS = new Set([
  "enabled",
  "intervalSec",
  "wakeOnDemand",
  "cooldownSec",
  "maxConcurrentRuns",
  "maxTurnContinuation",
]);
const PUBLIC_PROFILE_KEYS = new Set(["enabled", "label", "adapterConfig"]);
const PUBLIC_MODEL_PROFILE_NAMES = new Set(["default", "cheap"]);

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function preserveHiddenFields(
  existing: UnknownRecord,
  requested: UnknownRecord,
  publicKeys: ReadonlySet<string>,
): UnknownRecord {
  const result = { ...requested };
  for (const [key, value] of Object.entries(existing)) {
    if (!publicKeys.has(key) && !hasOwn(requested, key)) result[key] = value;
  }
  return result;
}

/**
 * Replacement applies only to the public projection surface. Persistence-only
 * credentials and unknown plugin settings remain unless the caller explicitly
 * sends that key through a schema-supported mutation.
 */
export function mergeAgentAdapterConfigForUpdate(
  existingInput: unknown,
  requestedInput: unknown,
  replacePublicConfig: boolean,
): UnknownRecord {
  const existing = asRecord(existingInput);
  const requested = asRecord(requestedInput);
  if (!replacePublicConfig) return { ...existing, ...requested };
  return preserveHiddenFields(existing, requested, PUBLIC_AGENT_ADAPTER_CONFIG_KEYS);
}

function mergeHeartbeat(existingInput: unknown, requestedInput: unknown): UnknownRecord {
  return preserveHiddenFields(
    asRecord(existingInput),
    asRecord(requestedInput),
    PUBLIC_HEARTBEAT_KEYS,
  );
}

function mergeProfile(existingInput: unknown, requestedInput: unknown): UnknownRecord {
  const existing = asRecord(existingInput);
  const requested = asRecord(requestedInput);
  const result = preserveHiddenFields(existing, requested, PUBLIC_PROFILE_KEYS);
  if (hasOwn(requested, "adapterConfig")) {
    result.adapterConfig = mergeAgentAdapterConfigForUpdate(
      existing.adapterConfig,
      requested.adapterConfig,
      true,
    );
  }
  return result;
}

function mergeModelProfiles(existingInput: unknown, requestedInput: unknown): UnknownRecord {
  const existing = asRecord(existingInput);
  const requested = asRecord(requestedInput);
  const result: UnknownRecord = {};

  for (const [profileName, value] of Object.entries(existing)) {
    if (!PUBLIC_MODEL_PROFILE_NAMES.has(profileName)) result[profileName] = value;
  }
  for (const profileName of PUBLIC_MODEL_PROFILE_NAMES) {
    if (!hasOwn(requested, profileName)) continue;
    result[profileName] = mergeProfile(existing[profileName], requested[profileName]);
  }
  return result;
}

/** Merge a projected runtime PATCH without making hidden runtime state readable. */
export function mergeAgentRuntimeConfigForUpdate(
  existingInput: unknown,
  requestedInput: unknown,
): UnknownRecord {
  const existing = asRecord(existingInput);
  const requested = asRecord(requestedInput);
  const result = preserveHiddenFields(existing, requested, PUBLIC_RUNTIME_KEYS);
  if (hasOwn(requested, "heartbeat")) {
    result.heartbeat = mergeHeartbeat(existing.heartbeat, requested.heartbeat);
  }
  if (hasOwn(requested, "modelProfiles")) {
    result.modelProfiles = mergeModelProfiles(existing.modelProfiles, requested.modelProfiles);
  }
  return result;
}
