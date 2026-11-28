import { createHash, randomUUID } from "node:crypto";
import {
  PAPERCLIP_ENUM_DESCRIPTIONS,
  PAPERCLIP_EVENTS,
  type TelemetryDimensions,
  type TelemetryEvent,
} from "@paperclipai/shared/telemetry";
import {
  CLOUD_TRIAL_INFERENCE_FLAG_KEY,
  cloudTrialInferenceCohort,
  type CloudPostHogConfig,
} from "../cloud-posthog-config.js";
import { UNKNOWN_ENUM_FALLBACKS } from "./enum-fallbacks.generated.js";
import type { PostHogEventContext } from "./request-context.js";

/**
 * Builds PostHog capture messages for Paperclip Cloud direct delivery.
 *
 * The shape mirrors what the telemetry backend produces today for collector
 * events (ingest `normalizeCanonicalRecord` + loader `buildPostHogEvent`), so
 * existing insights keep working: same event names, metadata keys,
 * deterministic uuid, and enum fallback normalization. The intended Cloud
 * differences are real identifiers (distinct_id, agent_id, private refs) and
 * the added workspace properties (stack_id, company_id, user_id, environment,
 * $groups, $session_id, $window_id).
 */

export const POSTHOG_WORKSPACE_GROUP_TYPE = "workspace";

/**
 * Direct-path-only startup event. It is not in the generated contract and
 * never goes through the collector. It carries the hashed install id so an
 * offline job can join pre-switch history to the workspace without group
 * analytics.
 */
export const CLOUD_WORKSPACE_STARTED_EVENT = "cloud.workspace_started";

export type PostHogDirectEvent = {
  event: string;
  distinct_id: string;
  timestamp: string;
  uuid: string;
  disableGeoip: true;
  sendFeatureFlags: false;
  properties: Record<string, unknown>;
};

export type PostHogDirectBatchMeta = {
  app: string;
  schemaVersion: string;
  installId: string;
  version: string;
  ingestedAt: string;
};

type IdentityConfig = Pick<CloudPostHogConfig, "stackId" | "environment"> & {
  cloudTrialInferenceEnabled?: boolean;
};

export function cloudExperimentProperties(
  cloudTrialInferenceEnabled: boolean | undefined,
): Record<string, unknown> {
  if (typeof cloudTrialInferenceEnabled !== "boolean") return {};
  return {
    cloud_trial_inference_enabled: cloudTrialInferenceEnabled,
    [`$feature/${CLOUD_TRIAL_INFERENCE_FLAG_KEY}`]: cloudTrialInferenceCohort(cloudTrialInferenceEnabled),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Same formula as the telemetry backend's `deterministicEventId`. */
export function deterministicEventId(input: {
  app: string;
  installId: string;
  event: { name: string; occurredAt: string; dimensions: TelemetryDimensions };
}): string {
  return createHash("sha256")
    .update(String(input.app))
    .update("\0")
    .update(String(input.installId))
    .update("\0")
    .update(String(input.event.name))
    .update("\0")
    .update(String(input.event.occurredAt))
    .update("\0")
    .update(stableJson(input.event.dimensions ?? {}))
    .digest("hex");
}

/** Same formula as the telemetry backend's `eventIdToPostHogUuid`. */
export function eventIdToPostHogUuid(eventId: string): string {
  if (!/^[0-9a-f]{64}$/.test(eventId)) {
    throw new Error("eventIdToPostHogUuid requires a 64 lowercase hex event id");
  }
  const chars = eventId.slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = ((parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const ENUM_DOMAINS = PAPERCLIP_ENUM_DESCRIPTIONS as Record<string, Record<string, Record<string, string>>>;
const FALLBACKS = UNKNOWN_ENUM_FALLBACKS as Record<string, Record<string, { fallback: string; required: boolean }>>;

/**
 * Applies the backend's unknown-enum fallback. Returns null for an event the
 * collector path would quarantine (and so never reach PostHog): an
 * unregistered name, or an unknown enum value whose fallback is itself not an
 * allowed value.
 */
export function normalizeDimensions(
  eventName: string,
  dimensions: TelemetryDimensions,
): { dimensions: TelemetryDimensions; normalizedProperties: string[] } | null {
  if (!Object.hasOwn(PAPERCLIP_EVENTS, eventName)) return null;
  const normalized: TelemetryDimensions = { ...dimensions };
  const normalizedProperties: string[] = [];
  for (const [key, rule] of Object.entries(FALLBACKS[eventName] ?? {})) {
    const allowed = Object.keys(ENUM_DOMAINS[eventName]?.[key] ?? {});
    const value = normalized[key];
    if (value === undefined) {
      if (rule.required && allowed.includes(rule.fallback)) {
        normalized[key] = rule.fallback;
        normalizedProperties.push(key);
      }
      continue;
    }
    if (allowed.length > 0 && !allowed.includes(String(value))) {
      if (!allowed.includes(rule.fallback)) return null;
      normalized[key] = rule.fallback;
      normalizedProperties.push(key);
    }
  }
  return { dimensions: normalized, normalizedProperties: normalizedProperties.sort() };
}

function utcPartitions(occurredAt: string): { event_date: string; hour: string } {
  const ts = new Date(occurredAt);
  return {
    event_date: ts.toISOString().slice(0, 10),
    hour: String(ts.getUTCHours()).padStart(2, "0"),
  };
}

/** The acting user when known, else the workspace. */
export function resolveDistinctId(config: IdentityConfig, context: PostHogEventContext | undefined): string {
  return context?.userId ?? `workspace:${config.stackId}`;
}

export function buildPostHogDirectEvent(
  event: TelemetryEvent,
  context: PostHogEventContext | undefined,
  meta: PostHogDirectBatchMeta,
  config: IdentityConfig,
): PostHogDirectEvent | null {
  const normalized = normalizeDimensions(event.name, event.dimensions ?? {});
  if (!normalized) return null;
  const eventId = deterministicEventId({
    app: meta.app,
    installId: meta.installId,
    event: { name: event.name, occurredAt: event.occurredAt, dimensions: normalized.dimensions },
  });
  const distinctId = resolveDistinctId(config, context);
  const hasPerson = Boolean(context?.userId);
  return {
    event: event.name,
    distinct_id: distinctId,
    timestamp: event.occurredAt,
    uuid: eventIdToPostHogUuid(eventId),
    disableGeoip: true,
    sendFeatureFlags: false,
    properties: {
      // Metadata keys and order match the backend loader's buildProperties().
      app: meta.app,
      schema_version: meta.schemaVersion,
      source: "client",
      deployment_source: "cloud",
      ingested_at: meta.ingestedAt,
      ...utcPartitions(event.occurredAt),
      normalized_properties: normalized.normalizedProperties,
      ...(meta.version ? { version: meta.version } : {}),
      ...normalized.dimensions,
      // Cloud-only properties.
      stack_id: config.stackId,
      ...(context?.companyId ? { company_id: context.companyId } : {}),
      ...(context?.userId ? { user_id: context.userId } : {}),
      attributed_via: context?.userId ? (context.attributedVia ?? "request") : "none",
      ...(config.environment ? { environment: config.environment } : {}),
      ...cloudExperimentProperties(config.cloudTrialInferenceEnabled),
      ...(context?.sessionId ? { $session_id: context.sessionId } : {}),
      ...(context?.windowId ? { $window_id: context.windowId } : {}),
      $groups: { [POSTHOG_WORKSPACE_GROUP_TYPE]: config.stackId },
      distinct_id: distinctId,
      // A workspace id must never become a person profile.
      ...(hasPerson ? {} : { $process_person_profile: false }),
    },
  };
}

/** The `cloud.workspace_started` event sent once per server start on Cloud. */
export function buildWorkspaceStartedEvent(
  input: { installHash: string; occurredAt: string },
  meta: PostHogDirectBatchMeta,
  config: IdentityConfig,
): PostHogDirectEvent {
  const distinctId = resolveDistinctId(config, undefined);
  const eventId = deterministicEventId({
    app: meta.app,
    installId: meta.installId,
    event: {
      name: CLOUD_WORKSPACE_STARTED_EVENT,
      occurredAt: input.occurredAt,
      dimensions: { stack_id: config.stackId, install_hash: input.installHash },
    },
  });
  return {
    event: CLOUD_WORKSPACE_STARTED_EVENT,
    distinct_id: distinctId,
    timestamp: input.occurredAt,
    uuid: eventIdToPostHogUuid(eventId),
    disableGeoip: true,
    sendFeatureFlags: false,
    properties: {
      app: meta.app,
      schema_version: meta.schemaVersion,
      source: "client",
      deployment_source: "cloud",
      ingested_at: meta.ingestedAt,
      ...utcPartitions(input.occurredAt),
      normalized_properties: [],
      ...(meta.version ? { version: meta.version } : {}),
      stack_id: config.stackId,
      install_hash: input.installHash,
      attributed_via: "none",
      ...(config.environment ? { environment: config.environment } : {}),
      ...cloudExperimentProperties(config.cloudTrialInferenceEnabled),
      $groups: { [POSTHOG_WORKSPACE_GROUP_TYPE]: config.stackId },
      distinct_id: distinctId,
      $process_person_profile: false,
    },
  };
}

/**
 * Cloud-only direct PostHog event (not in the self-hosted collector contract).
 * Used for Cloud experiment exposure (`$feature_flag_called`) and Cloud starter
 * inference funnel events (`cloud_trial.*`).
 */
export function buildCloudDirectEvent(
  input: {
    event: string;
    occurredAt: string;
    properties?: Record<string, unknown>;
    setOncePersonProperties?: Record<string, unknown>;
  },
  context: PostHogEventContext | undefined,
  config: IdentityConfig,
): PostHogDirectEvent {
  const distinctId = resolveDistinctId(config, context);
  const hasPerson = Boolean(context?.userId);
  const setOnce: Record<string, unknown> = {
    ...(typeof config.cloudTrialInferenceEnabled === "boolean"
      ? { cloud_trial_inference_cohort: cloudTrialInferenceCohort(config.cloudTrialInferenceEnabled) }
      : {}),
    ...(input.setOncePersonProperties ?? {}),
  };
  return {
    event: input.event,
    distinct_id: distinctId,
    timestamp: input.occurredAt,
    uuid: randomUUID(),
    disableGeoip: true,
    sendFeatureFlags: false,
    properties: {
      deployment_source: "cloud",
      stack_id: config.stackId,
      ...(context?.companyId ? { company_id: context.companyId } : {}),
      ...(context?.userId ? { user_id: context.userId } : {}),
      ...(config.environment ? { environment: config.environment } : {}),
      ...cloudExperimentProperties(config.cloudTrialInferenceEnabled),
      ...(input.properties ?? {}),
      ...(context?.sessionId ? { $session_id: context.sessionId } : {}),
      ...(context?.windowId ? { $window_id: context.windowId } : {}),
      $groups: { [POSTHOG_WORKSPACE_GROUP_TYPE]: config.stackId },
      distinct_id: distinctId,
      ...(hasPerson && Object.keys(setOnce).length > 0 ? { $set_once: setOnce } : {}),
      ...(hasPerson ? {} : { $process_person_profile: false }),
    },
  };
}
