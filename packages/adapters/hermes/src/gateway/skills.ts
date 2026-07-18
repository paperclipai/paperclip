// skills.ts — hermes_gateway read-only inventory mapping (Layer 1) + the
// deterministic desired->activated->observed syncSkills reconcile (Layer 2,
// spec-309 Phase 2, Plan 03). Upstream-PR-quality TS authored for
// `packages/adapters/hermes/src/gateway/skills.ts` in paperclipai/paperclip
// (copied there verbatim by
// specs/309-hermes-gateway-remote-skill-contract/scripts/build-paperclip-hermes-fork.sh).
//
// Contract source of truth:
// - specs/309-hermes-gateway-remote-skill-contract/contracts/remote-skill-contract-v1.md
//   (§Layer 1: ReadOnlySkillEntry; §Layer 2: activation/clean/managed-scope
//   wire + adapter surface)
// - specs/309-hermes-gateway-remote-skill-contract/data-model.md
// - 02-03-PLAN.md <locked_decisions> (LD-2/5/6/7/8) — the adjudicated
//   rationale this file realizes.
//
// HTTP discipline note (Task 2 hard constraint 2): capabilities.ts's
// requestWithDeadline/readCappedText/normalizeBaseUrl/buildAuthHeaders are
// module-private and GET-only, so they cannot be imported. The equivalents
// below are a skills.ts-PRIVATE, method-parameterized MIRROR of that same
// idiom (bounded-deadline fetch + capped-body read) — the established
// Phase-1 precedent (capabilities.ts itself mirrors execute.ts's private
// helpers; see capabilities.ts's own header comment). capabilities.ts is
// NOT modified by this plan.

import { createHash, randomBytes } from "node:crypto";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
  AdapterSkillState,
} from "@paperclipai/adapter-utils";
import { negotiateCapability, LEGACY_UNSUPPORTED_RESPONSE } from "./capabilities.js";

const ADAPTER_TYPE = "hermes_gateway";

// Sanity cap on inventory size (T-01-04 memory-DoS adjacent guard) — an
// inventory above this is rejected fail-closed rather than accepted
// unbounded. Reused for the desired-set cap (DoS posture parity, Task 2
// hard constraint 4) and the managed-inventory cap (Task 2 constraint 6).
const MAX_ENTRIES = 500;

function unsupportedSnapshot(warning: string): AdapterSkillSnapshot {
  return {
    adapterType: ADAPTER_TYPE,
    supported: false,
    mode: "unsupported",
    desiredSkills: [],
    entries: [],
    warnings: [warning],
  };
}

/**
 * Maps the NegotiationResult-carried inventory into real AdapterSkillEntry
 * records, constructed field-by-field (never spread from the remote object —
 * T-01-06, so no remote field, canary included, can propagate). Returns
 * `null` when ANY item fails per-item validation — the whole response is
 * then rejected fail-closed by the caller, never a partial mapping of the
 * valid subset (T-01-04).
 */
function mapInventory(inventory: unknown[]): AdapterSkillEntry[] | null {
  if (inventory.length > MAX_ENTRIES) return null;

  const seenKeys = new Set<string>();
  const entries: AdapterSkillEntry[] = [];

  for (const raw of inventory) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;

    // Resolved stable field (01-01-PLAN.md provenance): the v0.16 /v1/skills
    // envelope carries no field distinct from `name` — skillId <- name.
    const stableId = typeof record.name === "string" ? record.name.trim() : "";
    if (!stableId || seenKeys.has(stableId)) return null;
    seenKeys.add(stableId);

    // Field-by-field construction only — required fields pinned to the
    // read-only-invariant values; version/contentHash are set ONLY when the
    // remote item actually carries them (v0.16 items carry neither).
    const entry: AdapterSkillEntry = {
      key: stableId,
      runtimeName: stableId,
      managed: false,
      desired: false,
      state: "available",
      readOnly: true,
      origin: "external_unknown",
      originLabel: "remote-native",
    };
    entries.push(entry);
  }

  return entries;
}

/**
 * Read-only inventory for the negotiated hermes_gateway adapter.
 * Negotiates FIRST (via negotiateCapability) and maps ONLY the inventory
 * carried inside that single NegotiationResult — no second `/v1/skills`
 * fetch, no TOCTOU window.
 */
export async function listSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  const result = await negotiateCapability(ctx.config);
  const { capability, inventory } = result;

  if (capability.negotiationOutcome !== "negotiated" || !capability.inventorySupported || inventory === null) {
    // Honest negative — including unknown-major refusals, which
    // negotiateCapability already resolves to "unsupported" (Plan 01).
    return unsupportedSnapshot(`negotiation:${capability.negotiationOutcome}`);
  }

  const entries = mapInventory(inventory);
  if (entries === null) {
    return unsupportedSnapshot("malformed:invalid_inventory_item");
  }

  return {
    adapterType: ADAPTER_TYPE,
    supported: true,
    // Activation is never negotiated at Layer 1 — the reconcile algorithm
    // (desired/activated/observed transitions) is Phase 2 scope.
    mode: "unsupported",
    desiredSkills: [],
    entries,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Layer 2 — syncSkills deterministic reconcile (02-03-PLAN.md)
// ---------------------------------------------------------------------------

const SKILL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_WIRE_TIMEOUT_MS = 10_000;

interface DesiredBundle {
  version: string;
  content: string;
}

function isValidBundle(value: unknown): value is DesiredBundle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.version === "string" &&
    record.version.length > 0 &&
    typeof record.content === "string" &&
    record.content.length > 0
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Mirrors capabilities.ts's normalizeBaseUrl (module-private there, so
// reproduced locally rather than modifying an out-of-scope file).
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

function buildAuthHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
}

interface WireConfig {
  baseUrl: URL;
  headers: Record<string, string>;
  timeoutMs: number;
}

function resolveWireConfig(config: Record<string, unknown>): WireConfig | null {
  const baseUrl = normalizeBaseUrl(asString(config.apiBaseUrl));
  const apiKey = asString(config.apiKey);
  if (!baseUrl || !apiKey) return null;
  const timeoutMs = asNumber(config.negotiationTimeoutMs) ?? DEFAULT_WIRE_TIMEOUT_MS;
  return { baseUrl, headers: buildAuthHeaders(apiKey), timeoutMs };
}

// Method-parameterized mirror of capabilities.ts's requestWithDeadline
// (GET-only there) — same bounded-deadline discipline for POST/DELETE.
async function requestWithDeadline(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method, headers, body, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Mirrors capabilities.ts's readCappedText (module-private there).
async function readCappedText(
  response: Response,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
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

function inventoryNames(inventory: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const raw of inventory) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const rawName = (raw as Record<string, unknown>).name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (name) names.add(name);
  }
  return names;
}

interface ManagedEntry {
  name: string;
  contentHash: string;
}

async function fetchManaged(wire: WireConfig): Promise<{ ok: true; entries: ManagedEntry[] } | { ok: false }> {
  let response: Response;
  try {
    response = await requestWithDeadline(
      apiUrl(wire.baseUrl, "/v1/skills?scope=managed"),
      "GET",
      wire.headers,
      undefined,
      wire.timeoutMs,
    );
  } catch {
    return { ok: false };
  }
  if (!response.ok) return { ok: false };
  const capped = await readCappedText(response, MAX_RESPONSE_BYTES);
  if (!capped.ok) return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(capped.text);
  } catch {
    return { ok: false };
  }
  const record = asRecord(parsed);
  const data = record && Array.isArray(record.data) ? (record.data as unknown[]) : null;
  if (!data || data.length > MAX_ENTRIES) return { ok: false };

  const entries: ManagedEntry[] = [];
  for (const raw of data) {
    const item = asRecord(raw);
    const name = item && typeof item.name === "string" ? item.name.trim() : "";
    const contentHash = item && typeof item.contentHash === "string" ? item.contentHash : "";
    // Name must be interpolation-safe BEFORE it can ever reach a DELETE
    // path; contentHash must be well-shaped when present.
    if (!name || !SKILL_ID_RE.test(name)) return { ok: false };
    if (contentHash && !/^sha256:[0-9a-f]{64}$/.test(contentHash)) return { ok: false };
    entries.push({ name, contentHash });
  }
  return { ok: true, entries };
}

type PostOutcome =
  | { kind: "ack"; status: 201 | 200 }
  | { kind: "fail_fast"; token: "wrong_scope" | "auth_error" }
  | { kind: "failed"; code: string };

async function postActivation(
  wire: WireConfig,
  name: string,
  versionId: string,
  contentHash: string,
  content: string,
  idempotencyKey: string,
): Promise<PostOutcome> {
  const body = JSON.stringify({
    contractVersion: "1",
    idempotencyKey,
    skill: { skillId: name, version: versionId, contentHash, content },
  });
  const headers = { ...wire.headers, "content-type": "application/json" };
  let response: Response;
  try {
    response = await requestWithDeadline(
      apiUrl(wire.baseUrl, "/v1/skills/activations"),
      "POST",
      headers,
      body,
      wire.timeoutMs,
    );
  } catch {
    return { kind: "failed", code: "transient_error" };
  }

  if (response.status === 403) return { kind: "fail_fast", token: "wrong_scope" };
  if (response.status === 401) return { kind: "fail_fast", token: "auth_error" };

  if (response.status === 201 || response.status === 200) {
    const capped = await readCappedText(response, MAX_RESPONSE_BYTES);
    if (!capped.ok) return { kind: "failed", code: "bad_ack" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(capped.text);
    } catch {
      return { kind: "failed", code: "bad_ack" };
    }
    const record = asRecord(parsed);
    const ack = record ? asRecord(record.ack) : null;
    if (!ack || ack.skillId !== name) return { kind: "failed", code: "bad_ack" };
    return { kind: "ack", status: response.status as 201 | 200 };
  }

  const capped = await readCappedText(response, MAX_RESPONSE_BYTES);
  let code = String(response.status);
  if (capped.ok) {
    try {
      const record = asRecord(JSON.parse(capped.text));
      const err = record ? asRecord(record.error) : null;
      if (err && typeof err.code === "string") code = err.code;
    } catch {
      // keep the numeric status as the code
    }
  }
  return { kind: "failed", code };
}

async function deleteClean(wire: WireConfig, name: string): Promise<boolean> {
  try {
    const response = await requestWithDeadline(
      apiUrl(wire.baseUrl, `/v1/skills/activations/${encodeURIComponent(name)}?mode=clean`),
      "DELETE",
      wire.headers,
      undefined,
      wire.timeoutMs,
    );
    return response.status === 200 || response.status === 404;
  } catch {
    return false;
  }
}

interface Resolved {
  name: string;
  versionId: string | null;
  contentHash: string | null;
  content: string | null;
  terminal: string | null;
}

interface Outcome {
  state: AdapterSkillState;
  detail: string;
  managed: boolean;
  readOnly?: true;
}

function legacyUnsupportedSnapshot(desiredSkills: string[]): AdapterSkillSnapshot {
  return {
    adapterType: ADAPTER_TYPE,
    supported: LEGACY_UNSUPPORTED_RESPONSE.supported,
    mode: LEGACY_UNSUPPORTED_RESPONSE.mode,
    desiredSkills: [...desiredSkills],
    entries: [...LEGACY_UNSUPPORTED_RESPONSE.entries],
    warnings: [LEGACY_UNSUPPORTED_RESPONSE.warning],
  };
}

function resolveDesired(names: string[], bundles: Record<string, unknown> | null): Resolved[] {
  return names.map((name) => {
    if (!SKILL_ID_RE.test(name)) {
      return { name, versionId: null, contentHash: null, content: null, terminal: "failed:invalid_skill_id" };
    }
    const bundle = bundles ? bundles[name] : undefined;
    if (!isValidBundle(bundle)) {
      return { name, versionId: null, contentHash: null, content: null, terminal: "failed:no_bundle" };
    }
    const hash = `sha256:${createHash("sha256").update(bundle.content, "utf8").digest("hex")}`;
    return { name, versionId: bundle.version, contentHash: hash, content: bundle.content, terminal: null };
  });
}

/** Plans each resolved desired skill against native/managed sets. Returns
 * the initial per-name outcomes plus the subset needing an activation POST
 * and the "kind" (fresh activate vs stale refresh) for detail-token choice. */
function planTransitions(
  resolved: Resolved[],
  trueNativeNames: Set<string>,
  managedMap: Map<string, ManagedEntry>,
): { outcomes: Map<string, Outcome>; activations: Array<{ r: Resolved; kind: "activate" | "refresh" }> } {
  const outcomes = new Map<string, Outcome>();
  const activations: Array<{ r: Resolved; kind: "activate" | "refresh" }> = [];

  for (const r of resolved) {
    if (r.terminal) {
      outcomes.set(r.name, { state: "missing", detail: r.terminal, managed: false });
      continue;
    }
    if (trueNativeNames.has(r.name)) {
      outcomes.set(r.name, { state: "external", detail: "native_conflict", managed: false, readOnly: true });
      continue;
    }
    const managedEntry = managedMap.get(r.name);
    if (managedEntry && managedEntry.contentHash === r.contentHash) {
      outcomes.set(r.name, { state: "installed", detail: "already_installed", managed: true });
      continue;
    }
    activations.push({ r, kind: managedEntry ? "refresh" : "activate" });
  }

  return { outcomes, activations };
}

function idempotencyKeyFor(name: string, contentHash: string): string {
  return `sync-${name}-${contentHash.slice("sha256:".length)}`;
}

/** Executes activations sequentially, fail-fast on 401/403 (LD-1): the
 * failing skill is marked `failed:<token>`, every remaining planned
 * mutation (activations AND cleans) is marked `skipped_after_<token>`, and
 * no further wire calls are made. Returns which names actually received a
 * 200-replay ack (for LD-8's bounded recovery) and whether any wire call
 * was attempted at all (observed-refetch gate). */
async function executeActivations(
  wire: WireConfig,
  activations: Array<{ r: Resolved; kind: "activate" | "refresh" }>,
  outcomes: Map<string, Outcome>,
): Promise<{ acked: Map<string, 201 | 200>; fastFailToken: "wrong_scope" | "auth_error" | null; attempted: boolean }> {
  const acked = new Map<string, 201 | 200>();
  let fastFailToken: "wrong_scope" | "auth_error" | null = null;
  let attempted = false;

  for (const { r, kind } of activations) {
    if (fastFailToken) {
      outcomes.set(r.name, {
        state: kind === "refresh" ? "stale" : "missing",
        detail: `skipped_after_${fastFailToken}`,
        managed: kind === "refresh",
      });
      continue;
    }
    attempted = true;
    const key = idempotencyKeyFor(r.name, r.contentHash as string);
    const result = await postActivation(wire, r.name, r.versionId as string, r.contentHash as string, r.content as string, key);
    if (result.kind === "fail_fast") {
      fastFailToken = result.token;
      outcomes.set(r.name, { state: kind === "refresh" ? "stale" : "missing", detail: `failed:${result.token}`, managed: false });
      continue;
    }
    if (result.kind === "ack") {
      acked.set(r.name, result.status);
      outcomes.set(r.name, {
        state: "installed",
        detail: kind === "refresh" ? "stale_refreshed" : "activated",
        managed: true,
      });
      continue;
    }
    outcomes.set(r.name, { state: kind === "refresh" ? "stale" : "missing", detail: `failed:${result.code}`, managed: false });
  }

  return { acked, fastFailToken, attempted };
}

/** Executes clean DELETEs for managed-not-desired orphans. Skips entirely
 * (with a distinct skipped warning) once a fail-fast token is already set. */
async function executeCleans(
  wire: WireConfig,
  cleanNames: string[],
  fastFailToken: "wrong_scope" | "auth_error" | null,
): Promise<{ cleaned: string[]; failed: string[]; skipped: string[]; attempted: boolean }> {
  const cleaned: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  let attempted = false;

  for (const name of cleanNames) {
    if (fastFailToken) {
      skipped.push(name);
      continue;
    }
    attempted = true;
    const ok = await deleteClean(wire, name);
    if (ok) cleaned.push(name);
    else failed.push(name);
  }

  return { cleaned, failed, skipped, attempted };
}

/** LD-8 bounded replay-miss recovery: for each 200-replay ack not found in
 * the observed re-fetch, retry exactly once with a fresh-nonce key, then
 * fold in ONE final shared re-fetch. 201 (fresh) acks never trigger this. */
async function recoverReplayMisses(
  wire: WireConfig,
  acked: Map<string, 201 | 200>,
  resolvedByName: Map<string, Resolved>,
  observedAfterFirst: Map<string, ManagedEntry>,
  outcomes: Map<string, Outcome>,
): Promise<void> {
  const needsRecovery: string[] = [];
  for (const [name, status] of acked) {
    if (status !== 200) continue;
    const observed = observedAfterFirst.get(name);
    const r = resolvedByName.get(name);
    if (observed && r && observed.contentHash === r.contentHash) continue;
    needsRecovery.push(name);
  }
  if (needsRecovery.length === 0) return;

  for (const name of needsRecovery) {
    const r = resolvedByName.get(name);
    if (!r) continue;
    const retryKey = `${idempotencyKeyFor(name, r.contentHash as string)}-r${randomBytes(4).toString("hex")}`;
    await postActivation(wire, r.name, r.versionId as string, r.contentHash as string, r.content as string, retryKey);
  }

  const finalFetch = await fetchManaged(wire);
  const finalMap = finalFetch.ok ? new Map(finalFetch.entries.map((e) => [e.name, e])) : new Map<string, ManagedEntry>();
  for (const name of needsRecovery) {
    const r = resolvedByName.get(name);
    const observed = finalMap.get(name);
    if (r && observed && observed.contentHash === r.contentHash) continue; // already installed, detail stands
    const current = outcomes.get(name);
    outcomes.set(name, { state: current?.state === "stale" ? "stale" : "missing", detail: "activated_not_observed", managed: false });
  }
}

/** Finalizes acked-but-not-yet-recovered entries against a single observed
 * re-fetch (LD-2 §step 6). Entries observed with a matching hash keep their
 * tentative `activated`/`stale_refreshed` detail; everything else becomes
 * `activated_not_observed` (or the whole acked set does, if the refetch
 * itself failed). */
function finalizeObserved(
  acked: Map<string, 201 | 200>,
  observed: { ok: true; entries: ManagedEntry[] } | { ok: false },
  resolvedByName: Map<string, Resolved>,
  outcomes: Map<string, Outcome>,
): Map<string, ManagedEntry> {
  if (!observed.ok) {
    for (const name of acked.keys()) {
      outcomes.set(name, { state: "missing", detail: "activated_not_observed", managed: false });
    }
    return new Map();
  }
  const observedMap = new Map(observed.entries.map((e) => [e.name, e]));
  for (const name of acked.keys()) {
    const r = resolvedByName.get(name);
    const entry = observedMap.get(name);
    if (entry && r && entry.contentHash === r.contentHash) continue; // installed, detail stands
    if (entry) {
      outcomes.set(name, { state: "stale", detail: "activated_not_observed", managed: false });
      continue;
    }
    // absent: 201 (fresh) acks are final immediately; 200 (replay) acks are
    // resolved by recoverReplayMisses afterward.
    if (acked.get(name) === 201) {
      outcomes.set(name, { state: "missing", detail: "activated_not_observed", managed: false });
    }
  }
  return observedMap;
}

function buildWarnings(names: string[], outcomes: Map<string, Outcome>, cleaned: string[], cleanFailed: string[], cleanSkipped: string[], skipToken: "wrong_scope" | "auth_error" | null): string[] {
  const warnings: string[] = [];
  const cleanOutcomes: Array<[string, string]> = [
    ...cleaned.map((n): [string, string] => [n, "cleaned"]),
    ...cleanFailed.map((n): [string, string] => [n, "clean_failed"]),
    ...cleanSkipped.map((n): [string, string] => [n, `skipped_after_${skipToken ?? "unknown"}`]),
  ];
  for (const name of names) {
    const outcome = outcomes.get(name);
    if (!outcome) continue;
    if (outcome.detail === "already_installed" || outcome.detail === "activated" || outcome.detail === "stale_refreshed") {
      continue;
    }
    warnings.push(`reconcile:${name}:${outcome.detail}`);
  }
  for (const [name, token] of cleanOutcomes) {
    warnings.push(`reconcile:${name}:${token}`);
  }
  return warnings;
}

function dedupeSorted(desiredSkills: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const name of desiredSkills) {
    if (!seen.has(name)) {
      seen.add(name);
      ordered.push(name);
    }
  }
  return [...ordered].sort();
}

function buildSnapshot(
  desiredSkills: string[],
  names: string[],
  resolvedByName: Map<string, Resolved>,
  entries: AdapterSkillEntry[],
  warnings: string[],
): AdapterSkillSnapshot {
  return {
    adapterType: ADAPTER_TYPE,
    supported: true,
    mode: "persistent",
    desiredSkills: [...desiredSkills],
    desiredSkillEntries: names.map((name) => ({ key: name, versionId: resolvedByName.get(name)!.versionId })),
    entries,
    warnings,
  };
}

/** Fail-closed snapshot for a managed-GET that never happened / never
 * succeeded — every desired entry is marked unavailable, zero mutations. */
function managedUnavailableSnapshot(
  desiredSkills: string[],
  names: string[],
  resolvedByName: Map<string, Resolved>,
): AdapterSkillSnapshot {
  const entries = names.map((name) =>
    makeEntry(name, resolvedByName.get(name)!, {
      state: "missing",
      detail: "failed:managed_inventory_unavailable",
      managed: false,
    }),
  );
  return buildSnapshot(desiredSkills, names, resolvedByName, entries, ["reconcile:managed_inventory_unavailable"]);
}

/**
 * Deterministic desired->activated->observed reconcile (Layer 2). Negotiates
 * FIRST; when activation is not negotiated, returns the byte-frozen
 * unsupported literal exactly as Layer 1 (zero activation calls, Phase-1
 * regression preserved). Otherwise executes the full reconcile against the
 * real Layer-2 wire (managed GET / activation POST / clean DELETE) and
 * projects truthful per-skill outcomes onto AdapterSkillSnapshot (LD-6) —
 * never an invented report type. Never throws: every remote/validation
 * failure maps to a per-skill outcome token or a fail-closed snapshot.
 */
export async function syncSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const negotiation = await negotiateCapability(ctx.config);
  const { capability, inventory } = negotiation;

  if (capability.negotiationOutcome !== "negotiated" || !capability.activationSupported || inventory === null) {
    return legacyUnsupportedSnapshot(desiredSkills);
  }

  const names = dedupeSorted(desiredSkills);
  if (names.length > MAX_ENTRIES) {
    return buildSnapshot(desiredSkills, [], new Map(), [], ["reconcile:too_many_desired_skills"]);
  }

  const wire = resolveWireConfig(ctx.config);
  const bundles = asRecord(ctx.config.desiredSkillBundles);
  const resolved = resolveDesired(names, bundles);
  const resolvedByName = new Map(resolved.map((r) => [r.name, r]));

  if (!wire) {
    return managedUnavailableSnapshot(desiredSkills, names, resolvedByName);
  }
  const managedResult = await fetchManaged(wire);
  if (!managedResult.ok) {
    return managedUnavailableSnapshot(desiredSkills, names, resolvedByName);
  }

  const managedMap = new Map(managedResult.entries.map((e) => [e.name, e]));
  const trueNativeNames = new Set([...inventoryNames(inventory)].filter((n) => !managedMap.has(n)));
  const desiredNameSet = new Set(names);

  const { outcomes, activations } = planTransitions(resolved, trueNativeNames, managedMap);
  const cleanNames = [...managedMap.keys()].filter((n) => !desiredNameSet.has(n));

  const { acked, fastFailToken, attempted: activationsAttempted } = await executeActivations(wire, activations, outcomes);
  const { cleaned, failed: cleanFailed, skipped: cleanSkipped, attempted: cleansAttempted } = await executeCleans(
    wire,
    cleanNames,
    fastFailToken,
  );

  if (activationsAttempted || cleansAttempted) {
    const observedResult = await fetchManaged(wire);
    const observedMap = finalizeObserved(acked, observedResult, resolvedByName, outcomes);
    await recoverReplayMisses(wire, acked, resolvedByName, observedMap, outcomes);
  }

  const entries = names.map((name) => makeEntry(name, resolvedByName.get(name)!, outcomes.get(name)!));
  const warnings = buildWarnings(names, outcomes, cleaned, cleanFailed, cleanSkipped, fastFailToken);
  return buildSnapshot(desiredSkills, names, resolvedByName, entries, warnings);
}

function makeEntry(name: string, resolved: Resolved, outcome: Outcome): AdapterSkillEntry {
  const entry: AdapterSkillEntry = {
    key: name,
    runtimeName: name,
    desired: true,
    managed: outcome.managed,
    state: outcome.state,
    detail: outcome.detail,
    versionId: resolved.versionId,
  };
  if (outcome.readOnly) {
    entry.readOnly = true;
    entry.origin = "external_unknown";
    entry.originLabel = "remote-native";
  } else if (outcome.managed) {
    entry.origin = "company_managed";
  }
  return entry;
}
