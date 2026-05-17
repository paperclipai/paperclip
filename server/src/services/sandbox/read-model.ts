/**
 * Phase 4A-2 (LET-314): sandbox lease read-model.
 *
 * Translates an `EnvironmentLease` row into a redacted, allowlisted shape
 * that is safe to return from the `/api/sandbox` REST/SSE surface or to
 * publish on the sandbox event bus. Producers MUST pipe payloads through
 * `redactSandboxEventPayload` before publishing — no raw env, token,
 * credential, proxy, destination id, or sensitive log payload is allowed
 * to leak through this surface.
 */

import type { EnvironmentLease } from "@paperclipai/shared";
import { redactLearningEvidence } from "@paperclipai/shared";
import {
  SANDBOX_LEASE_STATES,
  type SandboxLeaseState,
} from "./lease-state-machine.js";
import { DOCKER_SANDBOX_PROVIDER_KEY } from "./docker-provider.js";

export type SandboxReadModelTruth = "backend-backed" | "derived" | "preview";

export interface SandboxLeaseReadModel {
  /** Database-backed identifiers. */
  id: string;
  companyId: string;
  environmentId: string;
  executionWorkspaceId: string | null;
  issueId: string | null;
  heartbeatRunId: string | null;

  /** Coarse DB-column status (active|released|expired|failed|retained). */
  status: EnvironmentLease["status"];
  leasePolicy: EnvironmentLease["leasePolicy"];

  /** Sandbox-specific provider snapshot. */
  provider: string | null;
  providerLeaseId: string | null;
  kind: string | null;

  /**
   * Fine-grained sandbox state machine label
   * (requested|provisioning|running|collecting|cleanup|expired|failed),
   * or null when the lease metadata does not carry a sandbox state yet.
   */
  sandboxState: SandboxLeaseState | null;

  /** Boundary projection. Allowlisted fields only — no raw config. */
  capabilities: Record<string, unknown> | null;
  quotas: Record<string, unknown> | null;
  network: Record<string, unknown> | null;
  policyHash: string | null;

  /** Redacted artifact summary (boolean + count only, never raw paths). */
  artifacts: {
    present: boolean;
    count: number;
  };

  /**
   * Truth label for downstream UIs:
   *   - "backend-backed" : the lease row carries a real provider lease id and
   *     a sandbox state advanced past `requested`.
   *   - "derived"        : the lease row exists but the sandbox state has not
   *     advanced past `requested`/`provisioning`.
   *   - "preview"        : the lease has no provider lease id at all — the
   *     row is a scaffolded/preview lease and no real runtime is implied.
   */
  truth: SandboxReadModelTruth;

  /**
   * True when the lease's provider key is currently disabled (e.g. the
   * Docker provider scaffold with `PAPERCLIP_DOCKER_SANDBOX_ENABLED` unset).
   * Read models on a disabled provider are always `preview`.
   */
  providerEnabled: boolean;

  /** Redacted failure reason (if any). */
  failureReason: string | null;
  cleanupStatus: EnvironmentLease["cleanupStatus"];

  acquiredAt: string;
  lastUsedAt: string;
  expiresAt: string | null;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const SANDBOX_STATE_SET: ReadonlySet<string> = new Set(SANDBOX_LEASE_STATES);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readSandboxState(metadata: Record<string, unknown> | null): SandboxLeaseState | null {
  const raw = metadata?.sandboxState;
  if (typeof raw !== "string" || !SANDBOX_STATE_SET.has(raw)) return null;
  return raw as SandboxLeaseState;
}

/**
 * Allowlist projection over metadata.capabilities. Drops unknown fields
 * defensively so an attacker-controlled provider cannot leak arbitrary
 * key/value pairs through the read model.
 */
const CAPABILITY_ALLOWLIST = new Set([
  "rootless",
  "dropAllCapabilities",
  "seccompProfile",
  "readOnlyRootfs",
  "noNewPrivileges",
  "cgroupsVersion",
]);

const QUOTA_ALLOWLIST = new Set([
  "cpuMillicores",
  "memoryBytes",
  "pidsMax",
  "ephemeralStorageBytes",
  "wallClockSeconds",
  "maxOpenFiles",
]);

const NETWORK_ALLOWLIST = new Set([
  "mode",
  "egressAllowlist",
  "dnsAllowlist",
  "allowLoopback",
  "allowInboundPorts",
]);

function projectAllowlisted(
  source: Record<string, unknown> | null,
  allowed: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (!source) return null;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (allowed.has(key)) out[key] = source[key];
  }
  return out;
}

function readPolicyHash(
  leaseColumn: string | null,
  metadata: Record<string, unknown> | null,
): string | null {
  if (typeof leaseColumn === "string" && leaseColumn.length > 0) return leaseColumn;
  const fromMetadata = metadata?.policyHash;
  return typeof fromMetadata === "string" && fromMetadata.length > 0 ? fromMetadata : null;
}

function readArtifactSummary(metadata: Record<string, unknown> | null): { present: boolean; count: number } {
  const artifacts = metadata?.artifacts;
  if (Array.isArray(artifacts)) {
    return { present: artifacts.length > 0, count: artifacts.length };
  }
  if (artifacts && typeof artifacts === "object") {
    const count = Object.keys(artifacts as Record<string, unknown>).length;
    return { present: count > 0, count };
  }
  return { present: false, count: 0 };
}

export interface SandboxProviderStatusSnapshot {
  provider: string;
  enabled: boolean;
}

function isProviderEnabledForLease(
  providerKey: string | null,
  providerStatuses: ReadonlyMap<string, boolean>,
): boolean {
  if (!providerKey) return false;
  const known = providerStatuses.get(providerKey);
  if (known !== undefined) return known;
  // Unknown providers (e.g. plugin-backed) are treated as not-enabled from
  // the read-model's perspective until they are explicitly registered.
  return false;
}

function deriveTruth(input: {
  providerLeaseId: string | null;
  sandboxState: SandboxLeaseState | null;
  providerEnabled: boolean;
}): SandboxReadModelTruth {
  if (!input.providerEnabled) return "preview";
  if (!input.providerLeaseId) return "preview";
  if (!input.sandboxState) return "derived";
  if (input.sandboxState === "requested" || input.sandboxState === "provisioning") {
    return "derived";
  }
  return "backend-backed";
}

export function toSandboxLeaseReadModel(
  lease: EnvironmentLease,
  providerStatuses: ReadonlyMap<string, boolean> = new Map(),
): SandboxLeaseReadModel {
  const metadata = asRecord(lease.metadata);
  const sandboxState = readSandboxState(metadata);
  const providerEnabled = isProviderEnabledForLease(lease.provider, providerStatuses);
  const truth = deriveTruth({
    providerLeaseId: lease.providerLeaseId,
    sandboxState,
    providerEnabled,
  });
  const capabilitiesSource = asRecord(metadata?.capabilities);
  const quotasSource = asRecord(metadata?.quotas);
  const networkSource = asRecord(metadata?.network);

  return {
    id: lease.id,
    companyId: lease.companyId,
    environmentId: lease.environmentId,
    executionWorkspaceId: lease.executionWorkspaceId,
    issueId: lease.issueId,
    heartbeatRunId: lease.heartbeatRunId,
    status: lease.status,
    leasePolicy: lease.leasePolicy,
    provider: lease.provider,
    providerLeaseId: lease.providerLeaseId,
    kind: typeof metadata?.kind === "string" ? (metadata.kind as string) : null,
    sandboxState,
    capabilities: projectAllowlisted(capabilitiesSource, CAPABILITY_ALLOWLIST),
    quotas: projectAllowlisted(quotasSource, QUOTA_ALLOWLIST),
    network: projectAllowlisted(networkSource, NETWORK_ALLOWLIST),
    policyHash: readPolicyHash(null, metadata),
    artifacts: readArtifactSummary(metadata),
    truth,
    providerEnabled,
    failureReason: lease.failureReason ? redactLearningEvidence(lease.failureReason) : null,
    cleanupStatus: lease.cleanupStatus,
    acquiredAt: lease.acquiredAt.toISOString(),
    lastUsedAt: lease.lastUsedAt.toISOString(),
    expiresAt: lease.expiresAt ? lease.expiresAt.toISOString() : null,
    releasedAt: lease.releasedAt ? lease.releasedAt.toISOString() : null,
    createdAt: lease.createdAt.toISOString(),
    updatedAt: lease.updatedAt.toISOString(),
  };
}

/**
 * Keys whose values are treated as secret regardless of content. Matched
 * case-insensitively against key names anywhere in the payload tree. We
 * pessimistically replace the value with the `[REDACTED]` sentinel rather
 * than relying on regex-based string scrubbing, because secrets often do
 * not match heuristic patterns (e.g. short tokens, opaque IDs).
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /token/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /api[-_]?key/i,
  /apikey/i,
  /auth[-_]?(z|token|orization)?/i,
  /credential/i,
  /cred(?:s)?$/i,
  /private[-_]?key/i,
  /access[-_]?key/i,
  /session[-_]?id/i,
  /cookie/i,
  /bearer/i,
  /proxy/i,
  /destination[-_]?id/i,
  /^env$/i,
  /environment[-_]?variables?/i,
];

const REDACTED_SENTINEL = "[REDACTED]";

function isSensitiveKey(key: string): boolean {
  for (const pattern of SENSITIVE_KEY_PATTERNS) {
    if (pattern.test(key)) return true;
  }
  return false;
}

/**
 * Defense-in-depth redaction for an arbitrary event payload. Producers
 * should pass already-allowlisted payloads (`toSandboxLeaseReadModel`),
 * but this helper additionally:
 *   - drops/redacts values for sensitive keys (token, apiKey, password,
 *     secret, credential, env, proxy, destinationId, …) regardless of
 *     their value content, and
 *   - recursively scrubs string values for known secret patterns via
 *     `redactLearningEvidence`.
 */
export function redactSandboxEventPayload<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return redactLearningEvidence(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSandboxEventPayload(item)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        // Replace any value (string, object, array, primitive) under a
        // sensitive key with the redaction sentinel so the shape stays
        // serializable but never leaks the underlying payload.
        out[key] = REDACTED_SENTINEL;
        continue;
      }
      out[key] = redactSandboxEventPayload(item);
    }
    return out as unknown as T;
  }
  return value;
}

export interface SandboxProviderDescriptor {
  provider: string;
  kind: "builtin";
  enabled: boolean;
  /** True for any provider that cannot drive a real container in this child. */
  previewOnly: boolean;
}

/**
 * Build provider descriptors from the built-in registry. The Docker
 * provider remains preview-only in Phase 4A-2 because LET-314's scope
 * forbids live container execution from the REST/SSE surface, even when
 * the feature flag is set. The `enabled` flag tracks whether the flag is
 * set — `previewOnly` is the public-facing truth label.
 */
export function describeBuiltinSandboxProvider(input: {
  provider: string;
  enabled: boolean;
}): SandboxProviderDescriptor {
  const provider = input.provider;
  // Only the docker scaffold has a runtime-flag distinction today; "fake"
  // is intrinsically preview-only.
  if (provider === DOCKER_SANDBOX_PROVIDER_KEY) {
    return {
      provider,
      kind: "builtin",
      enabled: input.enabled,
      previewOnly: true,
    };
  }
  return {
    provider,
    kind: "builtin",
    enabled: false,
    previewOnly: true,
  };
}
