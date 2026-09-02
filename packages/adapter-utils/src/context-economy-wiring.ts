// Runtime wiring for Paperclip context economy (KOMAA-184).
//
// Glues the canonical shared context-economy modules
// (packages/shared/src/context-economy) into the adapter-utils adapter domain
// so the run-start MCP selection, tool-schema telemetry, first-model token
// telemetry, prompt-section composition, and context-budget gating are applied
// at the real adapter call sites without duplicating their decision logic.

import type {
  AdapterRuntimeMcpServer,
  UsageSummary,
} from "./types.js";
import {
  narrowEagerMcpServers,
  deriveToolSchemaTelemetry,
  captureFirstModelTokenTelemetry,
  decomposePromptChars,
  shouldCompact,
  selectInstructionSections,
  selectHeartbeatSections,
  type AgentRole,
  type TaskCategory,
  type ToolSchemaTelemetry,
  type FirstModelTokenTelemetry,
  type CompactionDecision,
  type ContextBudgetTier,
  type InstructionSection,
  type HeartbeatSection,
  type PromptCharsDecomposition,
} from "@paperclipai/shared";

export interface NarrowRuntimeMcpResult {
  servers: AdapterRuntimeMcpServer[];
  droppedUnauthorized: string[];
  droppedInactive: string[];
}

/**
 * Narrow the managed MCP servers handed to the agent runtime to the eager set
 * the canonical role profile authorizes for the run's task category. When no
 * `role` is classified (legacy call sites / non-Paperclip control plane) the
 * servers are returned unchanged so existing behavior is preserved.
 */
export function narrowRuntimeMcpServers(
  servers: AdapterRuntimeMcpServer[],
  opts: { role?: string; taskCategory?: string } = {},
): NarrowRuntimeMcpResult {
  if (!opts.role) {
    return { servers, droppedUnauthorized: [], droppedInactive: [] };
  }
  const candidates = servers.map((s) => ({ name: s.name }));
  const narrowed = narrowEagerMcpServers({
    role: (opts.role as AgentRole) ?? "engineer",
    taskCategory: (opts.taskCategory as TaskCategory) ?? "technical",
    candidates,
  });
  const dropped = new Set<string>([
    ...narrowed.droppedUnauthorized,
    ...narrowed.droppedInactive,
  ]);
  return {
    servers: servers.filter((s) => !dropped.has(s.name)),
    droppedUnauthorized: narrowed.droppedUnauthorized,
    droppedInactive: narrowed.droppedInactive,
  };
}

export interface RuntimeToolTelemetryOptions {
  /** Whole generated runtime/MCP config serialized size in chars, if known. */
  serializedConfigChars?: number;
}

/**
 * Derive tool-schema context telemetry from the (already narrowed) managed MCP
 * servers Paperclip deterministically injects. Provider-native schemas that
 * Paperclip cannot enumerate remain the caller's responsibility; here every
 * injected server is a known managed source so the measurement is `derived`.
 */
export function deriveRuntimeToolTelemetry(
  servers: AdapterRuntimeMcpServer[],
  opts: RuntimeToolTelemetryOptions = {},
): ToolSchemaTelemetry {
  return deriveToolSchemaTelemetry({
    tools: servers.map((s) => ({ name: s.name, source: "managed" as const })),
    serializedConfigChars: opts.serializedConfigChars,
  });
}

export interface RuntimeFirstModelTokenOptions {
  usage?: UsageSummary | null;
  promptChars?: PromptCharsDecomposition;
  measurementSource?: "provider" | "runtime" | "unsupported";
  reason?: string;
}

/**
 * Capture first-model-request token telemetry from the run usage Paperclip
 * observes. When the runtime did not report usage we keep null + explicit
 * reason and never invent token counts from characters.
 */
export function captureRuntimeFirstModelTokenTelemetry(
  opts: RuntimeFirstModelTokenOptions,
): FirstModelTokenTelemetry {
  return captureFirstModelTokenTelemetry({
    firstModelInputTokens: opts.usage?.inputTokens ?? null,
    firstModelCachedInputTokens: opts.usage?.cachedInputTokens ?? null,
    measurementSource: opts.measurementSource,
    reason: opts.reason,
    promptChars: opts.promptChars ?? decomposePromptChars({}),
  });
}

export interface RuntimePromptSectionSelection {
  instructionSections: InstructionSection[];
  heartbeatSections: HeartbeatSection[];
}

/**
 * Paperclip-controlled role/heartbeat prompt section selection. The external
 * baseline instructions / heartbeat text are NOT duplicated here; this returns
 * the category-gated section set so the control plane injects only the relevant
 * pieces (mandatory contract always, product/UI/API/branding only for UI/infra
 * categories, rare recovery only on a restored run).
 */
export function selectRuntimePromptSections(opts: {
  role?: string;
  taskCategory?: string;
  recovery?: boolean;
} = {}): RuntimePromptSectionSelection {
  return {
    instructionSections: selectInstructionSections({
      role: (opts.role as AgentRole) ?? "engineer",
      taskCategory: (opts.taskCategory as TaskCategory) ?? "technical",
    }),
    heartbeatSections: selectHeartbeatSections({
      taskCategory: (opts.taskCategory as TaskCategory) ?? "technical",
      recovery: opts.recovery,
    }),
  };
}

export interface RuntimeContextBudgetOptions {
  tier?: ContextBudgetTier;
  turns: number;
  promptChars?: number;
  firstModelInputTokens?: number | null;
}

/**
 * Evaluate the hard context budget / compaction gate at a real call site
 * (resume / continuation scheduler). Reuses the KOMAA-167 run budget tiers and
 * the hard token/chars ceiling; compaction is recommended BEFORE another full
 * replay would breach the ceiling.
 */
export function evaluateRuntimeContextBudget(
  opts: RuntimeContextBudgetOptions,
): CompactionDecision {
  return shouldCompact({
    tier: opts.tier ?? "normal",
    turns: opts.turns,
    promptChars: opts.promptChars,
    firstModelInputTokens: opts.firstModelInputTokens ?? null,
  });
}
