import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./manifest.js";
import { parseWhenOutput } from "./parse.js";
import type {
  AccountRow,
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

// State-server SSE feed. Reachable inside the cluster via the
// ccrotate-auth-bot-state Service in the paperclip namespace; paperclip-0 gets
// ingress access via a dedicated NetworkPolicy rule in onprem-k8s. The env
// override exists for the dev-server harness and for any future migration
// (e.g. routing through paperclip-public-tools auth-proxy).
const STATE_SSE_URL =
  process.env.CCROTATE_STATE_SSE_URL ??
  process.env.CCROTATE_STATE_URL ??
  "http://ccrotate-auth-bot-state.paperclip.svc:4002";

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

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        code,
      });
    });
  });
}

// ccrotate `when` text parser lives in ./parse.ts (pure, unit-tested).

async function runCcrotateWhen(target: CcrotateTarget): Promise<{
  cacheAge: string | null;
  accounts: AccountRow[];
}> {
  // ccrotate accepts `--target` as a global flag before the subcommand.
  const result = await runProcess("ccrotate", ["--target", target, "when"], 30_000);
  if (result.code !== 0 && result.stdout.trim() === "") {
    throw new Error(
      `ccrotate when --target ${target} exited ${result.code}: ${result.stderr.trim() || "(no stderr)"}`,
    );
  }
  return parseWhenOutput(target, result.stdout);
}

// ─── Route handlers ──────────────────────────────────────────────────────────

async function handleSnapshot(): Promise<PluginApiResponse> {
  const fetchedAt = new Date().toISOString();
  const targets: SnapshotResponse["targets"] = {
    claude: {},
    codex: {},
  };
  let cacheAge: string | null = null;

  await Promise.all(
    TARGETS.map(async (target) => {
      try {
        const result = await runCcrotateWhen(target);
        targets[target] = { accounts: result.accounts };
        if (result.cacheAge && !cacheAge) cacheAge = result.cacheAge;
      } catch (error) {
        targets[target] = { error: describeError(error) };
      }
    }),
  );

  const body: SnapshotResponse = { fetchedAt, cacheAge, targets };
  return { status: 200, body };
}

async function handleRefresh(): Promise<PluginApiResponse> {
  // Full per-account refresh — calls Anthropic + Claude/Codex APIs for every
  // saved account and rewrites the on-disk tier-cache.
  //
  // Manually triggered from the UI, so the longer wall-clock vs `refresh-one`
  // is acceptable. ccrotate's refresh handles its own per-account cooldowns
  // and skips accounts already throttled, so consecutive button presses
  // are safe; back-to-back refreshes within the cooldown window will return
  // the same data without an API hit.
  //
  // Run both targets sequentially. ccrotate refresh defaults to the active
  // CCROTATE_TARGET, so we drive each one explicitly.
  const errors: { target: CcrotateTarget; error: string }[] = [];
  for (const target of TARGETS) {
    const result = await runProcess("ccrotate", ["--target", target, "refresh"], 180_000);
    if (result.code !== 0) {
      errors.push({
        target,
        error: result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`,
      });
    }
  }
  // Even if one target failed, return what we got — the snapshot route on
  // the next refetch reads the on-disk cache and will surface partial data.
  // 502 if BOTH targets failed, 200 with errors[] if partial.
  if (errors.length === TARGETS.length) {
    return {
      status: 502,
      body: { ok: false, errors },
    };
  }
  return { status: 200, body: { ok: true, errors: errors.length > 0 ? errors : undefined } };
}

async function handleSwitch(input: PluginApiRequestInput): Promise<PluginApiResponse> {
  // Switch the active account (writes current.json via local `ccrotate switch`).
  // ccrotate-serve picks up the new pointer on its next state read; in HTTP-state
  // mode (the cluster deploy) that state-server lives in the auth-bot pod and
  // the bot reflects writes back on its next freshness tick. In file-state mode
  // the change is immediate.
  const body = (input.body ?? {}) as { email?: unknown; target?: unknown };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const target = typeof body.target === "string" ? body.target.trim() : "claude";
  if (!email || !email.includes("@")) {
    return { status: 400, body: { error: "email (with @) required" } };
  }
  if (target !== "claude" && target !== "codex") {
    return { status: 400, body: { error: "target must be 'claude' or 'codex'" } };
  }
  const result = await runProcess("ccrotate", ["--target", target, "switch", email], 15_000);
  if (result.code !== 0) {
    return {
      status: 502,
      body: {
        ok: false,
        error: result.stderr.trim() || result.stdout.trim() || `ccrotate switch exit ${result.code}`,
      },
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      email,
      target,
      stdout: result.stdout.trim(),
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

function tierCachePathForTarget(target: CcrotateTarget): string {
  // Mirrors ccrotate's own resolution (see lib/ccrotate.js:226-231):
  //   claude → ~/.ccrotate/tier-cache.json
  //   codex  → ~/.ccrotate/tier-cache.codex.json
  // In the paperclip pod HOME=/paperclip, so this resolves to
  // /paperclip/.ccrotate/tier-cache*.json (the shared cephfs volume).
  if (target === "claude") {
    return path.join(os.homedir(), ".ccrotate", "tier-cache.json");
  }
  return path.join(os.homedir(), ".ccrotate", `tier-cache.${target}.json`);
}

async function handleBulkClearTiers(input: PluginApiRequestInput): Promise<PluginApiResponse> {
  // Clear `serviceTier:"extra"` labels on tier-cache so the next freshness
  // probe re-classifies. Motivating use case: kkroo PR #55 ("require positive
  // monthly_limit before labeling tier 'extra'") flipped accounts that had
  // monthly_limit=0 out of the extra tier, but pre-#55 cache entries kept
  // their stale `extra` label until each per-account Usage-API probe ran —
  // which can take hours due to per-token cooldowns.
  //
  // `serviceTier: null` is the canonical "unknown — please re-probe" state
  // per ccrotate/lib/state-helpers.js:250-258. We zero out the tier label and
  // also clear the stored `response` string so the UI doesn't keep showing
  // stale 'extra (...)' text until the re-probe lands.
  //
  // After writing, shell `ccrotate refresh` to trigger the re-probe — same
  // command handleRefresh runs, just scoped to the requested target.
  const body = (input.body ?? {}) as { target?: unknown };
  const target = typeof body.target === "string" ? body.target.trim() : "claude";
  if (target !== "claude" && target !== "codex") {
    return { status: 400, body: { error: "target must be 'claude' or 'codex'" } };
  }
  const tierCacheFile = tierCachePathForTarget(target);
  let raw: string;
  try {
    raw = await fs.readFile(tierCacheFile, "utf-8");
  } catch (e: unknown) {
    return {
      status: 502,
      body: { ok: false, error: `cannot read ${tierCacheFile}: ${describeError(e)}` },
    };
  }
  let cache: { accounts?: Array<Record<string, unknown>>; updatedAt?: string };
  try {
    cache = JSON.parse(raw);
  } catch (e: unknown) {
    return {
      status: 502,
      body: { ok: false, error: `tier-cache JSON parse failed: ${describeError(e)}` },
    };
  }
  if (!Array.isArray(cache.accounts)) {
    return { status: 502, body: { ok: false, error: "tier-cache has no accounts array" } };
  }
  const cleared: string[] = [];
  for (const entry of cache.accounts) {
    if (entry && typeof entry === "object" && entry.serviceTier === "extra") {
      const email = typeof entry.email === "string" ? entry.email : "(unknown)";
      entry.serviceTier = null;
      // Drop the stored response string so the UI/parser doesn't keep showing
      // 'extra (...)' until the re-probe writes a fresh one. Leaving
      // rateLimits intact so the operator still sees the last-known
      // utilization numbers; refresh will overwrite them.
      delete entry.response;
      cleared.push(email);
    }
  }
  if (cleared.length === 0) {
    return { status: 200, body: { ok: true, cleared: 0, emails: [] } };
  }
  cache.updatedAt = new Date().toISOString();
  // Atomic write: tmp + rename, same shape ccrotate's own writers use.
  const tmp = `${tierCacheFile}.tmp.${process.pid}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), "utf-8");
    await fs.rename(tmp, tierCacheFile);
  } catch (e: unknown) {
    return {
      status: 502,
      body: { ok: false, error: `tier-cache write failed: ${describeError(e)}` },
    };
  }
  // Kick a refresh on this target — best-effort. If refresh fails we still
  // report what we cleared; the freshness-loop will eventually re-probe.
  let refreshError: string | null = null;
  try {
    const result = await runProcess("ccrotate", ["--target", target, "refresh"], 30_000);
    if (result.code !== 0) {
      refreshError = result.stderr.trim() || result.stdout.trim() || `ccrotate refresh exit ${result.code}`;
    }
  } catch (e: unknown) {
    refreshError = describeError(e);
  }
  return {
    status: 200,
    body: {
      ok: true,
      cleared: cleared.length,
      emails: cleared,
      ...(refreshError ? { refreshError } : {}),
    },
  };
}

async function handleRefreshOne(input: PluginApiRequestInput): Promise<PluginApiResponse> {
  // Force a single-account re-probe via `ccrotate refresh-one <email>`. The
  // freshness-loop already probes accounts on its own cadence; an explicit
  // operator refresh asks ccrotate to make one live Usage API attempt for this
  // account and report Anthropic cooldown/unavailable errors directly.
  //
  // 60s timeout: refresh-one can take 30-50s on slow accounts (Anthropic
  // Usage-API + Claude/Codex tokens) — covers worst-case without leaving the
  // request hung.
  const body = (input.body ?? {}) as { email?: unknown; target?: unknown };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const target = typeof body.target === "string" ? body.target.trim() : "claude";
  if (!email || !email.includes("@")) {
    return { status: 400, body: { error: "email (with @) required" } };
  }
  if (target !== "claude" && target !== "codex") {
    return { status: 400, body: { error: "target must be 'claude' or 'codex'" } };
  }
  const result = await runProcess(
    "ccrotate",
    ["--target", target, "refresh-one", email],
    60_000,
  );
  if (result.code !== 0) {
    return {
      status: 502,
      body: {
        ok: false,
        error:
          result.stderr.trim() ||
          result.stdout.trim() ||
          `ccrotate refresh-one exit ${result.code}`,
      },
    };
  }
  // Truncate stdout — refresh-one can emit a few lines of probe detail and
  // the UI only needs the tail for confirmation/debug.
  const combined = (result.stdout + result.stderr).trim();
  const output = combined.length > 200 ? `…${combined.slice(-200)}` : combined;
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
  // 1. Run ccrotate import locally on the paperclip pod so the live tier-cache
  //    immediately reflects the imported state (the snapshot route reads
  //    ccrotate's on-disk cache via `ccrotate when`, not the DB blob).
  const importResult = await runProcess("ccrotate", ["import", blob, "--force"], 30_000);
  if (importResult.code !== 0) {
    return {
      status: 502,
      body: {
        ok: false,
        error: importResult.stderr.trim() || importResult.stdout.trim() || `exit ${importResult.code}`,
      },
    };
  }
  // ccrotate import prints e.g. "Import complete: N updated, M kept (local fresher)."
  const summary = (importResult.stdout + importResult.stderr).match(
    /(\d+)\s+updated,\s*(\d+)\s+kept/i,
  );
  const imported = summary
    ? { updated: Number(summary[1]), kept: Number(summary[2]) }
    : undefined;

  // 2. Persist the imported blob to plugin_state so the next Job pod's
  //    preRun hook re-imports the same canonical state.
  const value: PersistedSnapshot = { blob, capturedAt: new Date().toISOString() };
  await ctxRef.state.set(
    {
      scopeKind: "instance",
      namespace: SNAPSHOT_NAMESPACE,
      stateKey: SNAPSHOT_KEY,
    },
    value,
  );
  return { status: 200, body: { ok: true, imported, capturedAt: value.capturedAt } };
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
        // fires one `ccrotate when` invocation downstream.
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
        headers: { accept: "text/event-stream" },
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
      sseUrl: STATE_SSE_URL,
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
