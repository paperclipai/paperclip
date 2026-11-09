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
export type AcpxTerminalSessionFailure = { category: string; title?: string; details?: string };

/**
 * AIR's `limit` category also covers context, turn and configured budget
 * limits. Only an exhausted account allowance is a provider limit; the
 * provider's own title distinguishes it.
 */
function sessionLimitCategory(failure: AcpxTerminalSessionFailure | undefined): ProviderFailure["category"] | undefined {
  if (failure?.category !== "limit") return undefined;
  const text = [failure.title, failure.details].filter(value => typeof value === "string").join("\n");
  if (/\brate[- ]limit/i.test(text)) return "rate_limit";
  if (/no available quota|usage limit|you(?:'|’)ve hit your (?:\w+ )?limit|out of (?:extra )?usage|quota (?:limit )?exceeded/i.test(text)) {
    return "quota_exhausted";
  }
  return undefined;
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
  const code = detail.type ?? detail.code ?? data.errorType ?? data.errorKind;
  const category = (typeof code === "string" ? CATEGORIES.get(code) : undefined)
    ?? (acp?.code === ACP_AUTH_REQUIRED ? "authentication" : undefined)
    ?? sessionLimitCategory(sessionFailure);
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
