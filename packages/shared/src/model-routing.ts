import {
  ISSUE_COMPLEXITIES,
  MODEL_PROFILE_KEYS,
  type IssueComplexity,
  type ModelProfileKey,
} from "./constants.js";

/**
 * Pure complexity → model-profile routing (TWX-471 deferred router, M1).
 *
 * The issue-level `complexity` field is the durable human/product signal
 * ("what is this work?"); model profiles are the mechanical execution lanes
 * ("which model/effort runs it?"). This module maps one to the other and
 * encodes the guardrails. It deliberately knows nothing about concrete model
 * ids — those live in each adapter's `modelProfiles` definitions so the lane
 * mapping can change without touching this package.
 *
 * The decision is designed to sit BELOW explicit overrides in the existing
 * heartbeat precedence (issue assigneeAdapterOverrides > wake-context profile
 * > this routing > agent primary config). Wiring into
 * resolveModelProfileApplication() is M2; callers pass the override state in
 * so the precedence is enforced here too and unit-testable.
 */

export const COMPLEXITY_MODEL_PROFILE_MAP: Record<IssueComplexity, ModelProfileKey> = {
  trivial: "cheap",
  standard: "standard",
  complex: "premium",
};

export function isIssueComplexity(value: unknown): value is IssueComplexity {
  return typeof value === "string" && (ISSUE_COMPLEXITIES as readonly string[]).includes(value);
}

export function complexityToModelProfileKey(complexity: unknown): ModelProfileKey | null {
  if (!isIssueComplexity(complexity)) return null;
  return COMPLEXITY_MODEL_PROFILE_MAP[complexity];
}

export type ModelRoutingSkipReason =
  | "no_complexity"
  | "explicit_issue_model"
  | "explicit_issue_profile"
  | "context_model_profile";

export interface ModelRoutingInput {
  /** Raw `issues.complexity` value (may be null/undefined/garbage). */
  complexity: unknown;
  /** Raw `issues.assigneeAdapterOverrides` (or null). */
  issueAdapterOverrides?: {
    modelProfile?: unknown;
    adapterConfig?: Record<string, unknown> | null;
  } | null;
  /**
   * Wake-context model profile (e.g. the status-only recovery "cheap" hint).
   * When present it always wins — routing must never upgrade a status-only
   * recovery run into a deliverable-model run, nor fight an explicit context.
   */
  contextModelProfile?: unknown;
}

export type ModelRoutingDecision =
  | {
    routed: false;
    skipReason: ModelRoutingSkipReason;
    rationale: string;
  }
  | {
    routed: true;
    complexity: IssueComplexity;
    modelProfile: ModelProfileKey;
    rationale: string;
  };

function isModelProfileKey(value: unknown): value is ModelProfileKey {
  return typeof value === "string" && (MODEL_PROFILE_KEYS as readonly string[]).includes(value);
}

/**
 * Decide the model-profile lane for a run from the issue's complexity.
 * Deterministic and side-effect free. Returns `routed: false` whenever a
 * higher-precedence signal exists — the caller then falls through to the
 * existing resolution behavior unchanged.
 */
export function decideModelRouting(input: ModelRoutingInput): ModelRoutingDecision {
  const overrides = input.issueAdapterOverrides ?? null;

  const explicitModel = overrides?.adapterConfig
    && typeof overrides.adapterConfig === "object"
    && typeof (overrides.adapterConfig as Record<string, unknown>).model === "string"
    && ((overrides.adapterConfig as Record<string, unknown>).model as string).trim().length > 0;
  if (explicitModel) {
    return {
      routed: false,
      skipReason: "explicit_issue_model",
      rationale: "Issue assigneeAdapterOverrides.adapterConfig.model is set; explicit model wins over complexity routing.",
    };
  }

  if (isModelProfileKey(overrides?.modelProfile)) {
    return {
      routed: false,
      skipReason: "explicit_issue_profile",
      rationale: `Issue assigneeAdapterOverrides.modelProfile="${overrides?.modelProfile}" is set; explicit profile wins over complexity routing.`,
    };
  }

  if (isModelProfileKey(input.contextModelProfile)) {
    return {
      routed: false,
      skipReason: "context_model_profile",
      rationale: `Wake context requested modelProfile="${input.contextModelProfile}" (e.g. status-only recovery); context wins over complexity routing.`,
    };
  }

  const profile = complexityToModelProfileKey(input.complexity);
  if (!profile || !isIssueComplexity(input.complexity)) {
    return {
      routed: false,
      skipReason: "no_complexity",
      rationale: "Issue has no valid complexity; falling through to existing model resolution.",
    };
  }

  return {
    routed: true,
    complexity: input.complexity,
    modelProfile: profile,
    rationale: `Issue complexity="${input.complexity}" routes to modelProfile="${profile}".`,
  };
}
