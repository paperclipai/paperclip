import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { regradeMarkdown, regradeWave } from "./regrade.js";
import { doneMarker, expectedRoundHash, ROUND_SECONDS, type StagingMixTask } from "./staging-mix.js";
import type { TaskPlan, TaskRecord, TaskSample } from "./types.js";

const nonce = "bd13d3bf", comment = "fd278a3a", first = "0d18f0d9", second = "42acaf33";
const T0 = 1_794_548_287_511;
const ledger = Array.from({ length: 9 }, (_, index) => `ROUND ${index + 1} 1800000000 ${1_800_000_000 + ROUND_SECONDS} ${expectedRoundHash(nonce, index + 1)}`).join("\n");
const task: StagingMixTask = { turnMinutes: 15, rounds: 9, subtasks: 0, followUpAfterMs: null, arriveAtMs: 0, holdMs: 0 };
const iso = (at: number) => new Date(at).toISOString();
const run = (id: string, status: string, started: number, finished: number | null) => ({ id, status, createdAt: iso(started), startedAt: iso(started),
  finishedAt: finished === null ? null : iso(finished), errorCode: null, retryOfRunId: null, wakeCommentIds: [], livenessState: null, lastEvidenceAt: iso(started) });
const sample = (at: number, issueStatus: string, runs: ReturnType<typeof run>[]): TaskSample => ({ at, reachable: true, serverReady: true, issueStatus, interruption: null,
  activeRecoveryAction: false, executionBlocker: false, scheduledRetry: false, runs });

let directory: string | null = null;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = null; });

async function savedWave(): Promise<string> {
  directory = await mkdtemp(path.join(os.tmpdir(), "regrade-"));
  const waveDir = path.join(directory, "w-test");
  await mkdir(path.join(waveDir, "wake-evidence"), { recursive: true });
  await mkdir(path.join(waveDir, "evidence", "t010"), { recursive: true });
  const plan: TaskPlan = { taskId: "t010", index: 0, workload: "SM", adapter: "opencode", fault: "K13", fireAfterMs: 0, holdMs: 0, followUpAfterMs: null, nonce, stagingMix: task };
  await writeFile(path.join(waveDir, "plan.json"), JSON.stringify({ options: { stagingMix: { runs: 20, queue: 20, turnMinutes: [12, 22] } }, tasks: [plan] }));
  await writeFile(path.join(waveDir, "faults.json"), "[]");
  await writeFile(path.join(waveDir, "staging-mix-results.json"), JSON.stringify({ extraTurns: [{ taskId: "t010" }] }));
  const samples = [sample(T0, "in_progress", [run(first, "running", T0, null)]), sample(T0 + 920_000, "todo", [run(first, "succeeded", T0, T0 + 920_000)]),
    sample(T0 + 1_937_000, "in_progress", [run(first, "succeeded", T0, T0 + 920_000), run(second, "running", T0 + 1_936_750, null)]),
    sample(T0 + 1_980_000, "done", [run(first, "succeeded", T0, T0 + 920_000), run(second, "succeeded", T0 + 1_936_750, T0 + 1_978_000)])];
  const record: TaskRecord = { plan, issueId: "issue-1", identifier: "CHA-12", createdAt: T0, launchError: null, samples, retry: null, restAt: T0 + 1_980_000,
    finalStatus: "done", deadlineAt: T0 + 7_200_000, timedOut: false, followUp: null, faultIds: [],
    sweep: { activeRuns: [], runningWorkspaceOperations: [], activeRecoveryAction: false, error: null }, preFaultFiles: null, lostFiles: null };
  await writeFile(path.join(waveDir, "t010.grade.json"), JSON.stringify({ record, grade: { pass: false, signature: "T:completion_once:SM:K13",
    T: { verdict: "fail", checks: [{ name: "completion_once", ok: false, detail: "duplicate completion" }] } } }));
  const comments = [{ body: doneMarker(nonce), authorAgentId: "a", createdByRunId: first, createdAt: iso(T0 + 911_957) }];
  await writeFile(path.join(waveDir, "evidence", "t010", "comments.json"), JSON.stringify(comments));
  await writeFile(path.join(waveDir, "evidence", "t010", "oracle-artifacts.json"), JSON.stringify({ issueStatus: "done", documents: { ledger }, agentComments: [],
    files: {}, commands: {}, workspacePath: null, stagingMix: { followUp: null, followUpErrors: [], retries: [],
      comments: [{ body: doneMarker(nonce), runId: first, createdAt: T0 + 911_957 }] } }));
  await writeFile(path.join(waveDir, "wake-evidence", "t010.json"), JSON.stringify({ completedAt: T0 + 1_978_163,
    runs: [{ runId: first, createdAt: T0, startedAt: T0, finishedAt: T0 + 920_000, invocationSource: "assignment", triggerDetail: "system", wakeupRequestId: "w1",
      acceptedDisposition: "done", acceptedAt: T0 + 918_884, contextSnapshot: { paperclipWake: { commentIds: [] } } },
    { runId: second, createdAt: T0 + 920_171, startedAt: T0 + 1_936_750, finishedAt: T0 + 1_978_000, invocationSource: "automation", triggerDetail: "system",
      wakeupRequestId: "w2", acceptedDisposition: "done", acceptedAt: T0 + 1_975_116, contextSnapshot: { wakeCommentIds: [comment] } }],
    wakes: [{ id: "w1", reason: "issue_assigned", createdAt: T0 }, { id: "w2", reason: "issue_execution_promoted", createdAt: T0 + 674_180, payload: { commentId: comment } }] }));
  return waveDir;
}

describe("offline regrade of a saved wave", () => {
  it("regrades a saved task with the current graders and reports the follow-up it answered in a later run", async () => {
    const waveDir = await savedWave();
    const result = await regradeWave(waveDir);
    expect(result).toMatchObject({ failsBefore: 1, failsAfter: 0, extraTurnsBefore: 1, extraTurnsAfter: 0, slotEvidence: false,
      tasks: [{ taskId: "t010", before: "T:completion_once:SM:K13", after: null }] });
    expect(result.followUpsAnsweredLater.map(answer => [answer.taskId, answer.runId, answer.startedAt - answer.queuedAt!])).toEqual([["t010", second, 1_016_579]]);
    expect(regradeMarkdown(waveDir, result).split("\n").slice(0, 2)).toEqual(["Regrade of w-test: per-task FAIL 1 -> 0; extra turns 1 -> 0",
      "extra turns (a run started after completion with no undelivered input): 0"]);
    await expect(regradeWave(path.join(waveDir, "missing"))).rejects.toThrow(/no plan.json/);
    await writeFile(path.join(waveDir, "plan.json"), JSON.stringify({ options: {}, tasks: [] }));
    await expect(regradeWave(waveDir)).rejects.toThrow(/not a staging-mix wave/);
  });
});
