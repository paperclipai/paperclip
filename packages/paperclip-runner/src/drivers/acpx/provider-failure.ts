import type { ProviderFailure } from "../../contracts/provider-failure.generated.js";
import { createProviderFailure } from "../provider-failure.js";
import { boundedSidecarValue } from "./sidecar-protocol.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function acpError(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 5) return null;
  const entry = record(value);
  if (typeof entry.code === "number" && typeof entry.message === "string") return entry;
  for (const key of ["acp", "cause", "error"]) {
    const found = acpError(entry[key], depth + 1);
    if (found) return found;
  }
  return null;
}

// Provider error types, plus the `errorKind` values Claude ACP attaches to
// ACP error data so clients need not match message text.
const CATEGORIES = new Map<string, ProviderFailure["category"]>([
  ["authentication_error", "authentication"], ["permission_error", "permission"], ["overloaded_error", "overloaded"],
  ["rate_limit_error", "rate_limit"], ["billing_error", "quota_exhausted"], ["invalid_request_error", "invalid_request"],
  ["insufficient_quota", "quota_exhausted"], ["model_not_found", "model_unavailable"],
  ["authentication_failed", "authentication"], ["oauth_org_not_allowed", "authentication"],
  ["account_on_hold", "quota_exhausted"], ["rate_limit", "rate_limit"], ["overloaded", "overloaded"],
  ["invalid_request", "invalid_request"],
]);
// ACP reserves this JSON-RPC code for "Authentication required".
const ACP_AUTH_REQUIRED = -32000;

/** The typed AIR session failure ACPX reports beside its generic terminal error. */
export type AcpxTerminalSessionFailure = {
  category: string;
  recoveryActions?: readonly string[]; title?: string; details?: string;
  /** Structured provider fields an owned runtime patch reported beside the AIR failure. */
  provider?: AcpxStructuredTurnFailure;
};

/** Google Antigravity's managed-turn failure, classified by Paperclip's native patch. */
export type AcpxStructuredTurnFailure = {
  kind: ProviderFailure["category"] | "connection";
  httpStatus?: number; status?: string; retryAfterSeconds?: number;
  model?: string; route?: "api_key" | "subscription";
};

export const ANTIGRAVITY_TURN_FAILURE_SCHEMA = "paperclip.antigravity.turn_failure.v1";
/** A permanent model refusal: the server names the model; no provider text travels. */
export const ANTIGRAVITY_MODEL_UNAVAILABLE = "antigravity_model_unavailable";
const STRUCTURED_KINDS = new Set(["rate_limit", "quota_exhausted", "authentication", "permission", "model_unavailable",
  "invalid_request", "overloaded", "timeout", "unknown", "connection"]);

function structuredTurnFailure(meta: Record<string, unknown> | null): AcpxStructuredTurnFailure | undefined {
  const value = meta?.paperclipAntigravityFailure;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (entry.schema !== ANTIGRAVITY_TURN_FAILURE_SCHEMA || typeof entry.kind !== "string" || !STRUCTURED_KINDS.has(entry.kind)) return undefined;
  const integer = (field: unknown, min: number, max: number) => Number.isInteger(field) && Number(field) >= min && Number(field) <= max ? Number(field) : undefined;
  const httpStatus = integer(entry.httpStatus, 400, 599);
  const retryAfterSeconds = integer(entry.retryAfterSeconds, 0, 7 * 24 * 60 * 60);
  return {
    kind: entry.kind as AcpxStructuredTurnFailure["kind"],
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(typeof entry.status === "string" && /^[A-Z_]{1,64}$/.test(entry.status) ? { status: entry.status } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(typeof entry.model === "string" && entry.model.length > 0 && entry.model.length <= 512 && !/[\u0000-\u001f\u007f]/.test(entry.model) ? { model: entry.model } : {}),
    ...(entry.route === "api_key" || entry.route === "subscription" ? { route: entry.route } : {}),
  };
}

const TYPED_SESSION_FAILURE_CATEGORIES = new Set(["connection", "access", "limit", "service", "request", "unknown"]);

/** Advertised on initialize so ACP agents report terminal failures as typed JetBrains AIR metadata. */
export function acpxTypedSessionFailureClientCapabilities(
  extra?: Record<string, unknown>,
  airCapabilities: readonly string[] = [],
): Record<string, unknown> {
  const meta = extra?._meta !== null && typeof extra?._meta === "object" && !Array.isArray(extra._meta)
    ? extra._meta as Record<string, unknown>
    : {};
  return {
    ...structuredClone(extra ?? {}),
    _meta: { jetbrains: { air: { version: 1, capabilities: ["sessionFailure", ...airCapabilities] } }, ...structuredClone(meta) },
  };
}

/**
 * Read a typed terminal failure from the prompt response `_meta`, which ACPX
 * returns on the turn result. The agent still answers with a normal stop
 * reason, so the caller must fail the turn itself.
 */
export function acpxTypedTerminalSessionFailure(meta: unknown): AcpxTerminalSessionFailure | null {
  const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const air = object(object(object(meta)?.jetbrains)?.air);
  if (!air || !Number.isInteger(air.version) || Number(air.version) < 1) return null;
  const failure = object(air.sessionFailure);
  if (!failure || failure.severity !== "error") return null;
  const provider = structuredTurnFailure(object(meta));
  // Keep complete provider text; consumers redact before bounding it.
  return {
    category: typeof failure.category === "string" && TYPED_SESSION_FAILURE_CATEGORIES.has(failure.category) ? failure.category : "unknown",
    ...(typeof failure.title === "string" ? { title: failure.title } : {}),
    ...(typeof failure.details === "string" ? { details: failure.details } : {}),
    ...(air.version === 1 && Array.isArray(failure.actions) && failure.actions.every(action => typeof action === "string")
      ? { recoveryActions: failure.actions } : {}),
    ...(provider ? { provider } : {}),
  };
}

/**
 * AIR's `limit` category also covers context, turn and configured budget
 * limits. Only an exhausted account allowance is a provider limit; the
 * Claude's recovery actions distinguish its limit types. Older receipts may
 * carry only the provider title.
 */
function sessionLimitCategory(agent: string, failure: AcpxTerminalSessionFailure | undefined): ProviderFailure["category"] | undefined {
  if (failure?.category !== "limit") return undefined;
  // Claude ACP's AIR v1 policy assigns no action to quota exhaustion,
  // retry to rate limiting, and new_session to context and budget exhaustion.
  // These actions describe the provider failure and grant no execution authority.
  const actions = failure.recoveryActions;
  if (agent === "claude" && actions) {
    if (actions.length === 0) return "quota_exhausted";
    if (actions.length === 1 && actions[0] === "retry") return "rate_limit";
    if (actions.includes("new_session")) return undefined;
  }
  const text = [failure.title, failure.details].filter(value => typeof value === "string").join("\n");
  if (/\brate[- ]limit/i.test(text)) return "rate_limit";
  if (/no available quota|usage limit|you(?:'|’)ve hit your (?:[\w-]+ )?limit|out of (?:extra )?usage|quota (?:limit )?exceeded/i.test(text)) {
    return "quota_exhausted";
  }
  return undefined;
}

/**
 * Claude Code reports a model it cannot run (unknown, retired, or not on the
 * account) as an AIR `request` failure with this fixed title. The user must
 * choose another model, so it is an unavailable model, not a generic request.
 */
const CLAUDE_SELECTED_MODEL_REJECTED =
  /^There's an issue with the selected model \([^()\n]{1,200}\)\. It may not exist or you may not have access to it\./;
function sessionModelCategory(agent: string, failure: AcpxTerminalSessionFailure | undefined): ProviderFailure["category"] | undefined {
  return agent === "claude" && failure?.category === "request" && typeof failure.title === "string" &&
    CLAUDE_SELECTED_MODEL_REJECTED.test(failure.title.trim()) ? "model_unavailable" : undefined;
}

/**
 * `ownMessage` keeps an error's own message when it carries no ACP error. Use
 * it only where every rejection belongs to the provider: a failed terminal
 * result or a provider session ensure. `sessionFailure` adds the provider's
 * title from a typed terminal session failure; its details stay private.
 */
export function acpxProviderFailure(error: unknown, agent: string, phase: ProviderFailure["phase"],
  environment: NodeJS.ProcessEnv = {}, ownMessage = false, sessionFailure?: AcpxTerminalSessionFailure): ProviderFailure | null {
  const acp = acpError(error);
  const data = record(acp?.data);
  const detail = record(data.error);
  const fallback = ownMessage || sessionFailure ? record(error) : {};
  const ownText = typeof detail.message === "string" ? detail.message
    : typeof data.details === "string" ? data.details
      : typeof acp?.message === "string" ? acp.message : fallback.message;
  const title = typeof sessionFailure?.title === "string" ? sessionFailure.title.trim() : "";
  const message = typeof ownText === "string" && title && !ownText.includes(title) ? `${ownText}\n${title}`
    : typeof ownText === "string" ? ownText : title || undefined;
  if (typeof message !== "string" || !message) return null;
  const status = data.status ?? data.statusCode ?? detail.status
    ?? (agent === "claude" ? Number(/^API error: (\d{3})\b/.exec(message)?.[1]) : undefined);
  const structured = sessionFailure?.provider;
  if (structured) {
    // The owned patch classified the native failure from its HTTP status and
    // Google status; a model refusal carries no provider wording at all.
    const modelRefused = structured.kind === "model_unavailable";
    return createProviderFailure({ provider: agent, phase,
      message: modelRefused ? "The selected model is not available for this connection." : title || message,
      httpStatus: structured.httpStatus,
      providerCode: modelRefused ? ANTIGRAVITY_MODEL_UNAVAILABLE : structured.status,
      category: structured.kind === "connection" ? "unknown" : structured.kind,
      retryAt: structured.retryAfterSeconds === undefined ? undefined : new Date(Date.now() + structured.retryAfterSeconds * 1000).toISOString(),
      environment });
  }
  const code = detail.type ?? detail.code ?? data.errorType ?? data.errorKind;
  const category = (typeof code === "string" ? CATEGORIES.get(code) : undefined)
    ?? (acp?.code === ACP_AUTH_REQUIRED ? "authentication" : undefined)
    ?? sessionLimitCategory(agent, sessionFailure)
    ?? sessionModelCategory(agent, sessionFailure);
  return createProviderFailure({ provider: agent === "claude" ? "anthropic" : agent === "codex" ? "openai" : agent,
    phase, message, httpStatus: status, providerCode: code, requestId: data.request_id, category, environment });
}

export function acpxTerminalResult(result: unknown, agent: string, environment: NodeJS.ProcessEnv = {},
  sessionFailure?: AcpxTerminalSessionFailure): Record<string, unknown> {
  const raw = record(result);
  const providerFailure = raw.status === "failed"
    ? acpxProviderFailure(raw.error, agent, "turn", environment, true, sessionFailure) : null;
  const terminal = boundedSidecarValue(result);
  if (providerFailure) {
    terminal.status = "failed";
    terminal.error = { ...record(terminal.error), providerFailure };
  }
  return terminal;
}
