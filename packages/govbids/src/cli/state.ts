import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { PipelineState } from "../core/types.js";

const STATE_DIR = join(import.meta.dirname ?? ".", "../../data");
const STATE_FILE = join(STATE_DIR, ".state.json");

function defaultState(): PipelineState {
  const now = new Date();
  return {
    lastRunDate: null,
    lastCapturedDate: null,
    monthlyApiCallsUsed: 0,
    monthlyApiCallsResetDate: new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      1,
    ).toISOString(),
  };
}

export async function loadState(): Promise<PipelineState> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    const state = JSON.parse(raw) as PipelineState;

    // Check if we need to reset the monthly quota
    if (new Date(state.monthlyApiCallsResetDate) <= new Date()) {
      state.monthlyApiCallsUsed = 0;
      const now = new Date();
      state.monthlyApiCallsResetDate = new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        1,
      ).toISOString();
    }

    return state;
  } catch {
    return defaultState();
  }
}

export async function saveState(state: PipelineState): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

export function getStateDir(): string {
  return STATE_DIR;
}
