import type {
  ClaudeBridgeAgent,
  ClaudeBridgeResolvedInstructions,
  ClaudeBridgeRuntime,
} from "@paperclipai/claude-bridge-protocol";

export interface UsageSummary {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ClaudeBridgeExecutionResult {
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  errorMessage?: string | null;
  errorCode?: string | null;
  errorFamily?: "transient_upstream" | null;
  retryNotBefore?: string | null;
  errorMeta?: Record<string, unknown>;
  usage?: UsageSummary | null;
  sessionId?: string | null;
  sessionParams?: Record<string, unknown> | null;
  sessionDisplayId?: string | null;
  provider?: string | null;
  biller?: string | null;
  model?: string | null;
  billingType?:
    | "api"
    | "subscription"
    | "metered_api"
    | "subscription_included"
    | "subscription_overage"
    | "credits"
    | "fixed"
    | "unknown";
  costUsd?: number | null;
  resultJson?: Record<string, unknown> | null;
  summary?: string | null;
  clearSession?: boolean;
  question?: unknown;
}

export interface ClaudeBridgeExecutionContext {
  runId: string;
  agent: ClaudeBridgeAgent;
  runtime: ClaudeBridgeRuntime;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
  resolvedInstructions?: ClaudeBridgeResolvedInstructions | null;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
}
