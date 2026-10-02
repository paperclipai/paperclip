import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  RateLimitError,
  TypeSafeClient,
  type SystemOneResult,
} from "@typesafe-ai/sdk";
import {
  approvedJevIssueSummary,
  JEV_ISSUE_LANE_MODEL,
  JEV_ISSUE_LANE_POLICY_VERSION,
  JEV_ISSUE_LANE_QUESTIONS,
  JEV_ISSUE_LANE_RULES,
  type JevIssueLane,
} from "./jev-issue-lane-policy.js";

const JEV_LANES = new Set<JevIssueLane>([
  "engineering",
  "provider",
  "studio",
  "needs_review",
  "no_match",
]);

const DISALLOWED_SUMMARY_PATTERNS: readonly RegExp[] = [
  /\b(?:api[_ -]?key|password|passwd|secret|bearer|private[_ -]?key|access[_ -]?token)\b/i,
  /\b(?:customer|vendor|shipment|tracking|contract|agreement|exposure)[_ -]?(?:id|number|text|data)?\b/i,
  /\b(?:confidential|restricted|stack trace|raw log)\b/i,
  /\b[A-F0-9]{8}-[A-F0-9]{4}-[1-5][A-F0-9]{3}-[89AB][A-F0-9]{3}-[A-F0-9]{12}\b/i,
  /\b[A-Za-z0-9+/=_-]{32,}\b/,
  /\bhttps?:\/\//i,
  /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/,
];

export type JevShadowErrorCategory =
  | "authentication"
  | "rate_limit"
  | "timeout"
  | "connection"
  | "provider"
  | "invalid_response"
  | "unknown";

export type JevShadowReceipt = {
  suggestedLane: JevIssueLane | null;
  probabilities: Partial<Record<JevIssueLane, number>> | null;
  modelVersion: string;
  elapsedMs: number;
  tokens: { input: number; output: number; total: number } | null;
  errorCategory: JevShadowErrorCategory | null;
};

export type JevShadowObservation = {
  runId: string;
  issueIdentifier: string;
  issueStatus: string;
  unresolvedDependencyCount: number;
  duplicateRun: boolean;
};

type JevClient = Pick<TypeSafeClient, "systemOne">;

export type JevDecisionAdapterOptions = {
  enabled?: boolean;
  apiKey?: string;
  client?: JevClient;
  now?: () => number;
};

function validateApprovedSummary(summary: string): boolean {
  if (summary.length === 0 || summary.length > JEV_ISSUE_LANE_RULES.maximumSummaryCharacters) {
    return false;
  }
  return !DISALLOWED_SUMMARY_PATTERNS.some((pattern) => pattern.test(summary));
}

function probabilitiesAreValid(
  probabilities: Record<string, number>,
): probabilities is Record<JevIssueLane, number> {
  const keys = Object.keys(probabilities);
  if (keys.length !== JEV_LANES.size || keys.some((key) => !JEV_LANES.has(key as JevIssueLane))) {
    return false;
  }
  const values = Object.values(probabilities);
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) return false;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.abs(total - 1) <= 0.02;
}

function usageIsValid(usage: SystemOneResult<typeof JEV_ISSUE_LANE_QUESTIONS>["usage"]): boolean {
  return (
    Number.isSafeInteger(usage.input_tokens) &&
    usage.input_tokens >= 0 &&
    Number.isSafeInteger(usage.output_tokens) &&
    usage.output_tokens >= 0
  );
}

function classifyError(error: unknown): JevShadowErrorCategory {
  if (error instanceof AuthenticationError) return "authentication";
  if (error instanceof RateLimitError) return "rate_limit";
  if (error instanceof APITimeoutError) return "timeout";
  if (error instanceof APIConnectionError) return "connection";
  if (error instanceof APIError) return "provider";
  return "unknown";
}

export class JevDecisionAdapter {
  readonly #enabled: boolean;
  readonly #client: JevClient | null;
  readonly #now: () => number;
  readonly #observedRuns = new Set<string>();

  constructor(options: JevDecisionAdapterOptions = {}) {
    this.#enabled = options.enabled ?? process.env.PAPERCLIP_JEV_SHADOW_ENABLED === "true";
    this.#now = options.now ?? (() => performance.now());
    const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY?.trim();
    if (options.client) {
      this.#client = options.client;
    } else if (this.#enabled && apiKey) {
      try {
        this.#client = new TypeSafeClient({
          apiKey,
          defaultModel: JEV_ISSUE_LANE_MODEL,
          logLevel: "off",
          timeout: JEV_ISSUE_LANE_RULES.timeoutMs,
          retry: { maxRetries: JEV_ISSUE_LANE_RULES.maximumRetries },
        });
      } catch {
        // Configuration failure disables this optional observer. It must never
        // prevent Paperclip from starting or dispatching its existing route.
        this.#client = null;
      }
    } else {
      this.#client = null;
    }
  }

  isEligible(observation: JevShadowObservation): boolean {
    if (!this.#enabled || !this.#client) return false;
    if (observation.issueStatus === "blocked" || observation.unresolvedDependencyCount > 0) return false;
    if (observation.duplicateRun || this.#observedRuns.has(observation.runId)) return false;
    const summary = approvedJevIssueSummary(observation.issueIdentifier);
    return summary !== null && validateApprovedSummary(summary);
  }

  async suggestIssueLane(observation: JevShadowObservation): Promise<JevShadowReceipt | null> {
    if (!this.isEligible(observation) || !this.#client) return null;
    const summary = approvedJevIssueSummary(observation.issueIdentifier);
    if (!summary) return null;

    this.#observedRuns.add(observation.runId);
    if (this.#observedRuns.size > 10_000) {
      const oldestRunId = this.#observedRuns.values().next().value;
      if (oldestRunId) this.#observedRuns.delete(oldestRunId);
    }
    const startedAt = this.#now();
    try {
      const response: SystemOneResult<typeof JEV_ISSUE_LANE_QUESTIONS> =
        await this.#client.systemOne(
          {
            state: {
              approved_sanitized_issue_summary: summary,
              policy_version: JEV_ISSUE_LANE_POLICY_VERSION,
            },
            questions: JEV_ISSUE_LANE_QUESTIONS,
            model: JEV_ISSUE_LANE_MODEL,
          },
          {
            timeout: JEV_ISSUE_LANE_RULES.timeoutMs,
            retry: { maxRetries: JEV_ISSUE_LANE_RULES.maximumRetries },
          },
        );
      const answer = response.answers.issue_lane;
      const selected = answer.choice;
      if (
        response.model !== JEV_ISSUE_LANE_MODEL ||
        !JEV_LANES.has(selected) ||
        !probabilitiesAreValid(answer.probabilities as Record<string, number>) ||
        !Number.isFinite(answer.confidence) ||
        answer.confidence < 0 ||
        answer.confidence > 1 ||
        !usageIsValid(response.usage)
      ) {
        // Do not copy untrusted provider fields into the local run log. The
        // receipt records the requested pinned model even when the response is
        // malformed or claims a different model.
        return this.#errorReceipt(startedAt, "invalid_response");
      }
      const suggestedLane = answer.confidence < JEV_ISSUE_LANE_RULES.minimumConfidence
        ? JEV_ISSUE_LANE_RULES.lowConfidenceOutcome
        : selected;
      return {
        suggestedLane,
        probabilities: answer.probabilities,
        modelVersion: response.model,
        elapsedMs: Math.max(0, Math.round(this.#now() - startedAt)),
        tokens: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
          total: response.usage.input_tokens + response.usage.output_tokens,
        },
        errorCategory: null,
      };
    } catch (error) {
      return this.#errorReceipt(startedAt, classifyError(error));
    }
  }

  #errorReceipt(
    startedAt: number,
    errorCategory: JevShadowErrorCategory,
    modelVersion = JEV_ISSUE_LANE_MODEL,
  ): JevShadowReceipt {
    return {
      suggestedLane: null,
      probabilities: null,
      modelVersion,
      elapsedMs: Math.max(0, Math.round(this.#now() - startedAt)),
      tokens: null,
      errorCategory,
    };
  }
}

export function createJevDecisionAdapter(options?: JevDecisionAdapterOptions) {
  return new JevDecisionAdapter(options);
}
