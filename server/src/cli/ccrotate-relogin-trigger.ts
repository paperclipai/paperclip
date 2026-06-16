/**
 * Lifecycle hook helper: when a `provider_quota_exhausted` event fires
 * (signaling an upstream 401 / rate limit on the active ccrotate account
 * after the in-process retry-with-rotation in claude-local execute.ts has
 * failed), notify the in-cluster ccrotate-auth-bot to drive a Camoufox-
 * driven re-login + snap.
 *
 * Wire as instance setting `general.quotaExhaustedCmd`:
 *
 *   node /app/server/dist/cli/ccrotate-relogin-trigger.js
 *
 * Reads env vars set by `runQuotaExhaustedHook`:
 *   PAPERCLIP_AGENT_ID
 *   PAPERCLIP_COMPANY_ID
 *   PAPERCLIP_RUN_ID
 *   PAPERCLIP_ADAPTER_TYPE   — claude_k8s, claude_local, opencode_k8s, codex_local
 *   PAPERCLIP_ERROR_CODE
 *
 * Maps the adapter to the ccrotate target (claude vs codex), looks up the
 * currently-active email from the ccrotate state-server when configured, and
 * fires `POST http://ccrotate-auth-bot.paperclip.svc:7000/reloginViaSession`.
 * The NetworkPolicy on the bot already restricts ingress to paperclip-0,
 * so no auth header is needed.
 *
 * Endpoint choice (/reloginViaSession vs /relogin):
 *   /reloginViaSession  — Camoufox replays a previously-captured sessionKey
 *                         against claude.ai/oauth/authorize and clicks
 *                         through the consent UI; fully automated, ~30-40s.
 *                         Requires the operator to have seeded a sessionKey
 *                         for this email via /setSession at least once.
 *   /relogin            — older email-code flow that returns 202 and waits
 *                         for the operator to POST /submitCode with the
 *                         magic code from their inbox. Doesn't fit an
 *                         automated recovery path; we don't call it.
 *
 * Default request timeout is 60s — long enough for /reloginViaSession's
 * Camoufox launch + click-through + claude CLI exit + ccrotate snap. The
 * agent's recovery path waits for that result so we know whether tokens
 * were actually freshened before the next heartbeat picks the run back up.
 *
 * If the bot returns failure (4xx with no seeded sessionKey, 5xx, error in
 * body, or unreachable) AND `PAPERCLIP_SLACK_ESCALATION_WEBHOOK_URL` is
 * set, post a one-line escalation to Slack so an operator can intervene
 * (run `claude /login` + `ccrotate snap` locally, or POST /setSession to
 * seed a key for future auto-recovery).
 *
 * Always exits 0 — never block the agent's recovery path on a bot or Slack
 * side problem. Failures land in stdout/stderr which `runQuotaExhaustedHook`
 * captures and logs at warn-level.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const BOT_URL = process.env.CCROTATE_AUTH_BOT_URL ?? "http://ccrotate-auth-bot.paperclip.svc:7000";
const REQUEST_TIMEOUT_MS = Number(process.env.CCROTATE_AUTH_BOT_TIMEOUT_MS ?? "60000");
const STATE_TIMEOUT_MS = Number(process.env.CCROTATE_STATE_TIMEOUT_MS ?? "10000");
const SLACK_WEBHOOK_URL = (process.env.PAPERCLIP_SLACK_ESCALATION_WEBHOOK_URL ?? "").trim();
const SLACK_TIMEOUT_MS = Number(process.env.PAPERCLIP_SLACK_ESCALATION_TIMEOUT_MS ?? "5000");
const BACKOFF_PATH = process.env.CCROTATE_RELOGIN_BACKOFF_PATH ?? "/paperclip/.ccrotate/relogin-backoff.json";
const BACKOFF_MS = Number(process.env.CCROTATE_RELOGIN_BACKOFF_MS ?? String(60 * 60 * 1000));

interface BackoffEntry { lastAttemptAt: number; lastStatus: number | "error" }
type BackoffMap = Record<string, BackoffEntry>;

function loadBackoff(): BackoffMap {
  try {
    return JSON.parse(readFileSync(BACKOFF_PATH, "utf8")) as BackoffMap;
  } catch {
    return {};
  }
}

function saveBackoff(map: BackoffMap): void {
  try {
    const dir = dirname(BACKOFF_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(BACKOFF_PATH, JSON.stringify(map), { mode: 0o664 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ccrotate-relogin-trigger] backoff persist failed: ${msg}`);
  }
}

function backoffKey(target: string, email: string): string {
  return `${target}:${email}`;
}

function isOnBackoff(map: BackoffMap, target: string, email: string): { onBackoff: true; remainingMs: number } | { onBackoff: false } {
  const entry = map[backoffKey(target, email)];
  if (!entry) return { onBackoff: false };
  const elapsed = Date.now() - entry.lastAttemptAt;
  if (elapsed >= BACKOFF_MS) return { onBackoff: false };
  return { onBackoff: true, remainingMs: BACKOFF_MS - elapsed };
}

function recordAttempt(map: BackoffMap, target: string, email: string, status: number | "error"): void {
  map[backoffKey(target, email)] = { lastAttemptAt: Date.now(), lastStatus: status };
  saveBackoff(map);
}

function adapterToTarget(adapterType: string): "claude" | "codex" | null {
  if (/(^|_)(claude)(_|$)/.test(adapterType)) return "claude";
  if (/(^|_)(opencode|codex)(_|$)/.test(adapterType)) return "codex";
  return null;
}

function getCcrotateStateUrl(): string | null {
  const raw = process.env.CCROTATE_STATE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

function getCcrotateStateToken(): string | null {
  return (
    process.env.CCROTATE_STATE_TOKEN?.trim()
    || process.env.CCROTATE_SERVE_TOKEN?.trim()
    || null
  );
}

function extractEmail(raw: unknown): string | null {
  return typeof raw === "string" && /@/.test(raw) ? raw.trim() : null;
}

async function readActiveEmailFromStateServer(stateUrl: string): Promise<string | null> {
  const headers = new Headers({ accept: "application/json" });
  const token = getCcrotateStateToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${stateUrl}/state/current`, { headers, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const parsed = text.trim() ? JSON.parse(text) as { email?: unknown } : {};
    return extractEmail(parsed.email);
  } finally {
    clearTimeout(timer);
  }
}

async function readActiveEmail(target: "claude" | "codex"): Promise<string | null> {
  const stateUrl = getCcrotateStateUrl();
  if (stateUrl) {
    try {
      return await readActiveEmailFromStateServer(stateUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ccrotate-relogin-trigger] state-server current lookup failed: ${msg}`);
      return null;
    }
  }

  // ccrotate has no `active` subcommand — `status` is the closest signal.
  // First line is `🔍 Checking usage tier for <email>...` (claude) or
  // `🔍 Checking Codex usage for <email>...` (codex). We pull the email out
  // of `for <email>...` (or any `<local>@<domain>` token in the output).
  const r = spawnSync("ccrotate", ["--target", target, "status"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const m = out.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
  return m ? m[0] : null;
}

interface BotResponse {
  status: number;
  body: string;
  parsed: Record<string, unknown> | null;
}

async function notifyBot(email: string, target: "claude" | "codex"): Promise<BotResponse> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(`${BOT_URL}/reloginViaSession`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, target }),
      signal: ctrl.signal,
    });
    const body = await resp.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      // non-JSON response — treat as failure with raw body in escalation
    }
    const summary = body.slice(0, 300);
    // 200 = bot completed re-login + snap successfully.
    // 4xx = client error (most often: operator never seeded a sessionKey
    //       for this email via /setSession; bot can't recover without it).
    // 5xx / abort = bot side failure; next heartbeat will catch the same
    //       provider_quota_exhausted state and re-trigger this hook.
    if (resp.status === 200) {
      console.log(`[ccrotate-relogin-trigger] ok target=${target} email=${email} body=${summary}`);
    } else if (resp.status >= 400 && resp.status < 500) {
      console.log(
        `[ccrotate-relogin-trigger] bot rejected target=${target} email=${email} status=${resp.status} body=${summary}` +
          ` — likely no stored sessionKey; seed via POST /setSession to enable auto-recovery`,
      );
    } else {
      console.log(`[ccrotate-relogin-trigger] bot ${resp.status} target=${target} email=${email} body=${summary}`);
    }
    return { status: resp.status, body, parsed };
  } finally {
    clearTimeout(t);
  }
}

interface EscalationContext {
  reason: "bot_unreachable" | "bot_returned_error" | "operator_action_required";
  detail: string;
  target: "claude" | "codex";
  email: string;
  agentId: string;
  runId: string;
  errorCode: string;
}

function classifyBotResult(
  resp: BotResponse | { error: string; aborted?: boolean },
): { needsEscalation: false } | { needsEscalation: true; reason: EscalationContext["reason"]; detail: string } {
  if ("error" in resp) {
    return {
      needsEscalation: true,
      reason: "bot_unreachable",
      detail: resp.aborted ? `timeout after ${REQUEST_TIMEOUT_MS}ms: ${resp.error}` : resp.error,
    };
  }
  if (resp.status >= 500) {
    return {
      needsEscalation: true,
      reason: "bot_returned_error",
      detail: `bot HTTP ${resp.status}: ${resp.body.slice(0, 200)}`,
    };
  }
  if (resp.status >= 400) {
    // /reloginViaSession returns 4xx when the bot has no stored sessionKey
    // for this email (operator never seeded one) or the key has expired
    // beyond the ~30d Cloudflare TTL. Auto-recovery is impossible without
    // operator action — escalate so someone can re-seed.
    const detail = resp.parsed && typeof resp.parsed.error === "string"
      ? resp.parsed.error
      : `bot HTTP ${resp.status}: ${resp.body.slice(0, 200)}`;
    return {
      needsEscalation: true,
      reason: "operator_action_required",
      detail: `${detail} — seed sessionKey via POST /setSession to enable auto-recovery`,
    };
  }
  if (resp.parsed && typeof resp.parsed.error === "string") {
    return {
      needsEscalation: true,
      reason: "bot_returned_error",
      detail: resp.parsed.error,
    };
  }
  return { needsEscalation: false };
}

async function postSlackEscalation(ctx: EscalationContext): Promise<void> {
  if (!SLACK_WEBHOOK_URL) return;
  const lines: string[] = [
    `:warning: *ccrotate auth-bot recovery needs human help* (${ctx.reason})`,
    `• target: \`${ctx.target}\`   email: \`${ctx.email}\``,
    `• agent: \`${ctx.agentId || "?"}\`   runId: \`${ctx.runId || "?"}\`   errorCode: \`${ctx.errorCode || "?"}\``,
    `• detail: ${ctx.detail.slice(0, 400)}`,
    ctx.target === "claude"
      ? "Recovery: run `claude /logout && claude /login` (sign in as the email above) and `ccrotate snap --force` on devbox; sync cron will mirror to cluster."
      : "Recovery: run `codex login --device-auth` (sign in as the email above) and `ccrotate --target codex snap --force` on devbox.",
  ];
  const payload = { text: lines.join("\n") };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SLACK_TIMEOUT_MS);
  try {
    const resp = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error(
        `[ccrotate-relogin-trigger] slack webhook ${resp.status}: ${body.slice(0, 200)}`,
      );
      return;
    }
    console.log(`[ccrotate-relogin-trigger] slack escalation posted (reason=${ctx.reason})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ccrotate-relogin-trigger] slack post failed: ${msg}`);
  } finally {
    clearTimeout(t);
  }
}

async function main(): Promise<void> {
  const adapterType = (process.env.PAPERCLIP_ADAPTER_TYPE ?? "").trim();
  const agentId = (process.env.PAPERCLIP_AGENT_ID ?? "").trim();
  const runId = (process.env.PAPERCLIP_RUN_ID ?? "").trim();
  const errorCode = (process.env.PAPERCLIP_ERROR_CODE ?? "").trim();
  if (!adapterType) {
    console.log("[ccrotate-relogin-trigger] no PAPERCLIP_ADAPTER_TYPE — skip");
    return;
  }
  const target = adapterToTarget(adapterType);
  if (!target) {
    console.log(`[ccrotate-relogin-trigger] adapterType=${adapterType} doesn't map to a ccrotate target — skip`);
    return;
  }
  const email = await readActiveEmail(target);
  if (!email) {
    console.log(`[ccrotate-relogin-trigger] no active ${target} account — skip`);
    return;
  }
  // Per-email backoff: a successful relogin freshens the OAuth tokens but
  // doesn't reset Anthropic's 5h cap, so an exhausted active account will
  // re-trigger this hook on every dispatched run. Without backoff the bot
  // gets POSTed every ~30s for the same email, blocking other accounts
  // (the bot serializes relogins via serializeRelogin) and burning a
  // Camoufox session each cycle. One attempt per email per hour bounds
  // the storm.
  const backoff = loadBackoff();
  const backoffState = isOnBackoff(backoff, target, email);
  if (backoffState.onBackoff) {
    const remainMin = Math.round(backoffState.remainingMs / 60000);
    console.log(
      `[ccrotate-relogin-trigger] backoff target=${target} email=${email} — last attempt within ${Math.round(BACKOFF_MS / 60000)}m window; ${remainMin}m remaining; skip`,
    );
    return;
  }
  console.log(`[ccrotate-relogin-trigger] agent=${agentId} adapter=${adapterType} target=${target} email=${email} errorCode=${errorCode}`);

  let result: { needsEscalation: false } | { needsEscalation: true; reason: EscalationContext["reason"]; detail: string };
  try {
    const botResp = await notifyBot(email, target);
    recordAttempt(backoff, target, email, botResp.status);
    result = classifyBotResult(botResp);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const aborted = err instanceof Error && err.name === "AbortError";
    recordAttempt(backoff, target, email, "error");
    result = classifyBotResult({ error: msg, aborted });
  }

  if (result.needsEscalation) {
    await postSlackEscalation({
      reason: result.reason,
      detail: result.detail,
      target,
      email,
      agentId,
      runId,
      errorCode,
    });
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[ccrotate-relogin-trigger] fatal: ${msg}`);
}).finally(() => {
  // Always exit 0 — recovery path must not be blocked by bot-side issues.
  process.exit(0);
});
