/**
 * Provider Routing Policy — Task-risk classification and fallback eligibility.
 *
 * Stage 0: types, classification logic, and eligibility evaluation only.
 * No live routing, no provider switching, no production behavior change.
 */

// ---------------------------------------------------------------------------
// Task-risk classification
// ---------------------------------------------------------------------------

export const TASK_RISK_CLASSES = [
  "safe_readonly",
  "monitoring",
  "reporting",
  "drafting",
  "governance",
  "infrastructure",
  "financial",
  "deployment",
] as const;

export type TaskRiskClass = (typeof TASK_RISK_CLASSES)[number];

const FALLBACK_ALLOWED_CLASSES = new Set<TaskRiskClass>([
  "safe_readonly",
  "monitoring",
  "reporting",
  "drafting",
]);

// ---------------------------------------------------------------------------
// Provider confidence levels
// ---------------------------------------------------------------------------

export const PROVIDER_CONFIDENCE_LEVELS = ["full", "degraded", "emergency_fallback"] as const;
export type ProviderConfidence = (typeof PROVIDER_CONFIDENCE_LEVELS)[number];

// ---------------------------------------------------------------------------
// Fallback provider configuration (provider-agnostic)
// ---------------------------------------------------------------------------

export interface FallbackProviderConfig {
  id: string;
  adapterType: string;
  displayName: string;
  envOverrides: Record<string, string>;
  modelId: string;
  credentialEnvKey: string;
  costMultiplier?: number;
}

// ---------------------------------------------------------------------------
// Policy configuration
// ---------------------------------------------------------------------------

export interface ProviderRoutingPolicy {
  enabled: boolean;
  stage: 0 | 1 | 2 | 3;
  allowedAgentNames: ReadonlySet<string>;
  deniedAgentRoles: ReadonlySet<string>;
  fallbackProvider: FallbackProviderConfig;
  maxFallbackSpendPerDayUsd: number;
  maxFallbackRunsPerHour: number;
  maxFallbackRunsPerDay: number;
  circuitBreakerCooldownMinutes: number;
}

const DEFAULT_ALLOWED_AGENT_NAMES = new Set(["trustscore", "watchdog", "content strategist"]);
const DEFAULT_DENIED_AGENT_ROLES = new Set(["ceo", "cto", "cfo", "security", "devops"]);

export const DEFAULT_FALLBACK_PROVIDER: FallbackProviderConfig = {
  id: "openrouter-deepseek",
  adapterType: "codex_local",
  displayName: "OpenRouter DeepSeek",
  envOverrides: {
    OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
  },
  modelId: "deepseek/deepseek-coder",
  credentialEnvKey: "OPENROUTER_API_KEY",
};

export function buildDefaultPolicy(
  overrides?: Partial<Pick<ProviderRoutingPolicy, "enabled" | "stage">>,
): ProviderRoutingPolicy {
  return {
    enabled: overrides?.enabled ?? false,
    stage: overrides?.stage ?? 0,
    allowedAgentNames: DEFAULT_ALLOWED_AGENT_NAMES,
    deniedAgentRoles: DEFAULT_DENIED_AGENT_ROLES,
    fallbackProvider: DEFAULT_FALLBACK_PROVIDER,
    maxFallbackSpendPerDayUsd: 5,
    maxFallbackRunsPerHour: 20,
    maxFallbackRunsPerDay: 100,
    circuitBreakerCooldownMinutes: 60,
  };
}

// ---------------------------------------------------------------------------
// Wake-reason pattern matching helpers
// ---------------------------------------------------------------------------

const GOVERNANCE_RE = /(?:^|[\s_-])(?:approval|governance|permission|policy)(?:[\s_-]|$)/i;
const DEPLOYMENT_RE = /(?:^|[\s_-])(?:deploy|release|rollout)(?:[\s_-]|$)/i;
const FINANCIAL_RE = /(?:^|[\s_-])(?:wallet|billing|budget|spend|payment|transfer)(?:[\s_-]|$)/i;
const MONITORING_RE = /(?:^|[\s_-])(?:monitor|heartbeat|liveness|watchdog)(?:[\s_-]|$)/i;
const REPORTING_RE = /(?:^|[\s_-])(?:score|trust|rank|evaluate)(?:[\s_-]|$)/i;
const DRAFTING_RE = /(?:^|[\s_-])(?:draft|content|write|compose)(?:[\s_-]|$)/i;

const READONLY_ROLES = new Set(["qa", "researcher"]);

// ---------------------------------------------------------------------------
// Task-risk classifier (fail-closed: unknown → governance)
// ---------------------------------------------------------------------------

export interface TaskClassificationContext {
  approvalId?: string | null;
  approvalStatus?: string | null;
  deploymentId?: string | null;
  executionTargetType?: string | null;
  executionTransport?: unknown;
  secretRef?: unknown;
  credential?: unknown;
}

export function classifyTaskRisk(
  agent: { role?: string | null; adapterConfig?: Record<string, unknown> | null },
  context: TaskClassificationContext,
  wakeReason: string | null | undefined,
): TaskRiskClass {
  const reason = wakeReason ?? "";

  // Priority 1-2: governance contexts
  if (context.approvalId || context.approvalStatus) return "governance";
  if (GOVERNANCE_RE.test(reason)) return "governance";

  // Priority 3-4: infrastructure / deployment
  if (context.deploymentId || context.executionTargetType === "ssh") return "infrastructure";
  if (context.executionTransport) return "infrastructure";
  if (DEPLOYMENT_RE.test(reason)) return "deployment";

  // Priority 5: dangerous adapter config → infrastructure
  const cfg = agent.adapterConfig ?? {};
  if (cfg.dangerouslySkipPermissions || cfg.dangerouslyBypassSandbox) return "infrastructure";

  // Priority 6: financial
  if (FINANCIAL_RE.test(reason)) return "financial";

  // Priority 7-9: safe categories
  if (MONITORING_RE.test(reason)) return "monitoring";
  if (REPORTING_RE.test(reason)) return "reporting";
  if (DRAFTING_RE.test(reason)) return "drafting";

  // Priority 10: read-only agent roles
  if (agent.role && READONLY_ROLES.has(agent.role.toLowerCase())) return "safe_readonly";

  // Default: fail closed — unclassified tasks denied fallback
  return "governance";
}

// ---------------------------------------------------------------------------
// "Never fallback" hard-block detection
// ---------------------------------------------------------------------------

const HARD_BLOCK_WAKE_RE =
  /(?:^|[\s_-])(?:wallet|payment|transfer|deploy|permission|escalat|grant|governance|policy|approval|credential)/i;

export function isHardBlockedContext(
  context: TaskClassificationContext,
  wakeReason: string | null | undefined,
  agent: { adapterConfig?: Record<string, unknown> | null },
): { blocked: boolean; reason: string | null } {
  if (context.approvalId || context.approvalStatus) {
    return { blocked: true, reason: "board_approval" };
  }
  if (context.secretRef || context.credential) {
    return { blocked: true, reason: "credential_handling" };
  }
  if (context.executionTargetType === "ssh" || context.executionTransport) {
    return { blocked: true, reason: "ssh_execution" };
  }
  if (context.deploymentId) {
    return { blocked: true, reason: "deployment_task" };
  }
  const cfg = agent.adapterConfig ?? {};
  if (cfg.dangerouslyBypassSandbox) {
    return { blocked: true, reason: "infrastructure_mutation" };
  }
  if (wakeReason && HARD_BLOCK_WAKE_RE.test(wakeReason)) {
    return { blocked: true, reason: "wake_reason_hard_blocked" };
  }
  return { blocked: false, reason: null };
}

// ---------------------------------------------------------------------------
// Eligibility evaluation (all gates)
// ---------------------------------------------------------------------------

export interface EligibilityResult {
  eligible: boolean;
  reason: string;
  taskRiskClass: TaskRiskClass;
  providerConfidence: ProviderConfidence;
}

export function evaluateProviderFallbackEligibility(
  agent: {
    name?: string | null;
    role?: string | null;
    adapterConfig?: Record<string, unknown> | null;
  },
  context: TaskClassificationContext,
  wakeReason: string | null | undefined,
  policy: ProviderRoutingPolicy,
): EligibilityResult {
  const taskRiskClass = classifyTaskRisk(agent, context, wakeReason);
  const base = { taskRiskClass, providerConfidence: "full" as ProviderConfidence };

  // Gate 3: hard-blocked contexts (checked first — overrides everything)
  const hardBlock = isHardBlockedContext(context, wakeReason, agent);
  if (hardBlock.blocked) {
    return { ...base, eligible: false, reason: `context_hard_blocked:${hardBlock.reason}` };
  }

  // Gate 1: agent eligibility — role denylist
  if (agent.role && policy.deniedAgentRoles.has(agent.role.toLowerCase())) {
    return { ...base, eligible: false, reason: `agent_role_denied:${agent.role}` };
  }

  // Gate 1: agent eligibility — name allowlist
  const agentName = (agent.name ?? "").toLowerCase().trim();
  if (!policy.allowedAgentNames.has(agentName)) {
    return { ...base, eligible: false, reason: "agent_not_in_allowlist" };
  }

  // Gate 2: task-risk classification
  if (!FALLBACK_ALLOWED_CLASSES.has(taskRiskClass)) {
    return { ...base, eligible: false, reason: `task_risk_denied:${taskRiskClass}` };
  }

  return { ...base, eligible: true, reason: "eligible" };
}
