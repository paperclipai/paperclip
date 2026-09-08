import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { unprocessable } from "../errors.js";
import { sanitizeRecord } from "../redaction.js";

export const CLAUDE_MANAGED_QUALIFICATION = {
  betaVersion: "managed-agents-2026-04-01",
  environmentPolicy: "limited_no_hosts_no_packages",
  agentCapabilities: "no_tools_no_mcp_no_skills_no_multiagent",
} as const;

export const CLAUDE_MANAGED_QUALIFIED_MODEL = "claude-sonnet-5" as const;
export const AGENTCORE_QUALIFICATION_SUITE = "aws-agentcore-harness-v1" as const;
export const AGENTCORE_QUALIFIED_MODEL = "global.anthropic.claude-sonnet-4-6" as const;

const REVISION_PREFIX = "sha256:";
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const SECRET_SHAPED_VALUE_PATTERNS = [
  /^\s*(?:bearer|basic)\s+\S+/i,
  /^sk-[A-Za-z0-9_-]{8,}$/,
  /^(?:gh[opusr]_[A-Za-z0-9]{12,}|xox[baprs]-\S+)$/,
  /^AKIA[0-9A-Z]{16}$/,
  /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?$/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
] as const;

function containsSecretShapedValue(value: unknown): boolean {
  if (typeof value === "string") {
    return SECRET_SHAPED_VALUE_PATTERNS.some((pattern) => pattern.test(value));
  }
  if (Array.isArray(value)) return value.some(containsSecretShapedValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(containsSecretShapedValue);
}

function normalizeKnownPublicValues(value: unknown): unknown {
  if (
    value === CLAUDE_MANAGED_QUALIFIED_MODEL
    || value === AGENTCORE_QUALIFIED_MODEL
  ) {
    return "paperclip-qualified-provider-model";
  }
  if (Array.isArray(value)) return value.map(normalizeKnownPublicValues);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, normalizeKnownPublicValues(entry)]),
  );
}

export function assertProfileMetadataContainsNoSecrets(
  value: Record<string, unknown>,
  label: string,
): void {
  const publicValueNormalized = normalizeKnownPublicValues(value) as Record<string, unknown>;
  if (
    !isDeepStrictEqual(sanitizeRecord(publicValueNormalized), publicValueNormalized)
    || containsSecretShapedValue(value)
  ) {
    throw unprocessable(`${label} must not contain credential-shaped keys or values`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    throw unprocessable(`${label} must contain the exact qualification attestation fields`);
  }
}

function assertIsoTimestamp(value: unknown, label: string): void {
  if (
    typeof value !== "string"
    || !ISO_TIMESTAMP_RE.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw unprocessable(`${label} must be an ISO-8601 UTC timestamp`);
  }
}

export function assertClaudeManagedQualification(
  qualification: Record<string, unknown>,
  options: { required: boolean },
): boolean {
  if (Object.keys(qualification).length === 0) {
    if (options.required) {
      throw unprocessable("Claude Managed qualification attestation is required before enablement");
    }
    return false;
  }
  assertProfileMetadataContainsNoSecrets(qualification, "Managed Agent qualification");
  assertExactKeys(
    qualification,
    ["probedAt", "betaVersion", "environmentPolicy", "agentCapabilities"],
    "Claude Managed qualification",
  );
  assertIsoTimestamp(qualification.probedAt, "qualification.probedAt");
  if (
    qualification.betaVersion !== CLAUDE_MANAGED_QUALIFICATION.betaVersion
    || qualification.environmentPolicy !== CLAUDE_MANAGED_QUALIFICATION.environmentPolicy
    || qualification.agentCapabilities !== CLAUDE_MANAGED_QUALIFICATION.agentCapabilities
  ) {
    throw unprocessable("Claude Managed qualification attestation does not match the qualified profile");
  }
  return true;
}

export function assertAgentCoreQualification(
  configuration: Record<string, unknown>,
  qualification: Record<string, unknown>,
  options: { required: boolean },
): boolean {
  if (Object.keys(qualification).length === 0) {
    if (options.required) {
      throw unprocessable("AWS AgentCore qualification attestation is required before enablement");
    }
    return false;
  }
  assertProfileMetadataContainsNoSecrets(qualification, "Remote Agent qualification");
  assertExactKeys(qualification, ["suite"], "AWS AgentCore qualification");
  if (
    configuration.qualificationRevision !== AGENTCORE_QUALIFICATION_SUITE
    || qualification.suite !== AGENTCORE_QUALIFICATION_SUITE
  ) {
    throw unprocessable("AWS AgentCore qualification attestation does not match the qualified harness suite");
  }
  return true;
}

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | {
  [key: string]: CanonicalJson;
};

function canonicalize(value: unknown, label: string): CanonicalJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, label));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry, label)]),
    );
  }
  throw unprocessable(`${label} contains a value that cannot be revisioned`);
}

export function computeQualifiedProfileRevision(
  value: Record<string, unknown>,
): string {
  const canonical = JSON.stringify(canonicalize(value, "Provider profile"));
  return `${REVISION_PREFIX}${createHash("sha256").update(canonical).digest("hex")}`;
}

export function isQualifiedProfileRevision(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}
