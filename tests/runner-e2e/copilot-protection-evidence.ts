import { readFile } from "node:fs/promises";
import type { CopilotToolNotice } from "./copilot-evidence.js";

/** A tool origin exists regardless of the first status emitted by the provider. */
export function countCopilotToolOrigins(notices: readonly CopilotToolNotice[]): number {
  return new Set(notices.filter(n => n.stage === "tool").map(n => JSON.stringify([n.runId, n.sessionId, n.turnId, n.toolCallId]))).size;
}

/** Re-read independently after cleanup; a pre-cleanup value is not evidence. */
export async function readCopilotMarkerAfterCleanup(close: () => Promise<void>, path: string, expected: string): Promise<boolean> {
  await close();
  try { return await readFile(path, "utf8") === expected; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
