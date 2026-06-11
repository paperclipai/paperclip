import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./manifest.js";
import {
  buildAccountRows,
  tierCacheAge,
  type ProfilesSnapshot,
  type RateLimitState,
  type TierCacheSnapshot,
} from "./state-snapshot.js";
import type {
  CcrotateTarget,
  PersistedSnapshot,
  SnapshotResponse,
} from "./types.js";

let ctxRef: PluginContext | null = null;
function logger() {
  return ctxRef?.logger;
}

const SNAPSHOT_KEY = "snapshot";
const SNAPSHOT_NAMESPACE = "ccrotate";
const SNAPSHOT_STREAM_CHANNEL = "snapshot";

const TARGETS: CcrotateTarget[] = ["claude", "codex"];

// State-server base. Reachable inside the cluster via the
// ccrotate-auth-bot-state Service in the paperclip namespace; paperclip-0 gets
// ingress access via a dedicated NetworkPolicy rule in onprem-k8s. The env
// override exists for the dev-server harness and for any future migration
// (e.g. routing through paperclip-public-tools auth-proxy).
const STATE_BASE_URL = (
  process.env.CCROTATE_STATE_URL ??
  "http://ccrotate-auth-bot-state.paperclip.svc:4002"
).replace(/\/+$/, "");
const STATE_SSE_URL =
  (process.env.CCROTATE_STATE_SSE_URL ?? STATE_BASE_URL).replace(/\/+$/, "");
const STATE_TOKEN = process.env.CCROTATE_STATE_TOKEN || null;

const CCROTATE_SERVE_BASE_URL = (
  process.env.CCROTATE_SERVE_BASE_URL ??
  process.env.CCROTATE_SERVE_URL ??
  (process.env.CCROTATE_SERVE_SERVICE_HOST && process.env.CCROTATE_SERVE_SERVICE_PORT_SERVE
    ? `http://${process.env.CCROTATE_SERVE_SERVICE_HOST}:${process.env.CCROTATE_SERVE_SERVICE_PORT_SERVE}`
    : "http://ccrotate-serve.paperclip.svc:4001")
).replace(/\/+$/, "");
const CCROTATE_SERVE_TOKEN = process.env.CCROTATE_SERVE_TOKEN || null;

// Reconnect cadence — start fast, back off exponentially up to 30s. We never
// stop retrying as long as the worker is alive; the state-server is in the
// same namespace, so prolonged outages indicate a paperclip control-plane
// issue worth visibly recovering from.
const SSE_RECONNECT_MIN_MS = 1_000;
const SSE_RECONNECT_MAX_MS = 30_000;

// Background snapshot fan-out task. Lives once per worker; aborts on shutdown.
let snapshotStreamAbort: AbortController | null = null;

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function requestHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...extra,
    ...(STATE_TOKEN ? { authorization: `Bearer ${STATE_TOKEN}` } : {}),
  };
}

async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const { timeoutMs = 10_000, ...fetchInit } = init;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...fetchInit, signal: controller.signal });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      const message =
        typeof body === "object" && body && "error" in body
          ? JSON.stringify((body as { error: unknown }).error).slice(0, 300)
          : String(body || `HTTP ${res.status}`).slice(0, 300);
      throw new Error(`${res.status} ${message}`);
    }
    return (body ?? {}) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function stateGet<T>(path: string): Promise<T> {
  return fetchJson<T>(`${STATE_BASE_URL}${path}`, {
    method: "GET",
    headers: requestHeaders({ accept: "application/json" }),
  });
}

async function statePost<T>(path: string, body: unknown, timeoutMs = 30_000): Promise<T> {
  return fetchJson<T>(`${STATE_BASE_URL}${path}`, {
    method: "POST",
    timeoutMs,
    headers: requestHeaders({
      accept: "application/json",
      "content-type": "application/json",
    }),
    body: JSON.stringify(body),
  });
}

function serveHeaders(): Record<string, string> {
  if (!CCROTATE_SERVE_TOKEN) {
    throw new Error("CCROTATE_SERVE_TOKEN is not configured for ccrotate-serve probe operations");
  }
  return {
    authorization: `Bearer ${CCROTATE_SERVE_TOKEN}`,
    "content-type": "application/json",
    accept: "application/json",
  };
}

async function probeOne(
  target: CcrotateTarget,
  email: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return fetchJson<Record<string, unknown>>(`${CCROTATE_SERVE_BASE_URL}/v1/internal/probe-one`, {
    method: "POST",
    timeoutMs,
    headers: serveHeaders(),
    body: JSON.stringify({ target, email }),
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function targetQuery(target: CcrotateTarget): string {
  return target === "codex" ? "?target=codex" : "";
}

// ─── Route handlers ──────────────────────────────────────────────────────────

async function handleSnapshot(): Promise<PluginApiResponse> {
  const fetchedAt = new Date().toISOString();
  const targets: SnapshotResponse["targets"] = {
    claude: {},
    codex: {},
  };
  let cacheAge: string | null = null;

  const [current, rateLimitState] = await Promise.all([
    stateGet<{ email?: string | null }>("/state/current").catch(() => ({ email: null })),
    stateGet<RateLimitState>("/state/rate-limits").catch(() => ({})),
  ]);

  await Promise.all(
    TARGETS.map(async (target) => {
      try {
        const [profiles, tierCache] = await Promise.all([
          stateGet<ProfilesSnapshot>(`/state/profiles${targetQuery(target)}`),
          stateGet<TierCacheSnapshot>(`/state/tier-cache${targetQuery(target)}`),
        ]);
        targets[target] = {
          accounts: buildAccountRows({
            target,
            profiles,
            tierCache,
            rateLimitState,
            activeEmail: current.email ?? null,
          }),
        };
        const age = tierCacheAge(tierCache.updatedAt);
        if (age && !cacheAge) cacheAge = age;
      } catch (error) {
        targets[target] = { error: describeError(error) };
      }
    }),
  );

  const body: SnapshotResponse = { fetchedAt, cacheAge, targets };
  return { status: 200, body };
}

async function handleRefresh(): Promise<PluginApiResponse> {
  // Full per-account refresh uses ccrotate-serve's state-store-backed
  // /v1/internal/probe-one path. Do not shell out to a local `ccrotate`
  // binary here: in production that can resolve to the legacy
  // /paperclip/.ccrotate shim and diverge from canonical state.
  if (!CCROTATE_SERVE_TOKEN) {
    return {
      status: 503,
      body: {
        ok: false,
        error: "CCROTATE_SERVE_TOKEN is not configured; refresh cannot run without ccrotate-serve",
      },
    };
  }
  const errors: { target: CcrotateTarget; error: string }[] = [];
  const probed: Record<CcrotateTarget, number> = { claude: 0, codex: 0 };
  const delayMs = Math.max(0, Number(process.env.CCROTATE_PLUGIN_REFRESH_INTER_PROBE_DELAY_MS ?? 2000));
  for (const target of TARGETS) {
    let profiles: ProfilesSnapshot;
    try {
      profiles = await stateGet<ProfilesSnapshot>(`/state/profiles${targetQuery(target)}`);
    } catch (error) {
      errors.push({
        target,
        error: `profiles read failed: ${describeError(error)}`,
      });
      continue;
    }
    const emails = Object.keys(profiles || {});
    for (let index = 0; index < emails.length; index += 1) {
      if (index > 0 && delayMs > 0) await sleep(delayMs);
      const email = emails[index]!;
      try {
        await probeOne(target, email, 60_000);
        probed[target] += 1;
      } catch (error) {
        errors.push({ target, error: `${email}: ${describeError(error)}` });
      }
    }
  }
  if (probed.claude + probed.codex === 0) {
    return {
      status: 502,
      body: { ok: false, errors },
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      probed,
      errors: errors.length > 0 ? errors : undefined,
    },
  };
}

async function handleSwitch(input: PluginApiRequestInput): Promise<PluginApiResponse> {
  // Switch the active pointer through the canonical state-server. This replaces
  // the old local `ccrotate switch` fallback, which could write only the stale
  // in-pod /paperclip/.ccrotate files.
  const body = (input.body ?? {}) as { email?: unknown; target?: unknown };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const target = typeof body.target === "string" ? body.target.trim() : "claude";
  if (!email || !email.includes("@")) {
    return { status: 400, body: { error: "email (with @) required" } };
  }
  if (target !== "claude" && target !== "codex") {
    return { status: 400, body: { error: "target must be 'claude' or 'codex'" } };
  }
  const profiles = await stateGet<ProfilesSnapshot>(`/state/profiles${targetQuery(target)}`);
  if (!profiles[email]) {
    return { status: 404, body: { ok: false, error: `${email} is not in the ${target} pool` } };
  }
  await statePost("/state/current", { email }, 15_000);
  return {
    status: 200,
    body: {
      ok: true,
      email,
      target,
    },
  };
}

async function handleSetSession(input: PluginApiRequestInput): Promise<PluginApiResponse> {
  // Operator-supplied sessionKey paste. Proxies to the auth-bot's
  // /setSession, then chains the Claude email-magic relogin path. The
  // saved sessionKey remains useful as auth-bot state, but stale Claude
  // accounts now recover more reliably via /reloginViaEmailMagicAuto
  // than by replaying the pasted sessionKey through /reloginViaSession.
  //
  // Auth-bot is reachable via the cluster Service `ccrotate-auth-bot:7000`
  // (paperclip-0 runs in-namespace). For local-dev this would 404 quietly —
  // not a primary devbox surface.
  const body = (input.body ?? {}) as { email?: unknown; sessionKey?: unknown; target?: unknown };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";
  const target = typeof body.target === "string" ? body.target.trim() : "claude";
  if (!email || !email.includes("@")) {
    return { status: 400, body: { error: "email (with @) required" } };
  }
  if (!sessionKey || !sessionKey.startsWith("sk-ant-") || sessionKey.length < 40) {
    return {
      status: 400,
      body: { error: "sessionKey shape check failed — expected `sk-ant-sid01-...` (≥40 chars)" },
    };
  }
  if (target !== "claude") {
    return { status: 400, body: { error: "target must be 'claude' (codex uses different auth)" } };
  }
  const botBase = process.env.CCROTATE_AUTH_BOT_URL ?? "http://ccrotate-auth-bot.paperclip.svc:7000";
  // Step 1: persist sessionKey
  let setRes: Response;
  try {
    setRes = await fetch(`${botBase}/setSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, target, sessionKey }),
    });
  } catch (e) {
    return { status: 502, body: { error: `auth-bot unreachable: ${describeError(e)}` } };
  }
  if (!setRes.ok) {
    const text = await setRes.text().catch(() => "");
    return { status: setRes.status, body: { error: `bot /setSession returned ${setRes.status}: ${text.slice(0, 300)}` } };
  }
  // Step 2: chain relogin (~30-120s)
  const reloginEndpoint = "/reloginViaEmailMagicAuto";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let loginRes: Response;
  try {
    loginRes = await fetch(`${botBase}${reloginEndpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, target }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return {
      status: 502,
      body: {
        ok: false,
        sessionKeyPersisted: true,
        error: `sessionKey saved but ${reloginEndpoint} failed: ${describeError(e)}. Stale-poller will retry.`,
      },
    };
  }
  clearTimeout(timer);
  const loginBody = (await loginRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (loginRes.status === 409 && loginBody?.code === "SESSIONKEY_IDENTITY_MISMATCH") {
    return {
      status: 409,
      body: {
        ok: false,
        sessionKeyPersisted: true,
        code: "SESSIONKEY_IDENTITY_MISMATCH",
        requestedEmail: loginBody.requestedEmail,
        snappedEmail: loginBody.snappedEmail,
        error: `sessionKey identity mismatch — the key actually belongs to ${loginBody.snappedEmail}. Tokens were written to ${loginBody.snappedEmail}'s profile.`,
      },
    };
  }
  if (!loginRes.ok) {
    return {
      status: loginRes.status,
      body: {
        ok: false,
        sessionKeyPersisted: true,
        error: `bot ${reloginEndpoint} returned ${loginRes.status}: ${String(loginBody?.error || "").slice(0, 300)}`,
      },
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      email,
      snapStdout: loginBody?.snapStdout,
    },
  };
}


async function handleCodexRelogin(input: PluginApiRequestInput): Promise<PluginApiResponse> {
  const body = (input.body ?? {}) as { email?: unknown };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email || !email.includes("@")) return { status: 400, body: { error: "email (with @) required" } };
  const botBase = process.env.CCROTATE_AUTH_BOT_URL ?? "http://ccrotate-auth-bot.paperclip.svc:7000";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  let reloginRes: Response;
  try {
    reloginRes = await fetch(`${botBase}/relogin`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, target: "codex" }), signal: controller.signal,
    });
  } catch (e) { clearTimeout(timer); return { status: 502, body: { error: `auth-bot unreachable: ${describeError(e)}` } }; }
  clearTimeout(timer);
  const reloginBody = (await reloginRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!reloginRes.ok) return { status: reloginRes.status, body: { ok: false, error: `auth-bot /relogin returned ${reloginRes.status}: ${String(reloginBody?.error || "").slice(0, 300)}` } };
  return { status: 200, body: { ok: true, email, snapStdout: reloginBody?.snapStdout } };
}

async function handleClaudeRelogin(input: PluginApiRequestInput): Promise<PluginApiResponse> {
  const body = (input.body ?? {}) as { email?: unknown };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email || !email.includes("@")) return { status: 400, body: { error: "email (with @) required" } };
  const botBase = process.env.CCROTATE_AUTH_BOT_URL ?? "http://ccrotate-auth-bot.paperclip.svc:7000";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  let reloginRes: Response;
  try {
    reloginRes = await fetch(`${botBase}/reloginViaEmailMagicAuto`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, target: "claude" }), signal: controller.signal,
    });
  } catch (e) { clearTimeout(timer); return { status: 502, body: { error: `auth-bot unreachable: ${describeError(e)}` } }; }
  clearTimeout(timer);
  const reloginBody = (await reloginRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!reloginRes.ok) {
    return {
      status: reloginRes.status,
      body: {
        ok: false,
        error: `auth-bot /reloginViaEmailMagicAuto returned ${reloginRes.status}: ${String(reloginBody?.error || "").slice(0, 300)}`,
        ...(reloginBody?.code ? { code: reloginBody.code } : {}),
        ...(reloginBody?.reason ? { reason: reloginBody.reason } : {}),
        ...(reloginBody?.observedEmail ? { observedEmail: reloginBody.observedEmail } : {}),
      },
    };
  }
  return { status: 200, body: { ok: true, email, snapStdout: reloginBody?.snapStdout } };
}

async function handleBulkClearTiers(input: PluginApiRequestInput): Promise<PluginApiResponse> {
  const body = (input.body ?? {}) as { target?: unknown };
  const target = typeof body.target === "string" ? body.target.trim() : "claude";
  if (target !== "claude" && target !== "codex") {
    return { status: 400, body: { error: "target must be 'claude' or 'codex'" } };
  }
  // This used to mutate ~/.ccrotate/tier-cache*.json directly from the
  // Paperclip worker. That local-file fallback is intentionally removed; the
  // state-server has no generic tier-cache rewrite route, and silently editing
  // a stale pod-local cache is worse than failing closed.
  return {
    status: 410,
    body: {
      ok: false,
      target,
      error: "bulk tier-cache file edits are disabled; use per-row refresh or wait for the freshness loop",
    },
  };
}

async function handleRefreshOne(input: PluginApiRequestInput): Promise<PluginApiResponse> {
  // Force a single-account re-probe through ccrotate-serve. No local
  // `ccrotate refresh-one` fallback: production's local command may be the
  // legacy /paperclip/.ccrotate shim and would not update canonical state.
  const body = (input.body ?? {}) as { email?: unknown; target?: unknown };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const target = typeof body.target === "string" ? body.target.trim() : "claude";
  if (!email || !email.includes("@")) {
    return { status: 400, body: { error: "email (with @) required" } };
  }
  if (target !== "claude" && target !== "codex") {
    return { status: 400, body: { error: "target must be 'claude' or 'codex'" } };
  }
  const result = await probeOne(target, email, 60_000);
  const output = JSON.stringify({
    status: result.status ?? null,
    serviceTier: result.serviceTier ?? null,
    response: result.response ?? null,
  });
  return {
    status: 200,
    body: { ok: true, email, target, output },
  };
}

async function handleImport(input: PluginApiRequestInput): Promise<PluginApiResponse> {
  if (!ctxRef) return { status: 503, body: { error: "plugin not initialized" } };
  const body = (input.body ?? {}) as { blob?: unknown };
  const blob = typeof body.blob === "string" ? body.blob.trim() : "";
  if (!blob.startsWith("mp-gz-b64:")) {
    return {
      status: 400,
      body: { error: "expected JSON body { blob: string starting with 'mp-gz-b64:' }" },
    };
  }
  const importResult = await statePost<Record<string, unknown>>("/state/import", { data: blob }, 60_000);

  // Persist the imported blob to plugin_state so the next Job pod's preRun hook
  // can re-import the same canonical state if that hook is enabled.
  const value: PersistedSnapshot = { blob, capturedAt: new Date().toISOString() };
  await ctxRef.state.set(
    {
      scopeKind: "instance",
      namespace: SNAPSHOT_NAMESPACE,
      stateKey: SNAPSHOT_KEY,
    },
    value,
  );
  return { status: 200, body: { ok: true, imported: importResult, capturedAt: value.capturedAt } };
}

async function handleStateGet(_input: PluginApiRequestInput): Promise<PluginApiResponse> {
  if (!ctxRef) return { status: 503, body: { error: "plugin not initialized" } };
  const value = await ctxRef.state.get({
    scopeKind: "instance",
    namespace: SNAPSHOT_NAMESPACE,
    stateKey: SNAPSHOT_KEY,
  });
  return { status: 200, body: { snapshot: (value as PersistedSnapshot | null) ?? null } };
}

async function handleStatePut(input: PluginApiRequestInput): Promise<PluginApiResponse> {
  if (!ctxRef) return { status: 503, body: { error: "plugin not initialized" } };
  const body = (input.body ?? {}) as { blob?: unknown };
  const blob = typeof body.blob === "string" ? body.blob : null;
  if (!blob) {
    return { status: 400, body: { error: "expected JSON body { blob: string }" } };
  }
  const value: PersistedSnapshot = { blob, capturedAt: new Date().toISOString() };
  await ctxRef.state.set(
    {
      scopeKind: "instance",
      namespace: SNAPSHOT_NAMESPACE,
      stateKey: SNAPSHOT_KEY,
    },
    value,
  );
  return { status: 200, body: { snapshot: value } };
}

// ─── SSE subscription to ccrotate-auth-bot state-server ─────────────────────
//
// On every state-server mutation event, refresh the snapshot and push it to
// any UI clients via ctx.streams.emit. The UI hook (usePluginStream) gets a
// real-time view of pool state without polling. Disconnect handling: retry
// with capped exponential backoff; on visible error, log and continue. The
// snapshot also fans out on initial connect ("connected" SSE event) so a UI
// that subscribes after the worker started still gets a current view.

// Debounce snapshot emission. A single state-server route call can lead to
// several broadcasts in close succession (e.g. an `applyImport` rewrites
// multiple files; freshness-loop probes a batch of accounts during recovery).
// We coalesce into one ctx.streams.emit per quiet window so the UI gets one
// re-render per logical mutation burst, not N.
const SNAPSHOT_EMIT_DEBOUNCE_MS = 200;
let pendingEmitReasons = new Set<string>();
let pendingEmitTimer: NodeJS.Timeout | null = null;

async function flushSnapshotEmit(): Promise<void> {
  pendingEmitTimer = null;
  const reasons = Array.from(pendingEmitReasons);
  pendingEmitReasons.clear();
  if (reasons.length === 0) return;
  const ctx = ctxRef;
  if (!ctx) return;
  try {
    const result = await handleSnapshot();
    if (result.status === 200 && result.body) {
      ctx.streams.emit(SNAPSHOT_STREAM_CHANNEL, {
        reason: reasons.length === 1 ? reasons[0] : `batch:${reasons.join(",")}`,
        snapshot: result.body,
      });
    }
  } catch (error) {
    logger()?.debug?.("emitSnapshot failed", { reasons, error: describeError(error) });
  }
}

function emitSnapshot(reason: string): void {
  pendingEmitReasons.add(reason);
  if (pendingEmitTimer) return;
  pendingEmitTimer = setTimeout(() => { void flushSnapshotEmit(); }, SNAPSHOT_EMIT_DEBOUNCE_MS);
}

async function consumeSseStream(
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // SSE blocks are separated by a blank line. Keep partial block in buffer.
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!block || block.startsWith(":")) continue; // comment/keepalive
        const lines = block.split("\n");
        let event = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice("event:".length).trim();
          else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice("data:".length).trim();
        }
        // Any non-comment event is reason enough to refresh the snapshot:
        // the connected event seeds initial UI state, and each subsequent
        // event signals a tier-cache mutation we want to reflect. emitSnapshot
        // is debounced so a burst (e.g. import.applied + token-refreshed) only
        // rebuilds and emits one canonical state-server snapshot downstream.
        emitSnapshot(event || "message");
        // `data` parsing is best-effort — we don't need the payload, just
        // the signal that *something* changed. Keeping the parsed value
        // unused here so future debug logging can pick it up cheaply.
        void data;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

async function snapshotSubscriptionLoop(signal: AbortSignal): Promise<void> {
  let backoffMs = SSE_RECONNECT_MIN_MS;
  while (!signal.aborted) {
    try {
      logger()?.info("ccrotate plugin connecting to state-server SSE", { url: STATE_SSE_URL });
      const response = await fetch(`${STATE_SSE_URL}/state/events`, {
        method: "GET",
        signal,
        headers: requestHeaders({ accept: "text/event-stream" }),
      });
      if (!response.ok) {
        throw new Error(`SSE connect failed: HTTP ${response.status}`);
      }
      backoffMs = SSE_RECONNECT_MIN_MS;
      await consumeSseStream(response, signal);
    } catch (error) {
      if (signal.aborted) return;
      logger()?.warn("ccrotate plugin SSE subscription dropped", {
        error: describeError(error),
        nextRetryMs: backoffMs,
      });
    }
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, backoffMs);
      signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
    backoffMs = Math.min(backoffMs * 2, SSE_RECONNECT_MAX_MS);
  }
}

// ─── Plugin definition ───────────────────────────────────────────────────────

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx) {
    ctxRef = ctx;
    logger()?.info("ccrotate plugin (visualization) ready", {
      pluginId: PLUGIN_ID,
      stateUrl: STATE_BASE_URL,
      sseUrl: STATE_SSE_URL,
      serveUrl: CCROTATE_SERVE_BASE_URL,
      hasStateToken: !!STATE_TOKEN,
      hasServeToken: !!CCROTATE_SERVE_TOKEN,
    });
    // Start the SSE → ctx.streams fan-out loop. Fire-and-forget: the loop
    // owns its own retry/backoff and exits cleanly on abort. setup() must
    // not await it (the loop blocks forever by design).
    if (snapshotStreamAbort) snapshotStreamAbort.abort();
    snapshotStreamAbort = new AbortController();
    void snapshotSubscriptionLoop(snapshotStreamAbort.signal);
  },

  async onHealth() {
    return { status: "ok", message: "ccrotate plugin ready" };
  },

  async onShutdown() {
    if (snapshotStreamAbort) {
      snapshotStreamAbort.abort();
      snapshotStreamAbort = null;
    }
    if (pendingEmitTimer) {
      clearTimeout(pendingEmitTimer);
      pendingEmitTimer = null;
    }
    pendingEmitReasons.clear();
    ctxRef = null;
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    try {
      switch (input.routeKey) {
        case "snapshot":
          return await handleSnapshot();
        case "refresh":
          return await handleRefresh();
        case "state-get":
          return await handleStateGet(input);
        case "state-put":
          return await handleStatePut(input);
        case "import":
          return await handleImport(input);
        case "switch":
          return await handleSwitch(input);
        case "set-session":
          return await handleSetSession(input);
        case "clear-stale-tiers":
          return await handleBulkClearTiers(input);
        case "refresh-one":
          return await handleRefreshOne(input);
        case "codex-relogin":
          return await handleCodexRelogin(input);
        case "claude-relogin":
          return await handleClaudeRelogin(input);
        default:
          return { status: 404, body: { error: `unknown routeKey: ${input.routeKey}` } };
      }
    } catch (error) {
      logger()?.warn("ccrotate api route handler failed", {
        routeKey: input.routeKey,
        error: describeError(error),
      });
      return { status: 500, body: { error: describeError(error) } };
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
