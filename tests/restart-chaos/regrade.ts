import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gradeTask } from "./grader.js";
import { completedAtAnchor, firstDoneCommentAt, gradeStagingMix, stagingMixBudgetMs } from "./staging-mix.js";
import { commentEvidence, evidenceCompletion, followUpsAnsweredLater, laterAnswerHeadline, runsAfterDone, type FollowUpAnsweredLater, type WakeEvidenceFile } from "./staging-mix-retry.js";
import type { FaultReceipt, OracleArtifacts, OracleResult, TaskGrade, TaskRecord, WavePlan } from "./types.js";
import { loadWaveGradeInputs } from "./wave-grade-inputs.js";

const readJson = async <T>(file: string): Promise<T | null> => readFile(file, "utf8").then(text => JSON.parse(text) as T).catch(() => null);

export interface Regrade {
  tasks: Array<{ taskId: string; before: string | null; after: string | null }>;
  failsBefore: number;
  failsAfter: number;
  extraTurnsBefore: number | null;
  extraTurnsAfter: number;
  followUpsAnsweredLater: FollowUpAnsweredLater[];
  bannerTasks: string[];
  slotEvidence: boolean;
}

function oracleFor(record: TaskRecord, saved: OracleResult, artifacts: OracleArtifacts | null, evidence: WakeEvidenceFile | null): OracleResult {
  const task = record.plan.stagingMix;
  if (!task || !artifacts?.stagingMix) return saved;
  const completion = evidenceCompletion(evidence) ?? artifacts.stagingMix.completion;
  return gradeStagingMix(record.plan.nonce, task, { ...artifacts, stagingMix: { ...artifacts.stagingMix, ...(completion ? { completion } : {}) } });
}

export async function regradeWave(waveDir: string): Promise<Regrade> {
  const plan = await readJson<WavePlan>(path.join(waveDir, "plan.json"));
  if (!plan) throw new Error(`${waveDir} has no plan.json`);
  if (!plan.options.stagingMix) throw new Error(`${waveDir} is not a staging-mix wave; regrade.ts regrades staging-mix waves only`);
  const faults = await readJson<FaultReceipt[]>(path.join(waveDir, "faults.json")) ?? [];
  const inputs = await loadWaveGradeInputs(waveDir, plan.options.stagingMix);
  const saved = await readJson<{ extraTurns?: unknown[] }>(path.join(waveDir, "staging-mix-results.json"));
  const names = (await readdir(waveDir)).filter(name => /^t\d+\.grade\.json$/.test(name)).sort();
  const result: Regrade = { tasks: [], failsBefore: 0, failsAfter: 0, extraTurnsBefore: saved?.extraTurns?.length ?? null, extraTurnsAfter: 0,
    followUpsAnsweredLater: [], bannerTasks: [], slotEvidence: inputs.slotEvidence };
  for (const name of names) {
    const file = await readJson<{ record: TaskRecord; grade: TaskGrade }>(path.join(waveDir, name));
    if (!file) continue;
    const taskId = file.record.plan.taskId;
    const evidence = await readJson<WakeEvidenceFile>(path.join(waveDir, "wake-evidence", `${taskId}.json`));
    const artifacts = await readJson<OracleArtifacts>(path.join(waveDir, "evidence", taskId, "oracle-artifacts.json"));
    const record = await inputs.prepare(taskId, file.record);
    if (!record.plan.stagingMix) throw new Error(`${taskId} has no staging-mix plan; regrade.ts regrades staging-mix tasks only`);
    const budgetMs = stagingMixBudgetMs(record.plan.stagingMix);
    const grade = gradeTask(record, faults, budgetMs, oracleFor(record, file.grade.T, artifacts, evidence), undefined, inputs.queue);
    result.tasks.push({ taskId, before: file.grade.pass ? null : file.grade.signature, after: grade.pass ? null : grade.signature });
    if (!file.grade.pass) result.failsBefore += 1;
    if (!grade.pass) result.failsAfter += 1;
    if (record.stagingMix?.retryBanner) result.bannerTasks.push(taskId);
    const comments = commentEvidence(await readJson(path.join(waveDir, "evidence", taskId, "comments.json")));
    const completion = evidenceCompletion(evidence);
    result.extraTurnsAfter += runsAfterDone(taskId, evidence, completedAtAnchor(completion, comments, record.plan.nonce),
      firstDoneCommentAt(comments, record.plan.nonce)).started.length;
    result.followUpsAnsweredLater.push(...followUpsAnsweredLater(taskId, evidence));
  }
  return result;
}

export function regradeMarkdown(waveDir: string, result: Regrade): string {
  const changed = result.tasks.filter(task => task.before !== task.after);
  return [`Regrade of ${path.basename(waveDir)}: per-task FAIL ${result.failsBefore} -> ${result.failsAfter}; extra turns ${result.extraTurnsBefore ?? "?"} -> ${result.extraTurnsAfter}`,
    ...laterAnswerHeadline(result.extraTurnsAfter, result.followUpsAnsweredLater),
    `Retry banner shown: ${result.bannerTasks.length} tasks${result.bannerTasks.length ? ` (${result.bannerTasks.join(", ")})` : ""}`,
    `agent slot evidence: ${result.slotEvidence ? "present" : "absent (declared queue bound only)"}`, "",
    ...changed.map(task => `- ${task.taskId}: ${task.before ?? "PASS"} -> ${task.after ?? "PASS"}`),
    ...result.tasks.filter(task => task.after && task.before === task.after).map(task => `- ${task.taskId}: still ${task.after}`)].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const waveDir = process.argv[2];
  if (!waveDir) throw new Error("usage: regrade.ts <wave results directory>");
  console.info(regradeMarkdown(waveDir, await regradeWave(path.resolve(waveDir))));
}
