// ROCAA-21: best-effort Slack/OPS webhook delivery for adapter.auth_drift run events.
//
// The upstream signal (`adapter.auth_drift` warn run event) is appended in
// `heartbeat.ts` `onAdapterMeta` (see ROCAA-19). This module turns that signal
// into a debounced, redacted, non-blocking webhook POST so the OPS channel is
// paged when an agent unexpectedly lands in API-key auth mode.
//
// Design notes:
//   * Fire-and-forget from the heartbeat path. We MUST NOT delay the run.
//   * In-process debounce keyed by (companyId, agentId, adapterType, reasons)
//     so a misconfigured agent does not spam the channel every heartbeat.
//   * No env values, secrets, or token-bearing argv flags leave the process —
//     `meta.env` is never forwarded, and `--api-key=` style args are masked.
//   * URL value comes from the `PAPERCLIP_OPS_AUTH_DRIFT_WEBHOOK_URL` env var
//     (board approval required before the value is set in prod).

import { logger } from "../middleware/logger.js";

export interface AuthDriftWebhookPayload {
  companyId: string;
  adapterType: string;
  agentId: string;
  agentName?: string | null;
  runId: string;
  authSource: string | null;
  reasons: string[];
  /** Raw command string from AdapterInvocationMeta — typically just the binary path. */
  command?: string | null;
  /** Optional argv. Sensitive flags like --api-key=... are masked before send. */
  commandArgs?: string[] | null;
}

export type AuthDriftWebhookOutcome = "sent" | "debounced" | "disabled" | "failed";

export interface AuthDriftWebhookLogger {
  info: (meta: Record<string, unknown>, message: string) => void;
  warn: (meta: Record<string, unknown>, message: string) => void;
  error: (meta: Record<string, unknown>, message: string) => void;
}

export interface AuthDriftWebhookDispatcherOptions {
  url?: string | null;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  debounceMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: AuthDriftWebhookLogger;
}

export interface AuthDriftWebhookDispatcher {
  /** True if a URL is configured. When false, `dispatch()` is a no-op. */
  readonly enabled: boolean;
  /** Fire-and-forget. Never throws, never blocks. */
  dispatch(payload: AuthDriftWebhookPayload): void;
  /** Awaitable variant for tests / integration callers that want the outcome. */
  dispatchAndWait(payload: AuthDriftWebhookPayload): Promise<AuthDriftWebhookOutcome>;
  /** Test helper. */
  resetDebounce(): void;
}

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_DEBOUNCE_MS = 15 * 60 * 1000;

const SENSITIVE_ARG_PATTERN = /^(--api-key|--anthropic-api-key|--openai-api-key)(=|$)/i;

function maskCommandArgs(args: string[] | null | undefined): string[] | null {
  if (!Array.isArray(args)) return null;
  const masked: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    const m = arg.match(SENSITIVE_ARG_PATTERN);
    if (!m) {
      masked.push(arg);
      continue;
    }
    if (m[2] === "=") {
      // --api-key=secret -> --api-key=***REDACTED***
      masked.push(`${arg.slice(0, m[1].length + 1)}***REDACTED***`);
    } else {
      // --api-key secret -> mask the next token too
      masked.push(arg);
      if (i + 1 < args.length) {
        masked.push("***REDACTED***");
        i += 1;
      }
    }
  }
  return masked;
}

function buildDebounceKey(p: AuthDriftWebhookPayload): string {
  const reasons = [...p.reasons].sort().join(",");
  return [p.companyId, p.agentId, p.adapterType, reasons].join("|");
}

function buildRedactedPayload(p: AuthDriftWebhookPayload) {
  return {
    eventType: "adapter.auth_drift" as const,
    companyId: p.companyId,
    adapterType: p.adapterType,
    agentId: p.agentId,
    agentName: p.agentName ?? null,
    runId: p.runId,
    authSource: p.authSource,
    reasons: p.reasons,
    command: typeof p.command === "string" ? p.command : null,
    commandArgs: maskCommandArgs(p.commandArgs),
  };
}

export function buildSlackWebhookBody(payload: AuthDriftWebhookPayload): {
  text: string;
  attachments: Array<Record<string, unknown>>;
  paperclip: ReturnType<typeof buildRedactedPayload>;
} {
  const redacted = buildRedactedPayload(payload);
  const summary = `:rotating_light: Auth-source drift — \`${payload.adapterType}\` spawned in \`${payload.authSource ?? "unknown"}\` mode`;
  const detail = [
    `*Company:* ${payload.companyId}`,
    `*Agent:* ${payload.agentName ? `${payload.agentName} (${payload.agentId})` : payload.agentId}`,
    `*Run:* ${payload.runId}`,
    `*Reasons:* ${payload.reasons.join(", ") || "(none recorded)"}`,
  ].join("\n");
  return {
    text: `${summary}\n${detail}`,
    attachments: [
      {
        color: "warning",
        fields: [
          { title: "Adapter", value: payload.adapterType, short: true },
          { title: "Auth source", value: payload.authSource ?? "unknown", short: true },
          {
            title: "Agent",
            value: payload.agentName
              ? `${payload.agentName} (${payload.agentId})`
              : payload.agentId,
            short: false,
          },
          { title: "Run", value: payload.runId, short: false },
          { title: "Reasons", value: payload.reasons.join("\n") || "(none)", short: false },
        ],
      },
    ],
    paperclip: redacted,
  };
}

function defaultLogger(): AuthDriftWebhookLogger {
  return {
    info: (meta, message) => logger.info(meta, message),
    warn: (meta, message) => logger.warn(meta, message),
    error: (meta, message) => logger.error(meta, message),
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createAuthDriftWebhookDispatcher(
  options: AuthDriftWebhookDispatcherOptions = {},
): AuthDriftWebhookDispatcher {
  const url = options.url?.trim() || null;
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
  const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? defaultLogger();
  const lastSentAt = new Map<string, number>();

  async function postOnce(body: string): Promise<{ ok: boolean; status: number | null; error?: string }> {
    if (!url || !fetchImpl) return { ok: false, status: null, error: "no-url-or-fetch" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      return { ok: resp.ok, status: resp.status };
    } catch (err) {
      return {
        ok: false,
        status: null,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function send(payload: AuthDriftWebhookPayload): Promise<AuthDriftWebhookOutcome> {
    if (!url) return "disabled";
    const key = buildDebounceKey(payload);
    const last = lastSentAt.get(key) ?? 0;
    if (debounceMs > 0 && now() - last < debounceMs) {
      log.info({ key, debounceMs }, "auth-drift webhook debounced");
      return "debounced";
    }
    const body = JSON.stringify(buildSlackWebhookBody(payload));
    let attempt = 1;
    let result = await postOnce(body);
    while (!result.ok && attempt < maxAttempts) {
      await sleep(retryBaseDelayMs * Math.pow(2, attempt - 1));
      attempt += 1;
      result = await postOnce(body);
    }
    if (result.ok) {
      lastSentAt.set(key, now());
      log.info(
        {
          key,
          status: result.status,
          attempts: attempt,
          companyId: payload.companyId,
          agentId: payload.agentId,
          adapterType: payload.adapterType,
        },
        "auth-drift webhook delivered",
      );
      return "sent";
    }
    log.warn(
      {
        key,
        status: result.status,
        attempts: attempt,
        error: result.error,
        companyId: payload.companyId,
        agentId: payload.agentId,
        adapterType: payload.adapterType,
      },
      "auth-drift webhook delivery failed",
    );
    return "failed";
  }

  return {
    enabled: Boolean(url),
    dispatch(payload) {
      if (!url) return;
      // Fire-and-forget. Wrap to ensure no rejected promise escapes.
      void send(payload).catch((err) => {
        log.error(
          { error: err instanceof Error ? err.message : String(err) },
          "auth-drift webhook dispatcher crashed",
        );
      });
    },
    async dispatchAndWait(payload) {
      try {
        return await send(payload);
      } catch (err) {
        log.error(
          { error: err instanceof Error ? err.message : String(err) },
          "auth-drift webhook dispatcher crashed",
        );
        return "failed";
      }
    },
    resetDebounce() {
      lastSentAt.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Heartbeat-side helper. Extracted from `heartbeat.ts` so the integration
// between run-event append and webhook dispatch can be exercised in tests
// without a full embedded-postgres harness.
// ---------------------------------------------------------------------------

export interface AuthDriftRunEventAppender {
  (event: {
    eventType: string;
    stream?: "system" | "stdout" | "stderr";
    level?: "info" | "warn" | "error";
    message?: string;
    payload?: Record<string, unknown>;
  }): Promise<void>;
}

export interface AuthDriftMetaInput {
  adapterType: string;
  command: string;
  commandArgs?: string[];
  agentId?: string;
  authSource?: "subscription" | "api" | "metered_api";
  authDriftDetected?: boolean;
  authDriftReasons?: string[];
}

export interface HandleAuthDriftMetaParams {
  meta: AuthDriftMetaInput;
  agent: { id: string; name?: string | null; companyId: string };
  runId: string;
  appendRunEvent: AuthDriftRunEventAppender;
  dispatcher: AuthDriftWebhookDispatcher;
  log?: Pick<AuthDriftWebhookLogger, "warn">;
}

/**
 * Append the `adapter.auth_drift` run event and dispatch the OPS webhook.
 * No-op when `meta.authDriftDetected` is falsy. Webhook dispatch is
 * fire-and-forget; only the run-event append is awaited.
 */
export async function handleAuthDriftMeta(params: HandleAuthDriftMetaParams): Promise<void> {
  const { meta, agent, runId, appendRunEvent, dispatcher, log } = params;
  if (!meta.authDriftDetected) return;
  const reasons = meta.authDriftReasons ?? [];
  const driftPayload: Record<string, unknown> = {
    adapterType: meta.adapterType,
    agentId: meta.agentId ?? agent.id,
    runId,
    authSource: meta.authSource ?? null,
    reasons,
    command: meta.command,
  };
  log?.warn(
    { companyId: agent.companyId, ...driftPayload },
    "adapter auth-source drift detected",
  );
  await appendRunEvent({
    eventType: "adapter.auth_drift",
    stream: "system",
    level: "warn",
    message: `Auth-source drift: ${meta.adapterType} spawned in ${meta.authSource ?? "unknown"} mode (${reasons.join("; ") || "no reason recorded"})`,
    payload: driftPayload,
  });
  dispatcher.dispatch({
    companyId: agent.companyId,
    adapterType: meta.adapterType,
    agentId: meta.agentId ?? agent.id,
    agentName: agent.name ?? null,
    runId,
    authSource: meta.authSource ?? null,
    reasons,
    command: meta.command,
    commandArgs: meta.commandArgs ?? null,
  });
}
