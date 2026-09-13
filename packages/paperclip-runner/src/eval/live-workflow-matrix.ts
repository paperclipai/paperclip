import { createHash } from "node:crypto";

import type {
  RunnerWorkflowEvalCase,
  RunnerWorkflowObservation,
  RunnerWorkflowProvider,
} from "./workflow-contracts.js";
import { RUNNER_WORKFLOW_CATALOG } from "./workflow-catalog.js";

export const RUNNER_LIVE_CANDIDATE_SCHEMA =
  "paperclip.runner.live-eval-candidate.v1" as const;
export const RUNNER_LIVE_SCHEDULE_SCHEMA =
  "paperclip.runner.live-eval-schedule.v1" as const;

export function parseRunnerLiveCampaignCostLimit(
  value: string | undefined,
): number {
  const parsed = Number(value ?? "12");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      "PAPERCLIP_EVAL_MAX_CAMPAIGN_COST_USD must be a positive finite number",
    );
  }
  return parsed;
}

export function runnerLiveRotationWeek(generatedAt: string): number {
  const epochMs = Date.parse(generatedAt);
  if (!Number.isFinite(epochMs)) {
    throw new Error("Runner live rotation requires a valid generated-at time");
  }
  const epochWeek = Math.floor(epochMs / (7 * 86_400_000));
  return ((epochWeek % 7) + 7) % 7;
}

export type RunnerLiveAdapter =
  "codex_app_server" | "opencode_server" | "acpx_runtime";
export type RunnerLiveTier = "strong" | "inexpensive";

export interface RunnerLiveEvalCandidate {
  schema: typeof RUNNER_LIVE_CANDIDATE_SCHEMA;
  id: string;
  slotId: string;
  adapter: RunnerLiveAdapter;
  provider: RunnerWorkflowProvider;
  model: string;
  tier: RunnerLiveTier;
  reasoningEffort?: string;
  qualification: { requiredEnvironment: string[]; profile?: string };
  budget: {
    maxLatencyMs: number;
    maxAttempts: number;
    maxCostUsd: number;
    maxTotalTokens: number;
  };
}

interface RunnerLiveCandidateSlot {
  id: string;
  candidates: readonly RunnerLiveEvalCandidate[];
}

function candidate(
  input: Omit<RunnerLiveEvalCandidate, "schema">,
): RunnerLiveEvalCandidate {
  return Object.freeze({ schema: RUNNER_LIVE_CANDIDATE_SCHEMA, ...input });
}

export const RUNNER_LIVE_CANDIDATE_SLOTS: readonly RunnerLiveCandidateSlot[] =
  Object.freeze([
    {
      id: "codex-strong",
      candidates: [
        candidate({
          id: "codex-luna",
          slotId: "codex-strong",
          adapter: "codex_app_server",
          provider: "codex",
          model: "gpt-5.6-luna",
          tier: "strong",
          reasoningEffort: "medium",
          qualification: { requiredEnvironment: ["OPENAI_API_KEY"] },
          budget: {
            maxLatencyMs: 180_000,
            maxAttempts: 3,
            maxCostUsd: 1.5,
            maxTotalTokens: 100_000,
          },
        }),
      ],
    },
    {
      id: "opencode-strong",
      candidates: [
        candidate({
          id: "opencode-kimi",
          slotId: "opencode-strong",
          adapter: "opencode_server",
          provider: "opencode",
          model: "openrouter/moonshotai/kimi-k2.5",
          tier: "strong",
          qualification: {
            requiredEnvironment: ["OPENROUTER_API_KEY"],
            profile: "openrouter",
          },
          budget: {
            maxLatencyMs: 180_000,
            maxAttempts: 3,
            maxCostUsd: 0.8,
            maxTotalTokens: 100_000,
          },
        }),
        candidate({
          id: "opencode-glm",
          slotId: "opencode-strong",
          adapter: "opencode_server",
          provider: "opencode",
          model: "openrouter/z-ai/glm-4.6",
          tier: "strong",
          qualification: {
            requiredEnvironment: ["OPENROUTER_API_KEY"],
            profile: "openrouter",
          },
          budget: {
            maxLatencyMs: 180_000,
            maxAttempts: 3,
            maxCostUsd: 0.8,
            maxTotalTokens: 100_000,
          },
        }),
      ],
    },
    {
      id: "opencode-inexpensive",
      candidates: [
        candidate({
          id: "opencode-gpt-oss",
          slotId: "opencode-inexpensive",
          adapter: "opencode_server",
          provider: "opencode",
          model: "openrouter/openai/gpt-oss-20b",
          tier: "inexpensive",
          qualification: {
            requiredEnvironment: ["OPENROUTER_API_KEY"],
            profile: "openrouter",
          },
          budget: {
            maxLatencyMs: 150_000,
            maxAttempts: 3,
            maxCostUsd: 0.2,
            maxTotalTokens: 64_000,
          },
        }),
        candidate({
          id: "opencode-glm-flash",
          slotId: "opencode-inexpensive",
          adapter: "opencode_server",
          provider: "opencode",
          model: "openrouter/z-ai/glm-4.5-air",
          tier: "inexpensive",
          qualification: {
            requiredEnvironment: ["OPENROUTER_API_KEY"],
            profile: "openrouter",
          },
          budget: {
            maxLatencyMs: 150_000,
            maxAttempts: 3,
            maxCostUsd: 0.2,
            maxTotalTokens: 64_000,
          },
        }),
      ],
    },
    {
      id: "acpx-claude",
      candidates: [
        candidate({
          id: "acpx-claude-sonnet",
          slotId: "acpx-claude",
          adapter: "acpx_runtime",
          provider: "acpx",
          model: "claude-sonnet-5",
          tier: "strong",
          qualification: {
            requiredEnvironment: ["ANTHROPIC_API_KEY"],
            profile: "claude",
          },
          budget: {
            maxLatencyMs: 180_000,
            maxAttempts: 3,
            maxCostUsd: 1.5,
            maxTotalTokens: 100_000,
          },
        }),
      ],
    },
    {
      id: "acpx-codex",
      candidates: [
        candidate({
          id: "acpx-codex-sol",
          slotId: "acpx-codex",
          adapter: "acpx_runtime",
          provider: "acpx",
          model: "gpt-5.6-sol",
          tier: "strong",
          reasoningEffort: "medium",
          qualification: {
            requiredEnvironment: ["OPENAI_API_KEY"],
            profile: "codex",
          },
          budget: {
            maxLatencyMs: 180_000,
            maxAttempts: 3,
            maxCostUsd: 1.5,
            maxTotalTokens: 100_000,
          },
        }),
      ],
    },
  ]);

const CORE_LIVE_REPEAT_CASE_IDS = new Set<RunnerWorkflowEvalCase["id"]>([
  "final-response",
  "rich-activity",
  "governed-interaction",
  "completion-robustness",
]);

export interface RunnerLiveScheduleEntry {
  executionId: string;
  caseId: RunnerWorkflowEvalCase["id"];
  candidateId: string;
  slotId: string;
  repetition: number;
  providerTrace: "raw";
  budget: RunnerLiveEvalCandidate["budget"];
}

export interface RunnerLiveEvalSchedule {
  schema: typeof RUNNER_LIVE_SCHEDULE_SCHEMA;
  seed: string;
  rotationDay: number;
  generatedAt: string;
  candidates: RunnerLiveEvalCandidate[];
  entries: RunnerLiveScheduleEntry[];
  expectedExecutions: number;
}

export interface RunnerLiveEvalSelection {
  candidateIds?: readonly string[];
  caseIds?: readonly string[];
  limit?: number;
}

/** Selects a stable paid subset without weakening validation of the full schedule. */
export function selectRunnerLiveEvalSchedule(
  schedule: RunnerLiveEvalSchedule,
  selection: RunnerLiveEvalSelection,
): RunnerLiveEvalSchedule {
  const candidateIds = new Set(selection.candidateIds ?? []);
  const caseIds = new Set(selection.caseIds ?? []);
  for (const id of candidateIds) {
    if (!schedule.candidates.some((candidate) => candidate.id === id)) {
      throw new Error(`unknown Runner live eval candidate: ${id}`);
    }
  }
  const scheduledCaseIds = new Set(
    schedule.entries.map((entry) => entry.caseId),
  );
  for (const id of caseIds) {
    if (!scheduledCaseIds.has(id as RunnerWorkflowEvalCase["id"])) {
      throw new Error(`unknown Runner live eval case: ${id}`);
    }
  }
  if (
    selection.limit !== undefined &&
    (!Number.isSafeInteger(selection.limit) || selection.limit <= 0)
  ) {
    throw new Error(
      "Runner live eval selection limit must be a positive integer",
    );
  }
  let entries = schedule.entries.filter(
    (entry) =>
      (candidateIds.size === 0 || candidateIds.has(entry.candidateId)) &&
      (caseIds.size === 0 || caseIds.has(entry.caseId)),
  );
  if (selection.limit !== undefined)
    entries = entries.slice(0, selection.limit);
  if (entries.length === 0) {
    throw new Error(
      "Runner live eval selection matched no scheduled executions",
    );
  }
  const selectedCandidateIds = new Set(
    entries.map((entry) => entry.candidateId),
  );
  return {
    ...schedule,
    candidates: schedule.candidates.filter((candidate) =>
      selectedCandidateIds.has(candidate.id),
    ),
    entries,
    expectedExecutions: entries.length,
  };
}

export function assertRunnerLiveCandidateManifest(): void {
  const slots = RUNNER_LIVE_CANDIDATE_SLOTS.map((slot) => slot.id);
  const candidates = RUNNER_LIVE_CANDIDATE_SLOTS.flatMap(
    (slot) => slot.candidates,
  );
  const ids = candidates.map((entry) => entry.id);
  if (new Set(slots).size !== 5 || new Set(ids).size !== ids.length) {
    throw new Error(
      "Runner live candidate slots or candidate ids are not unique",
    );
  }
  const serialized = JSON.stringify(candidates);
  if (
    /\b(?:sk-[A-Za-z0-9]{16,}|Bearer\s+\S{16,}|AKIA[0-9A-Z]{16})\b/.test(
      serialized,
    )
  ) {
    throw new Error(
      "Runner live candidate manifest contains secret-shaped data",
    );
  }
  for (const slot of RUNNER_LIVE_CANDIDATE_SLOTS) {
    if (
      slot.candidates.some(
        (entry) => entry.slotId !== slot.id || entry.model.trim().length === 0,
      )
    ) {
      throw new Error(`Runner live candidate slot ${slot.id} is invalid`);
    }
  }
}

export function resolvedNightlyCandidates(
  rotationDay: number,
): RunnerLiveEvalCandidate[] {
  assertRunnerLiveCandidateManifest();
  const normalizedDay = ((rotationDay % 7) + 7) % 7;
  return RUNNER_LIVE_CANDIDATE_SLOTS.map(
    (slot) => slot.candidates[normalizedDay % slot.candidates.length]!,
  );
}

function digestId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Builds the stable 40-execution pairwise schedule for one weekly rotation. */
export function buildRunnerLiveEvalSchedule(input: {
  seed: string;
  rotationDay: number;
  generatedAt?: string;
  cases?: readonly RunnerWorkflowEvalCase[];
}): RunnerLiveEvalSchedule {
  const cases = input.cases ?? RUNNER_WORKFLOW_CATALOG;
  const candidates = resolvedNightlyCandidates(input.rotationDay);
  const entries: RunnerLiveScheduleEntry[] = [];
  for (const [caseIndex, evalCase] of cases.entries()) {
    const firstIndex = (caseIndex + input.rotationDay) % candidates.length;
    const secondIndex = (firstIndex + 3) % candidates.length;
    for (const candidateIndex of [firstIndex, secondIndex]) {
      const resolved = candidates[candidateIndex]!;
      const repetitions = CORE_LIVE_REPEAT_CASE_IDS.has(evalCase.id) ? 3 : 1;
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const identity = `${input.seed}:${input.rotationDay}:${evalCase.id}:${resolved.id}:${repetition}`;
        entries.push({
          executionId: `rwe-${digestId(identity)}`,
          caseId: evalCase.id,
          candidateId: resolved.id,
          slotId: resolved.slotId,
          repetition,
          providerTrace: "raw",
          budget: resolved.budget,
        });
      }
    }
  }
  return {
    schema: RUNNER_LIVE_SCHEDULE_SCHEMA,
    seed: input.seed,
    rotationDay: ((input.rotationDay % 7) + 7) % 7,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    candidates,
    entries,
    expectedExecutions: entries.length,
  };
}

export interface RunnerLiveScheduleCoverage {
  everySlotNightly: boolean;
  everyConcreteCandidateInRotation: boolean;
  everyWorkflowCoversEverySlot: boolean;
  strongAndInexpensiveNightly: boolean;
}

export function runnerLiveScheduleCoverage(
  seed = "runner-live-seven-week-v1",
): RunnerLiveScheduleCoverage {
  const schedules = Array.from({ length: 7 }, (_, rotationDay) =>
    buildRunnerLiveEvalSchedule({
      seed,
      rotationDay,
      generatedAt: `2026-08-${String(24 + rotationDay).padStart(2, "0")}T00:00:00.000Z`,
    }),
  );
  const allCandidateIds = new Set(
    RUNNER_LIVE_CANDIDATE_SLOTS.flatMap((slot) =>
      slot.candidates.map((entry) => entry.id),
    ),
  );
  const seenCandidateIds = new Set(
    schedules.flatMap((schedule) =>
      schedule.entries.map((entry) => entry.candidateId),
    ),
  );
  const everySlotNightly = schedules.every(
    (schedule) =>
      new Set(schedule.entries.map((entry) => entry.slotId)).size ===
      RUNNER_LIVE_CANDIDATE_SLOTS.length,
  );
  const everyWorkflowCoversEverySlot = RUNNER_WORKFLOW_CATALOG.every(
    (evalCase) => {
      const slots = new Set(
        schedules.flatMap((schedule) =>
          schedule.entries
            .filter((entry) => entry.caseId === evalCase.id)
            .map((entry) => entry.slotId),
        ),
      );
      return slots.size === RUNNER_LIVE_CANDIDATE_SLOTS.length;
    },
  );
  const strongAndInexpensiveNightly = schedules.every((schedule) => {
    const selected = schedule.candidates.filter((candidate) =>
      schedule.entries.some((entry) => entry.candidateId === candidate.id),
    );
    return (
      selected.some((candidate) => candidate.tier === "strong") &&
      selected.some((candidate) => candidate.tier === "inexpensive")
    );
  });
  return {
    everySlotNightly,
    everyConcreteCandidateInRotation: [...allCandidateIds].every((id) =>
      seenCandidateIds.has(id),
    ),
    everyWorkflowCoversEverySlot,
    strongAndInexpensiveNightly,
  };
}

export class RunnerWorkflowInfrastructureError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "RunnerWorkflowInfrastructureError";
  }
}

export async function executeRunnerLiveSchedule(
  schedule: RunnerLiveEvalSchedule,
  execute: (
    entry: RunnerLiveScheduleEntry,
    candidate: RunnerLiveEvalCandidate,
  ) => Promise<RunnerWorkflowObservation>,
  onInfrastructureFailure?: (
    entry: RunnerLiveScheduleEntry,
    candidate: RunnerLiveEvalCandidate,
    error: RunnerWorkflowInfrastructureError,
  ) => RunnerWorkflowObservation | Promise<RunnerWorkflowObservation>,
): Promise<RunnerWorkflowObservation[]> {
  const results: RunnerWorkflowObservation[] = [];
  for (const entry of schedule.entries) {
    const resolved = schedule.candidates.find(
      (candidate) => candidate.id === entry.candidateId,
    );
    if (!resolved)
      throw new Error(
        `schedule references unknown candidate ${entry.candidateId}`,
      );
    let infrastructureAttempts = 0;
    while (true) {
      try {
        results.push(await execute(entry, resolved));
        break;
      } catch (error) {
        if (!(error instanceof RunnerWorkflowInfrastructureError)) {
          throw error;
        }
        if (!error.retryable || infrastructureAttempts >= 1) {
          if (onInfrastructureFailure === undefined) throw error;
          results.push(await onInfrastructureFailure(entry, resolved, error));
          break;
        }
        infrastructureAttempts += 1;
      }
    }
  }
  return results;
}

export const RUNNER_CHAOS_SCENARIOS: readonly {
  id: string;
  lane: "chaos";
  fault:
    | "restart"
    | "duplicate_delivery"
    | "trace_interruption"
    | "trace_truncation"
    | "stale_checkpoint"
    | "retry_exhaustion"
    | "interaction_timeout"
    | "wake_race";
  expectedInvariant: string;
}[] = Object.freeze([
  {
    id: "chaos-restart",
    lane: "chaos",
    fault: "restart",
    expectedInvariant: "one resumable execution owns finalization",
  },
  {
    id: "chaos-duplicate-delivery",
    lane: "chaos",
    fault: "duplicate_delivery",
    expectedInvariant: "semantic effects are idempotent",
  },
  {
    id: "chaos-trace-interruption",
    lane: "chaos",
    fault: "trace_interruption",
    expectedInvariant: "run success is independent of trace upload",
  },
  {
    id: "chaos-trace-truncation",
    lane: "chaos",
    fault: "trace_truncation",
    expectedInvariant: "trace is marked truncated without PRP backpressure",
  },
  {
    id: "chaos-stale-checkpoint",
    lane: "chaos",
    fault: "stale_checkpoint",
    expectedInvariant: "terminal turns cannot remain active",
  },
  {
    id: "chaos-retry-exhaustion",
    lane: "chaos",
    fault: "retry_exhaustion",
    expectedInvariant: "board recovery owns the bounded terminal",
  },
  {
    id: "chaos-interaction-timeout",
    lane: "chaos",
    fault: "interaction_timeout",
    expectedInvariant: "governed wait remains visible and owned",
  },
  {
    id: "chaos-wake-race",
    lane: "chaos",
    fault: "wake_race",
    expectedInvariant: "one rich parent wake wins coalescing",
  },
]);
