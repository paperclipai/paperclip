import { readFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_SLOTS_FILE, queueWaitFairnessFrom, slotFreeFrom, type AgentSlots, type QueueWaitFairness } from "./agent-slots.js";
import { withChildWaits } from "./child-wait.js";
import { continuedRunIds } from "./follow-up-delivery.js";
import type { WakeEvidenceFile } from "./staging-mix-retry.js";
import type { StagingMixOptions } from "./staging-mix.js";
import type { RunWake, TaskRecord } from "./types.js";
import { declaredQueueBoundMs, universalBounds, type SlotFree, type UniversalBounds } from "./universal.js";

export interface WaveGradeInputs {
  queue: { bounds: UniversalBounds; slotFree: SlotFree; queueWait: QueueWaitFairness };
  slotEvidence: boolean;
  prepare(taskId: string, record: TaskRecord): Promise<TaskRecord>;
}

const readJson = async <T>(file: string): Promise<T | null> => readFile(file, "utf8").then(text => JSON.parse(text) as T).catch(() => null);

export async function loadWaveGradeInputs(waveDir: string, mix: Pick<StagingMixOptions, "runs" | "queue" | "turnMinutes"> | undefined,
  env: NodeJS.ProcessEnv = process.env): Promise<WaveGradeInputs> {
  const slots = await readJson<AgentSlots>(path.join(waveDir, "wake-evidence", AGENT_SLOTS_FILE));
  const declaredQueuedMs = declaredQueueBoundMs(mix);
  const bounds = { ...universalBounds(env), ...(declaredQueuedMs === undefined ? {} : { declaredQueuedMs }) };
  return {
    queue: { bounds, slotFree: slotFreeFrom(slots), queueWait: queueWaitFairnessFrom(slots) },
    slotEvidence: slots !== null,
    prepare: async (taskId, record) => {
      const evidence = await readJson<WakeEvidenceFile>(path.join(waveDir, "wake-evidence", `${taskId}.json`));
      const prepared = withChildWaits(record, evidence);
      return evidence ? { ...prepared, runWakes: runWakesFrom(evidence) } : prepared;
    },
  };
}

export function runWakesFrom(evidence: WakeEvidenceFile): Record<string, RunWake> {
  const wakes = new Map((evidence.wakes ?? []).map(wake => [wake.id, wake]));
  return Object.fromEntries((evidence.runs ?? []).flatMap(run => {
    if (!run.runId) return [];
    const wake = run.wakeupRequestId ? wakes.get(run.wakeupRequestId) : undefined;
    const context = run.contextSnapshot && typeof run.contextSnapshot === "object" ? run.contextSnapshot as Record<string, unknown> : {};
    const wakeReason = typeof context.wakeReason === "string" ? context.wakeReason : wake?.reason ?? null;
    return [[run.runId, { wakeReason, continuesRunIds: continuedRunIds(run, wake) }]];
  }));
}
