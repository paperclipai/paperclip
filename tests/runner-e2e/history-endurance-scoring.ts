import { createHash } from "node:crypto";
import { enduranceMarker, enduranceOutput } from "./history-endurance-cases.js";
import type { HistoryDownloadEvidence } from "./indexed-history-download.js";
import { validActiveHistoryRestart, type ActiveHistoryRestart } from "./history-active-restart.js";

export function retainedHistoryReadFailure(url: string, status: number, completedRuns: ReadonlySet<string>) {
  const match = /^\/api\/heartbeat-runs\/([a-f0-9-]+)\/log$/.exec(new URL(url).pathname);
  // The UI may ask for a just-created run before it has produced a log (404).
  // The lifetime oracle concerns runs already completed and independently read.
  return match && status >= 400 && completedRuns.has(match[1]!) ? { runId: match[1]!, status } : null;
}

export interface HistoryEnduranceRound {
  round: number;
  submittedAt: number;
  finishedAt: number;
  issueId: string;
  issueStatus: string;
  run: { id: string; status: string; runtimeMode?: string; sessionIdBefore?: string | null; sessionIdAfter?: string | null };
  document: { key: string; body: string; latestRevisionId: string };
  documentCount: number;
  pendingInteractions: number;
  childCount: number;
  restarted: boolean;
  restartMode: "graceful" | "hard" | null;
  activeRestart?: ActiveHistoryRestart;
  output: HistoryDownloadEvidence;
  originalOutput: HistoryDownloadEvidence;
}

export function gradeHistoryEndurance(input: {
  nonce: string; rounds: number; intervalMs: number; restartEvery: number; activeRestartRound?: number;
  observations: readonly HistoryEnduranceRound[];
  logReadFailures: readonly { runId: string; status: number }[];
}) {
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
  const first = input.observations[0];
  check("history-readable", Array.isArray(input.logReadFailures) && input.logReadFailures.length === 0,
    "Browser requests for retained run logs must succeed as the task accumulates turns.");
  check("all-rounds", input.observations.length === input.rounds && input.rounds >= 2,
    `Completed ${input.observations.length}/${input.rounds} real provider turns.`);
  check("unique-runs", new Set(input.observations.map(o => o.run.id)).size === input.observations.length,
    "Each browser request must produce one distinct successful run.");
  const matches = (body: HistoryDownloadEvidence, round: number, runId: string) => {
    const expected = enduranceOutput(input.nonce, round);
    const hash = createHash("sha256").update(expected).digest("hex");
    return body.browserDownload === true && body.runId === runId && body.sha256 === hash &&
      body.bodyId === hash && body.byteLength === Buffer.byteLength(expected) &&
      body.stream?.sha256 === hash && body.stream.byteLength === Buffer.byteLength(expected) && !!body.stream.executionId;
  };
  for (const [i, row] of input.observations.entries()) {
    check(`round-${i}.identity`, row.round === i && !!first?.issueId && row.issueId === first.issueId &&
      row.run.status === "succeeded" && row.run.runtimeMode === "native" && row.issueStatus === "done",
      "The same task must complete every requested native turn.");
    check(`round-${i}.session`, !!row.run.sessionIdAfter && row.run.sessionIdAfter === first?.run.sessionIdAfter &&
      (i === 0 || row.run.sessionIdBefore === first?.run.sessionIdAfter),
      "Provider session identity must survive idle periods and controller restarts.");
    check(`round-${i}.ledger`, row.documentCount === 1 && row.document.key === "history-ledger" &&
      !!row.document.latestRevisionId && row.document.body.trim() === Array.from({ length: i + 1 }, (_, n) => enduranceMarker(input.nonce, n)).join("\n") &&
      row.pendingInteractions === 0 && row.childCount === 0,
      "The saved document must retain each prior reference exactly once and in order.");
    check(`round-${i}.downloads`, matches(row.output, i, row.run.id) &&
      !!first && matches(row.originalOutput, 0, first.run.id),
      "New and original tool output must download byte-for-byte through the browser.");
    const restarted = i > 0 && i % input.restartEvery === 0;
    const expectedMode = restarted ? (i / input.restartEvery % 2 === 0 ? "hard" : "graceful") : null;
    check(`round-${i}.restart`, row.restarted === restarted && row.restartMode === expectedMode,
      "All scheduled controller restarts must complete before submitting the next turn.");
    if (input.activeRestartRound === i) check(`round-${i}.active-restart`, validActiveHistoryRestart(row.activeRestart, row.run.id),
      "The exact running diagnostic must complete in the same run after a forced controller crash.");
    check(`round-${i}.elapsed`, row.finishedAt >= row.submittedAt &&
      (i === 0 || row.submittedAt >= input.observations[i - 1]!.submittedAt + input.intervalMs),
      "Wall-clock spacing must meet the declared endurance duration.");
  }
  return checks;
}
