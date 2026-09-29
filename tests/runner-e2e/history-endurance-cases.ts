import type { RunnerTaskFixture } from "./types.js";

export function enduranceMarker(nonce: string, round: number) {
  return `HISTORY${nonce.replace(/[^a-z0-9]/gi, "")}ROUND${round}END`;
}
export function enduranceOutput(nonce: string, round: number) {
  return enduranceMarker(nonce, round).repeat(1024);
}
export function endurancePrompt(nonce: string, round: number, activeRestart = false) {
  const marker = enduranceMarker(nonce, round);
  return `Run this diagnostic using your shell tool with yield_time_ms set to 1000 and allowing at least 30000 output tokens: sleep ${activeRestart ? 45 : 3}; i=0; diagnostic=''; while [ "$i" -lt 1024 ]; do diagnostic="$diagnostic"'${marker}'; i=$((i+1)); done; printf '%s' "$diagnostic". It prints the reference exactly 1024 times without a trailing newline in one shell write. Then ${round === 0 ? "create" : "read and update"} the task document with key history-ledger. ${round === 0 ? "Its body must be exactly the reference below." : "Preserve every existing line and append the reference below exactly once as a new line."} Reference: ${marker}. Keep this as the only task document, with no headings or commentary in its body. Complete this task after saving the document. Do not create child tasks, files, plans, or questions.`;
}

export const historyEnduranceTasks: readonly RunnerTaskFixture[] = [
  { id: "smoke", rounds: 3, intervalMs: 30_000, restartEvery: 1 },
  { id: "active-restart", rounds: 2, intervalMs: 30_000, restartEvery: 1, activeRestartRound: 0 },
  { id: "72h", rounds: 73, intervalMs: 60 * 60_000, restartEvery: 6 },
].map(({ id, rounds, intervalMs, restartEvery, activeRestartRound }) => ({
  id, label: `History endurance ${id}`, groups: [], workMode: "standard", flow: "history_endurance",
  expectedRunCount: rounds, automaticRetry: false,
  historyEndurance: { rounds, intervalMs, restartEvery, ...(activeRestartRound === undefined ? {} : { activeRestartRound }) },
  attemptTimeoutMs: {
    local: (rounds - 1) * intervalMs + rounds * 10 * 60_000,
    daytona: (rounds - 1) * intervalMs + rounds * 10 * 60_000,
  },
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `History endurance ${id} ${nonce}`,
  buildPrompt: nonce => endurancePrompt(nonce, 0, activeRestartRound === 0),
  buildVisibleMarker: nonce => enduranceMarker(nonce, rounds - 1),
  buildMatchers: () => [],
}));
