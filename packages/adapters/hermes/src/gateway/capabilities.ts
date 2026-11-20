// capabilities.ts — hermes_gateway capability negotiation + read-only
// inventory (Layer 1, spec-309 Phase 1). Upstream-PR-quality TS authored for
// `packages/adapters/hermes/src/gateway/capabilities.ts` in paperclipai/paperclip
// (this file is copied there verbatim by
// specs/309-hermes-gateway-remote-skill-contract/scripts/build-paperclip-hermes-fork.sh).
//
// Contract source of truth:
// - specs/309-hermes-gateway-remote-skill-contract/contracts/remote-skill-contract-v1.md
//   (§Layer 1 + §Fail-closed matrix + §Versioning)
// - specs/309-hermes-gateway-remote-skill-contract/data-model.md (CapabilityDescriptor)
//
// Registration into createServerAdapter() (index.ts) is Plan 02's concern
// (this plan's scope is the negotiation function + its fail-closed matrix,
// proven via the dist-imported unit suite, per 01-CONTEXT.md phase boundary).

import {
  allowsInsecureRemoteHttp,
  isRemotePlainHttp,
  remotePlainHttpDeniedMessage,
} from "./server/transport-security.js";

export type NegotiationOutcome =
  | "negotiated"
  | "unsupported"
  | "auth_error"
  | "malformed"
  | "transient_error"
  | "auth_incompat";

export interface CapabilityDescriptor {
  contractVersion: string;
  remoteVersion: string | null;
  inventorySupported: boolean;
  activationSupported: boolean;
  negotiationOutcome: NegotiationOutcome;
  negotiatedAt: string;
}

export interface NegotiationResult {
  capability: CapabilityDescriptor;
  /** Validated raw skill list from /v1/skills — non-null ONLY when
   * negotiationOutcome === "negotiated" (atomic negotiation+inventory, no
   * second racy fetch for Plan 02's listSkills to perform). */
  inventory: unknown[] | null;
}

/** Config accepted by negotiateCapability. Mirrors the existing
 * getConfigSchema() fields (config-schema.ts) plus one Phase-1-local
 * addition (`negotiationTimeoutMs`) — no new getConfigSchema field was
 * added (research Open Question 2 default), since a bounded negotiation
 * deadline is read directly off this ad-hoc config object, not surfaced as
 * a user-configurable UI field in this phase. */
export interface NegotiateCapabilityConfig {
  apiBaseUrl?: unknown;
  apiKey?: unknown;
  negotiationTimeoutMs?: unknown;
  [key: string]: unknown;
}

const CONTRACT_VERSION = "1";
// No config-schema field exists for this yet (Open Question 2 default: no
// new field unless a concrete need arises) — a bounded negotiation deadline
// is exactly that concrete need (negotiate_timeout_transient), so it is read
// as an optional ad-hoc config key with this documented default.
const DEFAULT_NEGOTIATION_TIMEOUT_MS = 10_000;
// Memory-DoS guard (T-01-03): cap every remote response body read.
const MAX_RESPONSE_BYTES = 1024 * 1024;
// The auth scheme this adapter expects on a healthy v0.16/v1 remote.
const EXPECTED_AUTH_SCHEME = "bearer";

// The legacy unsupported response literal (INT-002). Deliberately frozen;
// never rebuilt by the general outcome path below (research Pitfall 2).
// Byte-identical to tests/fixtures/hermes-stub-server.mjs's UNSUPPORTED_LITERAL
// — no spec-302-recorded artifact was located in this repo or its git
// history (searched via `git log --all --diff-filter=A --name-only`), so
// this is the CONTEXT.md-specified literal, not a byte-verified historical
// shape. Keep both files in sync if this ever changes.
export const LEGACY_UNSUPPORTED_RESPONSE = Object.freeze({
  supported: false,
  mode: "unsupported",
  entries: Object.freeze([]),
  warning: "Remote Hermes gateway does not advertise skills_api; skill inventory is unsupported.",
});

/** Legacy-surface helper: returns the frozen unsupported literal above. A
 * shape deliberately DISTINCT from CapabilityDescriptor/NegotiationResult —
 * never conflated with the negotiated descriptor. */
export function legacyUnsupportedSkillsResponse(): typeof LEGACY_UNSUPPORTED_RESPONSE {
  return LEGACY_UNSUPPORTED_RESPONSE;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// LD-S2(b), 02-02-PLAN.md: the real v2026.6.5 `/v1/capabilities` serves
// `features` as an OBJECT MAP (api_server.py:1110-1135 @
// 3c231eb3979ab9c57d5cd6d02f1d577a3b718b43, verified firsthand) with mixed
// boolean/string values (e.g. "skills_api": true, "session_continuity_header":
// "..."), NOT a string array. A non-object features value -- INCLUDING the
// Phase-1 fantasy array shape -- negotiates unsupported fail-closed (proven
// by capability-negotiation.test.mjs's negotiate_array_features_unsupported).
function asFeatureMap(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// Mirrors execute.ts's private normalizeBaseUrl/apiUrl conventions (trailing
// slash strip, no query/hash) — execute.ts does not export these, and this
// plan's scope is limited to capabilities.ts (Plan 02 registers this module
// in index.ts), so the same normalization rule is reproduced locally rather
// than modifying an out-of-scope file.
function normalizeBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function apiUrl(baseUrl: URL, path: string): string {
  return `${baseUrl.toString().replace(/\/+$/, "")}${path}`;
}

// Mirrors execute.ts's buildHeaders Authorization convention
// (`Authorization: Bearer <apiKey>`) — the ONLY header this negotiation
// path needs.
function buildAuthHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
}

async function requestWithDeadline(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method: "GET", headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a Response body capped at maxBytes. Returns { ok:false } (routed to
 * `malformed` by the caller) when the body exceeds the cap, never buffering
 * an unbounded remote-controlled payload. */
async function readCappedText(response: Response, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") > maxBytes ? { ok: false } : { ok: true, text };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false };
      }
      chunks.push(value);
    }
  }
  return { ok: true, text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8") };
}

function parseRemoteVersion(capabilities: Record<string, unknown>): string | null {
  const runtime = asString(capabilities.runtime);
  // No field is confirmed to carry a parseable version on a v0.16 remote
  // (research Assumptions Log A1) — only treat it as a version when it
  // actually looks like one (leading digit, optional "v" prefix); otherwise
  // remoteVersion stays null (data-model.md explicitly allows this; never
  // invented as a stub-only field).
  return /^v?\d+(\.\d+)*$/i.test(runtime) ? runtime.replace(/^v/i, "") : null;
}

function isV017AuthMismatch(remoteVersion: string | null, authScheme: string | null): boolean {
  // ADAPTER-DEFINED HEURISTIC (research Pitfall 3 / EDGE-007, #8924 lineage):
  // a parseable v0.17.x version PLUS an auth-scheme signal distinct from
  // this adapter's expected scheme. NOT a published Hermes v0.17 wire
  // guarantee — revalidate against the live matrix in Phase 4.
  if (!remoteVersion || !authScheme) return false;
  return remoteVersion.startsWith("0.17") && authScheme.toLowerCase() !== EXPECTED_AUTH_SCHEME;
}

function outcomeResult(
  outcome: Exclude<NegotiationOutcome, "negotiated">,
  negotiatedAt: string,
  remoteVersion: string | null = null,
): NegotiationResult {
  return {
    capability: {
      contractVersion: CONTRACT_VERSION,
      remoteVersion,
      inventorySupported: false,
      activationSupported: false,
      negotiationOutcome: outcome,
      negotiatedAt,
    },
    inventory: null,
  };
}

/**
 * Negotiates capability + read-only inventory against a Hermes remote.
 * `GET /v1/capabilities` then, only if `skills_api` is advertised,
 * `GET /v1/skills` — fail-closed at every branch (contract §Fail-closed
 * matrix). Returns a NegotiationResult carrying the validated inventory
 * atomically with the descriptor (non-null only when negotiated).
 */
export async function negotiateCapability(config: NegotiateCapabilityConfig): Promise<NegotiationResult> {
  const negotiatedAt = new Date().toISOString();
  const baseUrl = normalizeBaseUrl(asString(config.apiBaseUrl));
  const apiKey = asString(config.apiKey);
  if (!baseUrl || !apiKey) {
    return outcomeResult("unsupported", negotiatedAt);
  }

  if (isRemotePlainHttp(baseUrl) && !allowsInsecureRemoteHttp(config)) {
    throw new Error(remotePlainHttpDeniedMessage(baseUrl.hostname));
  }

  const timeoutMs = asNumber(config.negotiationTimeoutMs) ?? DEFAULT_NEGOTIATION_TIMEOUT_MS;
  const headers = buildAuthHeaders(apiKey);

  let capabilitiesRecord: Record<string, unknown>;
  try {
    const response = await requestWithDeadline(apiUrl(baseUrl, "/v1/capabilities"), headers, timeoutMs);
    if (response.status === 401 || response.status === 403) {
      return outcomeResult("auth_error", negotiatedAt);
    }
    if (response.status === 404) {
      // Missing route entirely = old remote = unsupported, NEVER malformed
      // (research Anti-Pattern).
      return outcomeResult("unsupported", negotiatedAt);
    }
    if (response.status >= 500) {
      return outcomeResult("transient_error", negotiatedAt);
    }
    if (!response.ok) {
      return outcomeResult("malformed", negotiatedAt);
    }
    const capped = await readCappedText(response, MAX_RESPONSE_BYTES);
    if (!capped.ok) return outcomeResult("malformed", negotiatedAt);
    let parsed: unknown;
    try {
      parsed = JSON.parse(capped.text);
    } catch {
      return outcomeResult("malformed", negotiatedAt);
    }
    const record = asRecord(parsed);
    if (!record) return outcomeResult("malformed", negotiatedAt);
    capabilitiesRecord = record;
  } catch {
    return outcomeResult("transient_error", negotiatedAt);
  }

  const remoteVersion = parseRemoteVersion(capabilitiesRecord);
  const authScheme = typeof capabilitiesRecord.authScheme === "string" ? capabilitiesRecord.authScheme : null;
  if (isV017AuthMismatch(remoteVersion, authScheme)) {
    return outcomeResult("auth_incompat", negotiatedAt, remoteVersion);
  }

  const features = asFeatureMap(capabilitiesRecord.features);
  // Non-object features (including the old fantasy array shape) -> refuse
  // fail-closed, never a partial/legacy re-interpretation (LD-S2(b)).
  if (!features || features["skills_api"] !== true) {
    return outcomeResult("unsupported", negotiatedAt, remoteVersion);
  }

  let activationCandidate = false;
  for (const [key, value] of Object.entries(features)) {
    if (!key.startsWith("skills_activation/") || !value) continue;
    const major = key.split("/")[1] ?? "";
    if (major !== "v1") {
      // Locked: unknown contract major -> refuse fail-closed, never partial.
      return outcomeResult("unsupported", negotiatedAt, remoteVersion);
    }
    activationCandidate = true;
  }

  try {
    const response = await requestWithDeadline(apiUrl(baseUrl, "/v1/skills"), headers, timeoutMs);
    if (response.status === 401 || response.status === 403) {
      return outcomeResult("auth_error", negotiatedAt, remoteVersion);
    }
    if (response.status >= 500) {
      return outcomeResult("transient_error", negotiatedAt, remoteVersion);
    }
    if (!response.ok) {
      return outcomeResult("malformed", negotiatedAt, remoteVersion);
    }
    const capped = await readCappedText(response, MAX_RESPONSE_BYTES);
    if (!capped.ok) return outcomeResult("malformed", negotiatedAt, remoteVersion);
    let parsed: unknown;
    try {
      parsed = JSON.parse(capped.text);
    } catch {
      return outcomeResult("malformed", negotiatedAt, remoteVersion);
    }
    const record = asRecord(parsed);
    const data = record && Array.isArray(record.data) ? (record.data as unknown[]) : null;
    if (!data) return outcomeResult("malformed", negotiatedAt, remoteVersion);

    return {
      capability: {
        contractVersion: CONTRACT_VERSION,
        remoteVersion,
        inventorySupported: true,
        // activationSupported true ONLY together with inventorySupported
        // true (data-model.md validation) — both are true only here, in the
        // single success branch.
        activationSupported: activationCandidate,
        negotiationOutcome: "negotiated",
        negotiatedAt,
      },
      inventory: data,
    };
  } catch {
    return outcomeResult("transient_error", negotiatedAt, remoteVersion);
  }
}
