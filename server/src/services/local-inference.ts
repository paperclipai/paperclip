/**
 * local-inference.ts
 *
 * Thin wrapper around the LM Studio OpenAI-compatible API (default: http://127.0.0.1:1234).
 * Used to route high-volume, lower-stakes cognitive tasks to a local model instead of
 * frontier APIs, eliminating per-token cost for those workloads.
 *
 * Task types routed locally:
 *   - run_failure_classification: classify heartbeat run outcomes (SUCCESS/TIMEOUT/TOOL_ERROR/…)
 *   - heartbeat_summary: summarize heartbeat diffs for cost-driver analysis
 *   - approval_preflight: detect whether a proposed change needs board approval
 *
 * All other task types fall back to the caller's configured frontier model.
 */

export interface LocalInferenceConfig {
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LocalChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LocalChatResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  latencyMs: number;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:1234";
const DEFAULT_MODEL = "gemma-4-31b-it";
const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_TIMEOUT_MS = 30_000;

// Tasks that should be routed to the local model
export type LocalTaskType =
  | "run_failure_classification"
  | "heartbeat_summary"
  | "approval_preflight";

export const LOCAL_TASK_TYPES: Set<string> = new Set<LocalTaskType>([
  "run_failure_classification",
  "heartbeat_summary",
  "approval_preflight",
]);

export function localInferenceService(config: LocalInferenceConfig = {}) {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const model = config.model ?? DEFAULT_MODEL;
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    /**
     * Check whether the local server is reachable and has a model loaded.
     * Returns false if the server is down or no models are loaded.
     */
    isAvailable: async (): Promise<boolean> => {
      try {
        const res = await fetch(`${baseUrl}/v1/models`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { data?: unknown[] };
        return Array.isArray(body.data) && body.data.length > 0;
      } catch {
        return false;
      }
    },

    /**
     * Send a chat completion to the local model.
     */
    chat: async (messages: LocalChatMessage[]): Promise<LocalChatResult> => {
      const t0 = Date.now();
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Local inference error ${res.status}: ${text}`);
      }

      const body = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        model: string;
      };

      const content = body.choices[0]?.message?.content ?? "";
      const usage = body.usage;

      return {
        content,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        model: body.model,
        latencyMs: Date.now() - t0,
      };
    },

    // ----- Task-specific helpers -----

    /**
     * KPI-routable task: classify a heartbeat run outcome.
     * Returns one of: SUCCESS | TIMEOUT | TOOL_ERROR | BUDGET_EXCEEDED | CHECKOUT_CONFLICT | UNKNOWN
     */
    classifyRunFailure: async (
      runSummary: string,
    ): Promise<{ classification: string; raw: LocalChatResult }> => {
      const raw = await localInferenceService(config).chat([
        {
          role: "system",
          content:
            "You are a classifier for AI agent heartbeat run outcomes. " +
            "Classify the run as exactly one of: SUCCESS, TIMEOUT, TOOL_ERROR, BUDGET_EXCEEDED, CHECKOUT_CONFLICT, UNKNOWN. " +
            "Reply with only the classification label, nothing else.",
        },
        { role: "user", content: runSummary },
      ]);
      const classification = raw.content.trim().split(/\s+/)[0] ?? "UNKNOWN";
      return { classification, raw };
    },

    /**
     * KPI-routable task: summarize a heartbeat diff for cost-driver analysis.
     * Returns a short human-readable summary.
     */
    summarizeHeartbeat: async (heartbeatLog: string): Promise<LocalChatResult> => {
      return localInferenceService(config).chat([
        {
          role: "system",
          content:
            "You are summarizing AI agent heartbeat logs for cost analysis. " +
            "Produce a 2-3 sentence summary identifying: which task was worked on, " +
            "what the agent did, and whether it completed or got blocked. Be concise.",
        },
        { role: "user", content: heartbeatLog },
      ]);
    },

    /**
     * KPI-routable task: check whether a proposed action needs board approval.
     * Returns { needsApproval: boolean, reason: string }.
     */
    approvalPreflight: async (
      proposedAction: string,
    ): Promise<{ needsApproval: boolean; reason: string; raw: LocalChatResult }> => {
      const raw = await localInferenceService(config).chat([
        {
          role: "system",
          content:
            "You are a governance pre-flight checker for an AI agent company. " +
            "Determine whether the proposed action requires board approval. " +
            "Reply in JSON: {\"needs_approval\": true|false, \"reason\": \"one sentence\"}",
        },
        { role: "user", content: proposedAction },
      ]);

      let needsApproval = false;
      let reason = raw.content.trim();
      try {
        const parsed = JSON.parse(raw.content.trim()) as { needs_approval?: boolean; reason?: string };
        needsApproval = Boolean(parsed.needs_approval);
        reason = parsed.reason ?? reason;
      } catch {
        // parse failed — default to conservative "needs approval"
        needsApproval = true;
        reason = "Could not parse model output — defaulting to approval required";
      }

      return { needsApproval, reason, raw };
    },
  };
}
