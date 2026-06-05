/** LLM orchestration core — public surface.
 *
 *  A pure, tenant-agnostic router: `(TaskDescriptor, RouterDependencies) →
 *  RoutingDecision`. The routing grid is injected by the caller via
 *  `RouterDependencies.policy`; the core ships an empty `DEFAULT_POLICY` plus a
 *  domain-neutral safety overlay (sensitivity floor, second-pass + sign-off
 *  gates). See `example-policy.ts` for a reference routing table. */

export {
  type ComplexityClass,
  type Engine,
  type EngineRole,
  type ModelSelection,
  type RouterDependencies,
  type RoutingDecision,
  type Sensitivity,
  type TaskDescriptor,
  type TaskType,
  type TelemetryEvent,
  type TelemetrySink,
  type TierLevel,
  LONG_CONTEXT_THRESHOLD_TOKENS,
  TELEMETRY_SCHEMA_VERSION,
} from './types.js';

export { route } from './router.js';
export { RouterConfigError, RouterPolicyViolationError } from './errors.js';

export {
  type AgentPolicy,
  type AgentPolicyComplexityHint,
  type RoutingRule,
  DEFAULT_POLICY,
  SENSITIVITY_COMPLEXITY_FLOOR,
  agentPolicyComplexityToClass,
  buildRuleIndex,
  getRoutingRule,
  maxComplexity,
  requiresHumanSignOff,
  requiresSecondPass,
} from './policy.js';

export { MODEL_CATALOG, selectModel } from './models.js';
export {
  CATALOG_VERSION as PRICING_CATALOG_VERSION,
  estimateInputCost,
  pricePerMillion,
} from './pricing.js';

export {
  type GeminiContextWindowReport,
  GEMINI_AVAILABILITY_ENV_KEY,
  describeGeminiContextWindow,
  geminiRequiresClaudeReasoningPass,
  isGeminiAvailable,
  shouldPromoteToGeminiLongContext,
} from './gemini.js';

export {
  type TelemetryLogger,
  CompositeTelemetrySink,
  InMemoryTelemetrySink,
  LoggerTelemetrySink,
  decisionToTelemetry,
  noopTelemetrySink,
} from './telemetry.js';

export { EXAMPLE_POLICY } from './example-policy.js';
