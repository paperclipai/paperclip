import { MODEL_ROUTING_DEFAULTS } from "@ironworksai/shared";
import { logger } from "../middleware/logger.js";

export type TaskComplexity = "routine" | "standard" | "complex";

/**
 * Classify the complexity of a heartbeat task based on its wake context.
 * This drives model selection in the cascade.
 */
export function classifyTaskComplexity(context: {
  wakeReason: string;
  hasNewComments: boolean;
  issueCount: number;
  isApprovalNeeded: boolean;
}): TaskComplexity {
  const { wakeReason, hasNewComments, issueCount, isApprovalNeeded } = context;

  // Complex: approvals, multiple issues, or blocked task states
  if (isApprovalNeeded) return "complex";
  if (issueCount > 1) return "complex";
  if (wakeReason === "approval_approved" || wakeReason === "approval_rejected") return "complex";
  if (wakeReason === "blocked") return "complex";

  // Routine: timer wake with no new comments and no active issue
  if (wakeReason === "timer" && !hasNewComments && issueCount === 0) return "routine";

  // Standard: new comment, assignment, or single-issue work
  if (hasNewComments) return "standard";
  if (wakeReason === "comment" || wakeReason === "assignment" || wakeReason === "issue_comment_mentioned") {
    return "standard";
  }
  if (issueCount === 1) return "standard";

  return "routine";
}

/**
 * Detect the provider family from a model string.
 * Returns "anthropic" for claude-* models, "openai" for gpt-* models,
 * "ollama" for models with a :cloud suffix, null if unknown.
 */
function detectProviderFamily(model: string): "anthropic" | "openai" | "ollama" | null {
  const lower = model.toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  if (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4")) {
    return "openai";
  }
  if (lower.endsWith(":cloud") || lower.includes(":cloud-") || lower.includes(":latest")) {
    return "ollama";
  }
  return null;
}

/**
 * Select the appropriate model for a given task complexity level.
 * When routingEnabled is false the configured model is always returned unchanged.
 */
export function selectModelForComplexity(
  complexity: TaskComplexity,
  configuredModel: string,
  routingEnabled: boolean,
): string {
  if (!routingEnabled || !configuredModel) return configuredModel;

  const family = detectProviderFamily(configuredModel);
  if (!family) return configuredModel;

  const defaults = MODEL_ROUTING_DEFAULTS[family];
  if (!defaults) return configuredModel;

  switch (complexity) {
    case "routine":
      return defaults.routine;
    case "standard":
      // Standard uses the configured model as-is (it is already the right tier)
      return configuredModel || defaults.standard;
    case "complex":
      return configuredModel || defaults.complex;
  }
}

/**
 * After a cheap model responds, check for uncertainty markers that indicate
 * the response should be escalated to a higher-tier model on the next run.
 */
export function shouldEscalateModel(response: string): boolean {
  if (!response) return false;

  const lower = response.toLowerCase();

  // Explicit uncertainty phrases
  const uncertaintyPhrases = [
    "i'm not sure",
    "i am not sure",
    "i don't have enough information",
    "i do not have enough information",
    "this is uncertain",
    "i'm uncertain",
    "i am uncertain",
    "i cannot determine",
    "i can't determine",
    "unclear to me",
    "i lack the context",
    "i need more context",
    "i need more information",
  ];
  if (uncertaintyPhrases.some((phrase) => lower.includes(phrase))) return true;

  // Very short response for what should be substantive work
  if (response.trim().length < 100) return true;

  // Response is asking a clarifying question (ends with ?)
  const trimmed = response.trim();
  if (trimmed.endsWith("?") && trimmed.length < 300) return true;

  return false;
}

/**
 * Log an escalation signal for the given agent and run.
 * The caller decides what to do with this signal (e.g. store a flag for next run).
 */
export function logEscalationSignal(agentId: string, runId: string, reason: string): void {
  logger.info(
    { agentId, runId, escalationReason: reason },
    "[model-routing] Escalation signal: cheap model response may need a higher-tier model on next run",
  );
}
