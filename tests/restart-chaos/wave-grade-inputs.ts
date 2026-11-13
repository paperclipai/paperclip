import { readFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_SLOTS_FILE, slotFreeFrom, type AgentSlots } from "./agent-slots.js";
import { withChildWaits } from "./child-wait.js";
import type { WakeEvidenceFile } from "./staging-mix-retry.js";
import type { StagingMixOptions } from "./staging-mix.js";
import type { TaskRecord } from "./types.js";
import { declaredQueueBoundMs, universalBounds, type SlotFree, type UniversalBounds } from "./universal.js";

export interface WaveGradeInputs {
  queue: { bounds: UniversalBounds; slotFree: SlotFree };
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
    queue: { bounds, slotFree: slotFreeFrom(slots) },
    slotEvidence: slots !== null,
    prepare: async (taskId, record) => withChildWaits(record, await readJson<WakeEvidenceFile>(path.join(waveDir, "wake-evidence", `${taskId}.json`))),
  };
}
