import type {
  ModelStrategy,
  TaskImportance,
} from "@ironworksai/shared";
import {
  CRITICAL_TASK_LABELS,
  IMPORTANT_TASK_LABELS,
  WESTERN_COUNCIL_MODELS,
} from "@ironworksai/shared";
import type { AdapterExecutionResult } from "../adapters/types.js";
import { reviewOutputQuality } from "./agent-reflection.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CouncilConfig {
  strategy: ModelStrategy;
  primaryModel: string;
  cascadeFallback?: string;
  councilModels?: string[];
  qualityThreshold?: number;
}

export interface CouncilResponseEntry {
  model: string;
  response: string;
  qualityScore: number;
  latencyMs: number;
}

export interface CouncilResult {
  strategy: "single" | "cascade" | "council";
  winningModel: string;
  winningResponse: string;
  responses: CouncilResponseEntry[];
  retryCount: number;
  totalTokensUsed: number;
}

// ---------------------------------------------------------------------------
// Role-specific default council configurations
// ---------------------------------------------------------------------------

export const ROLE_COUNCIL_DEFAULTS: Record<string, Partial<CouncilConfig>> = {
  ceo: { strategy: "cascade", councilModels: [WESTERN_COUNCIL_MODELS.heavy] },
  cto: { strategy: "cascade", councilModels: [WESTERN_COUNCIL_MODELS.heavy] },
  cfo: { strategy: "cascade", councilModels: [WESTERN_COUNCIL_MODELS.heavy] },
  cmo: { strategy: "cascade" },
  vphr: { strategy: "cascade" },
  legalcounsel: {
    strategy: "cascade",
    councilModels: [WESTERN_COUNCIL_MODELS.heavy, WESTERN_COUNCIL_MODELS.light],
  },
  compliancedirector: { strategy: "cascade" },
  seniorengineer: { strategy: "single" },
  devopsengineer: { strategy: "single" },
  securityengineer: { strategy: "cascade" },
  uxdesigner: { strategy: "single" },
  contentmarketer: { strategy: "single" },
};

// ---------------------------------------------------------------------------
// Task Importance Classification
// ---------------------------------------------------------------------------

const C_SUITE_ROLES = new Set(["ceo", "cto", "cfo", "cmo", "coo", "ciso"]);

/**
 * Classify task importance from issue context.
 * Higher importance drives automatic strategy upgrades.
 */
export function classifyTaskImportance(context: {
  labels?: string[];
  issueTitle?: string;
  agentRole?: string;
  isApprovalRelated?: boolean;
  assignedByRole?: string;
  assignedByHuman?: boolean;
  isRetry?: boolean;
  originKind?: string;
}): TaskImportance {
  const {
    labels = [], issueTitle = "", agentRole = "",
    isApprovalRelated = false, assignedByRole = "",
    assignedByHuman = false, isRetry = false, originKind = "",
  } = context;
  const lowerLabels = labels.map((l) => l.toLowerCase());
  const lowerTitle = issueTitle.toLowerCase();
  const normalizedRole = agentRole.toLowerCase().replace(/[\s_-]+/g, "");
  const normalizedAssigner = assignedByRole.toLowerCase().replace(/[\s_-]+/g, "");

  // CRITICAL: direct human input (via Nolan or direct) = always critical
  if (assignedByHuman) return "critical";

  // CRITICAL: task is a retry after rejection = escalate
  if (isRetry) return "critical";

  // CRITICAL: chat origin (user is talking directly to agent)
  if (originKind === "chat") return "critical";

  // CRITICAL: labels contain critical task labels
  const hasCriticalLabel = CRITICAL_TASK_LABELS.some((cl) =>
    lowerLabels.some((ll) => ll.includes(cl)),
  );
  if (hasCriticalLabel) return "critical";

  // CRITICAL: C-suite + strategy/budget keywords in title
  if (C_SUITE_ROLES.has(normalizedRole)) {
    const criticalKeywords = ["strategy", "budget", "acquisition", "compliance", "legal", "memo", "report", "deliverable"];
    if (criticalKeywords.some((kw) => lowerTitle.includes(kw))) return "critical";
  }

  // IMPORTANT: assigned by CEO = minimum important (delegation chain)
  if (normalizedAssigner === "ceo" || C_SUITE_ROLES.has(normalizedAssigner)) return "important";

  // IMPORTANT: labels contain important task labels
  const hasImportantLabel = IMPORTANT_TASK_LABELS.some((il) =>
    lowerLabels.some((ll) => ll.includes(il)),
  );
  if (hasImportantLabel) return "important";
  if (C_SUITE_ROLES.has(normalizedRole)) return "important";
  if (isApprovalRelated) return "important";

  // Standard: has an issue assigned
  if (issueTitle.trim().length > 0) return "standard";

  // Routine: heartbeat status check
  return "routine";
}

// ---------------------------------------------------------------------------
// Strategy Resolution
// ---------------------------------------------------------------------------

/**
 * Determine which strategy and models to use based on importance and agent config.
 * Critical importance auto-upgrades any role to council.
 * Important importance upgrades single to cascade.
 */
export function resolveModelStrategy(
  importance: TaskImportance,
  agentConfig: CouncilConfig,
): { strategy: ModelStrategy; models: string[] } {
  let strategy = agentConfig.strategy;
  const primary = agentConfig.primaryModel;
  const fallback = agentConfig.cascadeFallback ?? WESTERN_COUNCIL_MODELS.heavy;
  const councilModels = agentConfig.councilModels ?? [
    WESTERN_COUNCIL_MODELS.heavy,
    WESTERN_COUNCIL_MODELS.light,
  ];

  // Auto-upgrade: critical importance forces council
  if (importance === "critical" && strategy !== "council") {
    strategy = "council";
  }

  // Auto-upgrade: important importance upgrades single to cascade
  if (importance === "important" && strategy === "single") {
    strategy = "cascade";
  }

  switch (strategy) {
    case "council": {
      // Primary + council models, deduplicated
      const allModels = [primary, ...councilModels];
      const unique = [...new Set(allModels)];
      return { strategy: "council", models: unique.length >= 2 ? unique : [primary, fallback] };
    }
    case "cascade":
      return { strategy: "cascade", models: [primary, fallback] };
    case "single":
    default:
      return { strategy: "single", models: [primary] };
  }
}

// ---------------------------------------------------------------------------
// Execution Strategies
// ---------------------------------------------------------------------------

type AdapterExecutor = (model: string) => Promise<AdapterExecutionResult>;

function extractTokenCount(result: AdapterExecutionResult): number {
  const usage = result.usage;
  if (!usage) return 0;
  return (
    (typeof usage.inputTokens === "number" ? usage.inputTokens : 0) +
    (typeof usage.outputTokens === "number" ? usage.outputTokens : 0)
  );
}

/**
 * Execute with a single model (existing behavior, wrapped in CouncilResult).
 */
export async function executeSingle(
  executeAdapter: AdapterExecutor,
  model: string,
): Promise<CouncilResult> {
  const start = Date.now();
  const result = await executeAdapter(model);
  const latencyMs = Date.now() - start;
  const response = result.summary ?? "";
  const qualityScore = reviewOutputQuality(response).score;

  return {
    strategy: "single",
    winningModel: model,
    winningResponse: response,
    responses: [{ model, response, qualityScore, latencyMs }],
    retryCount: 0,
    totalTokensUsed: extractTokenCount(result),
  };
}

/**
 * Execute with cascade: try primary, if quality below threshold retry with fallback.
 * Returns whichever scored higher.
 */
export async function executeCascade(
  executeAdapter: AdapterExecutor,
  primary: string,
  fallback: string,
  qualityThreshold = 60,
): Promise<CouncilResult> {
  const responses: CouncilResponseEntry[] = [];
  let totalTokens = 0;

  // Run primary
  const primaryStart = Date.now();
  const primaryResult = await executeAdapter(primary);
  const primaryLatency = Date.now() - primaryStart;
  const primaryResponse = primaryResult.summary ?? "";
  const primaryQuality = reviewOutputQuality(primaryResponse);
  totalTokens += extractTokenCount(primaryResult);

  responses.push({
    model: primary,
    response: primaryResponse,
    qualityScore: primaryQuality.score,
    latencyMs: primaryLatency,
  });

  logger.info(
    { model: primary, score: primaryQuality.score, threshold: qualityThreshold },
    "[model-council] Cascade primary result",
  );

  // If primary meets threshold, return it
  if (primaryQuality.score >= qualityThreshold) {
    return {
      strategy: "cascade",
      winningModel: primary,
      winningResponse: primaryResponse,
      responses,
      retryCount: 0,
      totalTokensUsed: totalTokens,
    };
  }

  // Primary below threshold - run fallback
  logger.info(
    { primary, fallback, primaryScore: primaryQuality.score, threshold: qualityThreshold },
    "[model-council] Primary below threshold, running fallback",
  );

  const fallbackStart = Date.now();
  const fallbackResult = await executeAdapter(fallback);
  const fallbackLatency = Date.now() - fallbackStart;
  const fallbackResponse = fallbackResult.summary ?? "";
  const fallbackQuality = reviewOutputQuality(fallbackResponse);
  totalTokens += extractTokenCount(fallbackResult);

  responses.push({
    model: fallback,
    response: fallbackResponse,
    qualityScore: fallbackQuality.score,
    latencyMs: fallbackLatency,
  });

  logger.info(
    { model: fallback, score: fallbackQuality.score },
    "[model-council] Cascade fallback result",
  );

  // Return whichever scored higher
  const winner = fallbackQuality.score > primaryQuality.score ? fallback : primary;
  const winnerResponse = winner === fallback ? fallbackResponse : primaryResponse;

  return {
    strategy: "cascade",
    winningModel: winner,
    winningResponse: winnerResponse,
    responses,
    retryCount: 1,
    totalTokensUsed: totalTokens,
  };
}

/**
 * Execute with council: run multiple models in parallel, pick the best response.
 * Uses Promise.allSettled so one model failure does not kill the whole council.
 * When scores are within 5 points, prefer the first model (primary) to avoid
 * unnecessary switching.
 */
export async function executeCouncil(
  executeAdapter: AdapterExecutor,
  models: string[],
  _judgeModel?: string,
): Promise<CouncilResult> {
  const responses: CouncilResponseEntry[] = [];
  let totalTokens = 0;
  const primaryModel = models[0];

  logger.info(
    { models, count: models.length },
    "[model-council] Council deliberation started",
  );

  // Run all models in parallel
  const settled = await Promise.allSettled(
    models.map(async (model) => {
      const start = Date.now();
      const result = await executeAdapter(model);
      const latencyMs = Date.now() - start;
      return { model, result, latencyMs };
    }),
  );

  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      const { model, result, latencyMs } = outcome.value;
      const response = result.summary ?? "";
      const qualityScore = reviewOutputQuality(response).score;
      totalTokens += extractTokenCount(result);
      responses.push({ model, response, qualityScore, latencyMs });

      logger.info(
        { model, score: qualityScore, latencyMs },
        "[model-council] Council member result",
      );
    } else {
      const idx = settled.indexOf(outcome);
      const failedModel = models[idx] ?? "unknown";
      logger.warn(
        { model: failedModel, error: String(outcome.reason) },
        "[model-council] Council member failed",
      );
    }
  }

  if (responses.length === 0) {
    // All models failed - throw so heartbeat can handle the error normally
    throw new Error("All council models failed to produce a response");
  }

  // Sort by quality score descending
  responses.sort((a, b) => b.qualityScore - a.qualityScore);
  const best = responses[0];

  // If scores are within 5 points, prefer the primary model to avoid unnecessary switching
  const primaryEntry = responses.find((r) => r.model === primaryModel);
  const winner =
    primaryEntry && best.model !== primaryModel && best.qualityScore - primaryEntry.qualityScore <= 5
      ? primaryEntry
      : best;

  logger.info(
    {
      winner: winner.model,
      winnerScore: winner.qualityScore,
      allScores: responses.map((r) => ({ model: r.model, score: r.qualityScore })),
    },
    "[model-council] Council deliberation complete",
  );

  return {
    strategy: "council",
    winningModel: winner.model,
    winningResponse: winner.response,
    responses,
    retryCount: responses.length - 1,
    totalTokensUsed: totalTokens,
  };
}
