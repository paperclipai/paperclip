/**
 * W2, W2Q, W2C: the same task woken again right after a run of it finished (README "Re-wake after success").
 *
 * On staging, 20 of 25 failures in one 8-hour window happened with no restart at all. Ten or more runs of
 * one agent ran at once on reused (warm) sandboxes, and 30–60 s after a long run of a task succeeded, an
 * ordinary wake (a comment, an issue monitor) started the next run of that same task. That run first had to
 * retire the previous run's warm owner, and it failed before any provider work ("Controller journal drain
 * timed out", "runner did not durably suspend before checkpoint", `journal_tool_input_unanswered`).
 *
 * The workload is the fault. Every task runs on its adapter's one agent, so `--tasks 10 --concurrency 10`
 * puts ten tasks on one agent. Phase 1 ends with the task left `in_progress` (`in_review` would gate completion on a
 * review). Then the harness, acting as the
 * board, wakes the same task 0–60 s after that run settled (the seeded `followUpAfterMs`):
 *
 *   W2   a board comment, or (by the task's nonce) a board-scheduled issue monitor (`issue_monitor_due`).
 *   W2Q  phase 1 parks on an unanswered `request_human_input` question; a comment wakes the task before the
 *        board answers (staging class C3). The board answers after that run settled.
 *   W2C  as W2, and the board changes the agent's `adapterConfig.idleTimeoutMs` before the wake, so the next
 *        run cannot resume the saved session (SR1, session-faults.ts, is the same change while parked).
 *
 * Pass: no attempt failed, the wake was served by a run that succeeded, and the task ends `done` with its
 * markers. A task left blocked gets the usual Retry (R3), which itself fails the grade.
 */
import type { ChaosApi } from "./api.js";
import { q1AnswerMarker, q1Code, q1Question, Q1_CODES, questionStep } from "./question-handoff.js";
import type { OracleArtifacts, OracleResult, TaskPlan, TaskRecord, TaskSample, WorkloadId } from "./types.js";
import type { WorkloadDefinition } from "./workloads.js";

type Json = Record<string, any>;

export const REWAKE_WORKLOADS = ["W2", "W2Q", "W2C"] as const satisfies readonly WorkloadId[];
export type RewakeWorkload = (typeof REWAKE_WORKLOADS)[number];
export function isRewakeWorkload(id: string): id is RewakeWorkload {
  return (REWAKE_WORKLOADS as readonly string[]).includes(id);
}

/** Seeded delay between the first run settling and the re-wake (staging: 30–60 s). */
export const REWAKE_DELAY_RANGE_MS: readonly [number, number] = [0, 60_000];
/** W2C: the configuration change commits at least this long before the wake. */
export const CONFIG_SETTLE_MS = 5_000;
/** A wake that started no run within this long after it was sent is recorded as not served. */
export const REWAKE_SERVE_TIMEOUT_MS = 180_000;
const ACTIVE = new Set(["queued", "running", "scheduled_retry"]);
const FAILED = new Set(["failed", "timed_out"]);

export type RewakeKind = "comment" | "monitor";

/** W2Q is woken by a comment (C3's shape); W2 and W2C alternate by nonce between a comment and a monitor. */
export function rewakeKind(plan: Pick<TaskPlan, "workload" | "nonce">): RewakeKind {
  if (plan.workload === "W2Q") return "comment";
  return Number.parseInt(plan.nonce.slice(-2, -1), 16) % 2 === 0 ? "comment" : "monitor";
}

const briefMarker = (nonce: string) => `CHAOS-${nonce}`;
export const rewakeMarker = (nonce: string) => `REWAKE-${nonce}`;
export const noteMarker = (nonce: string) => `NOTE-${nonce}`;

export interface RewakeRecord {
  kind: RewakeKind;
  /** The run that finished phase 1 (for W2Q, the run that asked). */
  firstRunId: string | null;
  /** First poll that saw phase 1 finished and nothing of the task active. */
  firstSettledAt: number | null;
  /** W2C: the board's agent configuration change, made before the wake. */
  configChange?: { at: number; idleTimeoutMs: number; httpStatus: number | null; error: string | null };
  sent?: { at: number; kind: RewakeKind; statusAtWake: string | null; httpStatus: number | null; error: string | null;
    commentId?: string | null; nextCheckAt?: string };
  /** First run created after the wake was sent. */
  servedByRunId?: string | null;
  servedSeenAt?: number | null;
}

export interface RewakeArtifacts extends RewakeRecord {
  runs: Array<{ id: string; status: string; errorCode: string | null; createdAt: string | null; finishedAt: string | null }>;
}

const phaseTwo = (nonce: string) => [
  "Phase 2 happens only when the board wakes you again with a comment or a scheduled monitor check on this task.",
  `Then add the line \`${rewakeMarker(nonce)}\` on its own line to the \`brief\` document (keep everything else), and mark this task done.`,
  "If you are woken for any other reason before that, change nothing and end your turn.",
].join("\n");

const w2Description = (nonce: string) => [
  "This task has two phases.",
  "Phase 1 (when the board's comment asks you to start it): write a short brief on why idempotent retries matter for background job queues.",
  "Save it as this issue's document with key `brief` (title \"Brief\"), in markdown.",
  `It must contain the line \`${briefMarker(nonce)}\` exactly, on its own line, and at least three bullet points that start with "- ".`,
  "Then leave this task `in_progress` and end your turn. Do not mark it done or move it to review in phase 1. Do not create files or other tasks.",
  "Phase 1 does not finish the task: report this turn with `paperclip_finish` and `reportedWorkDisposition` `yielded`, never `done`,",
  `with a continuation of kind \`response_wake\` (summary "Waiting for the board's phase 2 wake", idempotencyKey \`w2-${nonce}\`).`,
  "List phase 2 in remainingWork with blocksCompletion false: phase 1 is complete, and phase 2 waits for the board.",
  phaseTwo(nonce),
].join("\n");

const w2qDescription = (nonce: string) => [
  "This task needs one answer from the board before you write anything.",
  `1. Ask exactly one question with your \`request_human_input\` tool: a questions card (continuationPolicy \`wake_assignee\`,`,
  `   idempotencyKey \`w2q-${nonce}\`) with one required single-select question "${q1Question(nonce)}"`,
  `   and exactly two options labelled \`${Q1_CODES[0]}\` and \`${Q1_CODES[1]}\`.`,
  "2. Then end your turn and wait for the answer. Do not guess, do not ask again, and do not create documents, files or tasks yet.",
  "   If the board comments before it answers, follow the comment's note and end your turn again; do not ask again.",
  "3. When you are woken with the answer, save this issue's document with key `brief` (title \"Brief\"), in markdown.",
  `   It must contain the line \`${q1AnswerMarker(nonce, "<CODENAME>")}\` exactly, on its own line, with <CODENAME> replaced by the chosen option,`,
  "   every line the board's comments asked you to include, and at least three bullet points starting with \"- \".",
  "4. When the document is saved, mark this task done.",
].join("\n");

/** The board's re-wake comment. W2Q's asks only for a note, so its run must end while the question stays pending. */
export function rewakeComment(plan: Pick<TaskPlan, "workload" | "nonce">): string {
  if (plan.workload === "W2Q") {
    return `Note before I answer your question: when you write the brief, also include the line \`${noteMarker(plan.nonce)}\` on its own line. `
      + "I will answer shortly; do not ask again and do not write the brief yet.";
  }
  return `Phase 2 now: add the line \`${rewakeMarker(plan.nonce)}\` on its own line to the \`brief\` document, then mark this task done.`;
}

/** W2C: one adapter setting in the session's configuration fingerprint, harmless to the run (as SR1 changes). */
export function rewakeIdleTimeoutMs(taskIndex: number): number {
  return 300_000 + 1_000 + taskIndex;
}

/** The task waits on the board between its first run settling and the wake being served (and, for W2Q, the answer). */
export function awaitingRewake(record: TaskRecord, now = Date.now()): boolean {
  const rewake = record.rewake;
  if (!rewake?.firstSettledAt) return false;
  if (!rewake.sent) return true;
  if (rewake.sent.error) return false;
  if (!rewake.servedByRunId && now - rewake.sent.at < REWAKE_SERVE_TIMEOUT_MS) return true;
  return record.plan.workload === "W2Q" && Boolean(record.question?.pendingNow) && !record.question?.answer;
}

/** The first run of the task that succeeded, when nothing of the task is active. */
function settledFirstRun(sample: TaskSample): string | null {
  const runs = sample.runs ?? [];
  if (runs.some(run => ACTIVE.has(run.status))) return null;
  const succeeded = runs.filter(run => run.status === "succeeded")
    .sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""));
  return succeeded[0]?.id ?? null;
}

export interface RewakeStepInput {
  api: Pick<ChaosApi, "get" | "post" | "patch">;
  record: TaskRecord;
  plan: TaskPlan;
  issueId: string;
  agentId: string;
  sample: TaskSample;
  now: number;
  /** The server is ready, no fault is in progress and the task's planned faults fired. */
  boardMayAct: boolean;
  note: (kind: string, data: Record<string, unknown>) => void;
}

/** Board step of W2, W2Q and W2C, called on every poll. */
export async function rewakeStep(input: RewakeStepInput): Promise<void> {
  const { plan, record, sample, now } = input;
  const rewake = record.rewake ??= { kind: rewakeKind(plan), firstRunId: null, firstSettledAt: null };
  if (plan.workload === "W2Q") {
    // The question is answered only after the comment's run settled; questionStep keeps Q1's record.
    await questionStep({ api: input.api, issueId: input.issueId, nonce: plan.nonce, record, sample, now, note: input.note,
      boardMayAct: input.boardMayAct && Boolean(rewake.servedByRunId) && !(sample.runs ?? []).some(run => ACTIVE.has(run.status)) });
  }
  if (!sample.reachable) return;
  if (rewake.sent) {
    if (!rewake.servedByRunId) {
      const served = (sample.runs ?? []).filter(run => run.createdAt && Date.parse(run.createdAt) >= rewake.sent!.at - 1_000)
        .sort((a, b) => Date.parse(a.createdAt!) - Date.parse(b.createdAt!))[0];
      if (served) {
        rewake.servedByRunId = served.id;
        rewake.servedSeenAt = now;
        input.note("rewake_served", { runId: served.id });
      }
    }
    return;
  }
  if (rewake.firstSettledAt === null) {
    // W2Q: phase 1 is the asking run, settled while the question is pending.
    if (plan.workload === "W2Q" && !record.question?.pendingNow) return;
    if (plan.workload !== "W2Q" && sample.issueStatus === "done") return;
    const first = settledFirstRun(sample);
    if (!first) return;
    rewake.firstRunId = plan.workload === "W2Q" ? record.question?.askedByRunId ?? first : first;
    rewake.firstSettledAt = now;
    input.note("rewake_first_run_settled", { runId: rewake.firstRunId, status: sample.issueStatus ?? null });
  }
  if (!input.boardMayAct || (sample.runs ?? []).some(run => ACTIVE.has(run.status))) return;
  if (plan.workload === "W2C" && !rewake.configChange) {
    const idleTimeoutMs = rewakeIdleTimeoutMs(plan.index);
    const change: NonNullable<RewakeRecord["configChange"]> = { at: now, idleTimeoutMs, httpStatus: null, error: null };
    try {
      const agent = await input.api.get<{ adapterConfig?: Record<string, unknown> | null }>(`/api/agents/${input.agentId}`);
      await input.api.patch(`/api/agents/${input.agentId}`, { adapterConfig: { ...(agent.adapterConfig ?? {}), idleTimeoutMs }, replaceAdapterConfig: true });
      change.httpStatus = 200;
    } catch (error) {
      change.httpStatus = statusOf(error);
      change.error = error instanceof Error ? error.message : String(error);
    }
    rewake.configChange = change;
    input.note("rewake_config_changed", { ...change });
    return;
  }
  if (now < rewake.firstSettledAt + (plan.followUpAfterMs ?? 0)) return;
  // W2C: the change commits at least CONFIG_SETTLE_MS before the wake, however late the board made it.
  if (rewake.configChange && now < rewake.configChange.at + CONFIG_SETTLE_MS) return;
  const sent: NonNullable<RewakeRecord["sent"]> = { at: now, kind: rewake.kind, statusAtWake: sample.issueStatus ?? null, httpStatus: null, error: null };
  try {
    if (rewake.kind === "comment") {
      const comment = await input.api.post<Json>(`/api/issues/${input.issueId}/comments`, { body: rewakeComment(plan) });
      sent.commentId = typeof comment?.id === "string" ? comment.id : null;
    } else {
      // A board-scheduled monitor due now: the scheduler's own `issue_monitor_due` wake, as on staging.
      sent.nextCheckAt = new Date(now + 2_000).toISOString();
      await input.api.patch(`/api/issues/${input.issueId}`, { executionPolicy: { monitor: { nextCheckAt: sent.nextCheckAt,
        notes: `Phase 2 check for ${plan.nonce}`, scheduledBy: "board" } } });
    }
    sent.httpStatus = 200;
  } catch (error) {
    sent.httpStatus = statusOf(error);
    sent.error = error instanceof Error ? error.message : String(error);
  }
  rewake.sent = sent;
  input.note("rewake_sent", { ...sent, delayMs: now - rewake.firstSettledAt });
}

function statusOf(error: unknown): number | null {
  return typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : null;
}

export async function collectRewakeArtifacts(api: Pick<ChaosApi, "get">, issueId: string, record: TaskRecord): Promise<RewakeArtifacts> {
  const runs = await api.get<Json[]>(`/api/issues/${issueId}/runs`, 10_000).catch(() => []);
  return {
    ...(record.rewake ?? { kind: rewakeKind(record.plan), firstRunId: null, firstSettledAt: null }),
    runs: (runs ?? []).map(run => ({ id: String(run.runId ?? run.id), status: String(run.status), errorCode: run.errorCode ?? null,
      createdAt: run.createdAt ?? null, finishedAt: run.finishedAt ?? null })),
  };
}

/** No run of the task failed or timed out; the shared pass condition of the shape cells. */
export function noFailedAttemptCheck(runs: ReadonlyArray<{ id: string; status: string; errorCode: string | null }>) {
  const failed = runs.filter(run => FAILED.has(run.status));
  return { name: "no_failed_attempt", ok: failed.length === 0,
    detail: failed.map(run => `${run.id}:${run.status}:${run.errorCode ?? ""}`).join(",") || "none" };
}

export function gradeRewake(plan: Pick<TaskPlan, "workload" | "nonce">, artifacts: OracleArtifacts): OracleResult {
  const rewake = artifacts.rewake;
  const runs = rewake?.runs ?? [];
  const brief = artifacts.documents.brief ?? "";
  const bullets = brief.split(/\r?\n/).filter(line => /^\s*[-*] \S/.test(line)).length;
  const first = runs.find(run => run.id === rewake?.firstRunId);
  const served = runs.find(run => run.id === rewake?.servedByRunId);
  const sent = rewake?.sent;
  const markers = plan.workload === "W2Q"
    ? [q1AnswerMarker(plan.nonce, q1Code(plan.nonce)), noteMarker(plan.nonce)] : [briefMarker(plan.nonce), rewakeMarker(plan.nonce)];
  const checks: OracleResult["checks"] = [
    { name: "issue_done", ok: artifacts.issueStatus === "done", detail: `status=${artifacts.issueStatus ?? "unknown"}` },
    { name: "first_run_succeeded", ok: first?.status === "succeeded",
      detail: first ? `${first.id} ${first.status}${first.errorCode ? ` ${first.errorCode}` : ""}` : "phase 1 never settled" },
    { name: "rewake_sent", ok: sent?.httpStatus === 200,
      detail: sent ? `${sent.kind} status=${sent.statusAtWake ?? "?"} http=${sent.httpStatus}${sent.error ? ` ${sent.error}` : ""}`
        + ` after ${rewake?.firstSettledAt ? Math.round((sent.at - rewake.firstSettledAt) / 1000) : "?"}s` : "never sent" },
    { name: "rewake_served", ok: served?.status === "succeeded",
      detail: served ? `${served.id} ${served.status}${served.errorCode ? ` ${served.errorCode}` : ""}` : "no run after the wake" },
    noFailedAttemptCheck(runs),
    ...(plan.workload === "W2C" ? [{ name: "config_changed_before_wake", ok: rewake?.configChange?.httpStatus === 200
      && (sent === undefined || rewake.configChange.at < sent.at),
      detail: rewake?.configChange ? `idleTimeoutMs=${rewake.configChange.idleTimeoutMs} http=${rewake.configChange.httpStatus}` : "not changed" }] : []),
    ...(plan.workload === "W2Q" ? [{ name: "question_answered_after_wake", ok: artifacts.question?.answer?.httpStatus === 200
      && sent !== undefined && artifacts.question.answer.at > sent.at, detail: artifacts.question?.answer
        ? `${artifacts.question.answer.code} http=${artifacts.question.answer.httpStatus}` : "never answered" },
    { name: "one_question_asked", ok: artifacts.question?.interactionIds.length === 1, detail: `questions=${artifacts.question?.interactionIds.length ?? 0}` }] : []),
    ...markers.map(marker => ({ name: `brief_contains_${marker.split("-")[0]!.toLowerCase()}_marker`, ok: brief.includes(marker), detail: marker })),
    { name: "brief_has_three_bullets", ok: bullets >= 3, detail: `bullets=${bullets}` },
  ];
  return { verdict: checks.every(check => check.ok) ? "pass" : "fail", checks };
}

export const rewakeStartComment = (nonce: string) => `Start phase 1 of this task now (${briefMarker(nonce)}).`;

const definition = (id: RewakeWorkload, label: string, description: (nonce: string) => string): WorkloadDefinition => ({
  id,
  label,
  usesRepository: false,
  // A restart fault, if any, lands around the first run or the wake.
  fireWindowMs: [20_000, 120_000],
  // The seeded re-wake delay after the first run settled.
  followUpWindowMs: REWAKE_DELAY_RANGE_MS,
  budgetMs: 20 * 60_000,
  title: nonce => `Chaos ${id} re-wake ${nonce}`,
  description,
  ...(id === "W2Q" ? {} : { startComment: rewakeStartComment }),
  collect: { documents: ["brief"], files: () => [], commands: [] },
  grade: (nonce, artifacts) => gradeRewake({ workload: id, nonce }, artifacts),
});

export const rewakeWorkloadDefinitions: Record<RewakeWorkload, WorkloadDefinition> = {
  W2: definition("W2", "Same task woken again after its run succeeded", w2Description),
  W2Q: definition("W2Q", "Parked question, then woken by a comment before the answer", w2qDescription),
  W2C: definition("W2C", "Agent configuration changed, then the same task woken again", w2Description),
};
