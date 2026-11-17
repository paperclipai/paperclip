import type { AiAuthMethod, AiProvider } from "./ai-connections.js";

/** A provider observation, never an estimate from Paperclip's run costs. */
export interface AiConnectionUsageLimit {
  id: string;
  label: string;
  /** Null means the account-wide allowance; named model/features stay separate. */
  scope: string | null;
  windowDurationSeconds: number | null;
  /** Provider-named reset cadence when no exact duration is available. */
  resetInterval?: string | null;
  resetsAt: string | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  unit: string | null;
  limitReached: boolean | null;
  /** Only set when the provider reports admission explicitly. */
  allowed: boolean | null;
}

export interface AiConnectionUsageOverage {
  enabled: boolean | null;
  /** Null when enabling overage does not prove a funded usable balance. */
  available: boolean | null;
  unlimited: boolean | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  balance: number | null;
  unit: string | null;
}

export interface AiConnectionUsage {
  connectionId: string;
  grantId: string;
  provider: AiProvider;
  method: AiAuthMethod;
  status: "ok" | "unsupported" | "unavailable" | "error";
  checkedAt: string;
  source: string | null;
  planType: string | null;
  limits: AiConnectionUsageLimit[];
  overage: AiConnectionUsageOverage | null;
  errorCode?: "unsupported" | "connection_unavailable" | "authentication_required" | "permission_denied" | "rate_limited" | "provider_unavailable" | "invalid_response";
  message?: string;
}

export function supportsAiConnectionUsage(provider: AiProvider, method: AiAuthMethod): boolean {
  return method === "subscription"
    ? provider === "openai" || provider === "anthropic" || provider === "xai"
    : provider === "openrouter";
}
