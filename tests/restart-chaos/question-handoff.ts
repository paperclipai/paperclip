/**
 * Q1: the agent saves a question for the board (a governed wait), the runner
 * interrupts the provider turn, the turn settles, and the board answers. With a
 * provider message fault (provider-faults.ts) the interruption's terminal arrives
 * late (PV1) or never (PV2); the saved question must survive and settle once,
 * without a failed attempt, a Retry or repeated work.
 *
 * The board's side uses the same routes as the board UI: it lists the task's
 * interactions and answers the pending question once the run that asked it has
 * settled (no run of the task is queued or running) with the server ready.
 */
import type { ChaosApi } from "./api.js";
import type { OracleArtifacts, OracleResult, TaskRecord, TaskSample } from "./types.js";
import type { WorkloadDefinition } from "./workloads.js";

type Json = Record<string, any>;

/** What the observer saw of the task's question and what the board did. */
export interface QuestionRecord {
  /** Every ask_user_questions interaction on the task (a second one is repeated work). */
  interactionIds: string[];
  /** First poll that saw the question pending. */
  seenAt: number | null;
  /** When the question was saved (the interaction's createdAt), else the first poll that saw it. */
  savedAt?: number | null;
  /** The run that saved the question. */
  askedByRunId: string | null;
  /** The question is pending at the latest poll. */
  pendingNow: boolean;
  answer?: { at: number; interactionId: string; code: string; httpStatus: number | null; error: string | null };
}

export interface QuestionArtifacts extends QuestionRecord {
  runs: Array<{ id: string; status: string; errorCode: string | null; createdAt: string | null; startedAt?: string | null }>;
  statuses: Record<string, string>;
}

const ACTIVE = new Set(["queued", "running", "scheduled_retry"]);
export const Q1_CODES = ["ALPHA", "BRAVO"] as const;

/** The board's answer for this task, fixed by its nonce. */
export function q1Code(nonce: string): (typeof Q1_CODES)[number] {
  return Number.parseInt(nonce.slice(-1), 16) % 2 === 0 ? "ALPHA" : "BRAVO";
}
export const q1Question = (nonce: string) => `Which codename should the Q1-${nonce} brief use?`;
export const q1AnswerMarker = (nonce: string, code: string) => `ANSWER-${nonce}-${code}`;

const description = (nonce: string) => [
  "This task needs one answer from the board before you write anything.",
  `1. Ask exactly one question with your \`request_human_input\` tool: a questions card (continuationPolicy \`wake_assignee\`,`,
  `   idempotencyKey \`q1-${nonce}\`) with one required single-select question "${q1Question(nonce)}"`,
  `   and exactly two options labelled \`${Q1_CODES[0]}\` and \`${Q1_CODES[1]}\`.`,
  "2. Then end your turn and wait for the answer. Do not guess, do not ask again, and do not create documents, files or tasks yet.",
  "3. When you are woken with the answer, save this issue's document with key `brief` (title \"Brief\"), in markdown.",
  `   It must contain the line \`${q1AnswerMarker(nonce, "<CODENAME>")}\` exactly, on its own line, with <CODENAME> replaced by the chosen option,`,
  "   and at least three bullet points starting with \"- \" on why saved questions must survive a provider that stops answering.",
  "4. When the document is saved, mark this task done.",
].join("\n");

function questionInteractions(rows: Json[] | null | undefined): Json[] {
  return (rows ?? []).filter(row => row.kind === "ask_user_questions");
}

/** Q1 board step, called on every poll. */
export async function questionStep(input: { api: Pick<ChaosApi, "get" | "post">; issueId: string; nonce: string; record: TaskRecord;
  sample: TaskSample; now: number; boardMayAct: boolean; note: (kind: string, data: Record<string, unknown>) => void }): Promise<void> {
  const question = input.record.question ??= { interactionIds: [], seenAt: null, askedByRunId: null, pendingNow: false };
  const rows = await input.api.get<Json[]>(`/api/issues/${input.issueId}/interactions`, 5_000).catch(() => null);
  if (rows === null) return;
  const interactions = questionInteractions(rows);
  for (const interaction of interactions) if (!question.interactionIds.includes(String(interaction.id))) question.interactionIds.push(String(interaction.id));
  const pending = interactions.find(interaction => interaction.status === "pending");
  question.pendingNow = Boolean(pending) && !question.answer;
  if (!pending || question.answer) return;
  if (question.seenAt === null) {
    question.seenAt = input.now;
    const created = Date.parse(String(pending.createdAt ?? ""));
    question.savedAt = Number.isFinite(created) ? Math.min(created, input.now) : input.now;
    question.askedByRunId = typeof pending.sourceRunId === "string" ? pending.sourceRunId
      : (input.sample.runs ?? []).find(run => run.status === "running")?.id ?? null;
    input.note("question_pending", { interactionId: pending.id, askedByRunId: question.askedByRunId });
  }
  // The saved question must settle on its own first: answer only once nothing of the task is running.
  if (!input.boardMayAct || (input.sample.runs ?? []).some(run => ACTIVE.has(run.status))) return;
  const code = q1Code(input.nonce);
  const questions = (pending.payload?.questions ?? []) as Json[];
  const target = questions[0];
  const option = ((target?.options ?? []) as Json[]).find(candidate => String(candidate.label ?? "").toUpperCase().includes(code));
  const answer: NonNullable<QuestionRecord["answer"]> = { at: input.now, interactionId: String(pending.id), code, httpStatus: null, error: null };
  try {
    if (!target) throw new Error("the pending question card has no questions");
    await input.api.post(`/api/issues/${input.issueId}/interactions/${pending.id}/respond`, {
      answers: [{ questionId: String(target.id), optionIds: option ? [String(option.id)] : [], ...(option ? {} : { otherText: code }) }],
    });
    answer.httpStatus = 200;
  } catch (error) {
    answer.httpStatus = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : null;
    answer.error = error instanceof Error ? error.message : String(error);
  }
  question.answer = answer;
  question.pendingNow = false;
  input.note("question_answered", { ...answer });
}

/** The task waits on the board while its question is pending and unanswered. */
export function awaitingQuestionAnswer(record: TaskRecord): boolean {
  return Boolean(record.question?.pendingNow) && !record.question?.answer;
}

export async function collectQuestionArtifacts(api: Pick<ChaosApi, "get">, issueId: string, record: TaskRecord): Promise<QuestionArtifacts> {
  const runs = await api.get<Json[]>(`/api/issues/${issueId}/runs`, 10_000).catch(() => []);
  const interactions = questionInteractions(await api.get<Json[]>(`/api/issues/${issueId}/interactions`, 10_000).catch(() => []));
  const question = record.question ?? { interactionIds: [], seenAt: null, askedByRunId: null, pendingNow: false };
  return {
    ...question,
    interactionIds: [...new Set([...question.interactionIds, ...interactions.map(interaction => String(interaction.id))])],
    statuses: Object.fromEntries(interactions.map(interaction => [String(interaction.id), String(interaction.status)])),
    runs: (runs ?? []).map(run => ({ id: String(run.runId ?? run.id), status: String(run.status), errorCode: run.errorCode ?? null,
      createdAt: run.createdAt ?? null, startedAt: run.startedAt ?? null })),
  };
}

export function gradeQuestionHandoff(nonce: string, artifacts: OracleArtifacts): OracleResult {
  const question = artifacts.question;
  const code = q1Code(nonce);
  const brief = artifacts.documents.brief ?? "";
  const bullets = brief.split(/\r?\n/).filter(line => /^\s*[-*] \S/.test(line)).length;
  const runs = question?.runs ?? [];
  const failed = runs.filter(run => run.status === "failed" || run.status === "timed_out");
  const asked = question?.askedByRunId ? runs.find(run => run.id === question.askedByRunId) : undefined;
  const answeredAt = question?.answer?.at ?? null;
  // Repeated work: another run that started (or was created) after the question was saved and
  // before the board answered. A run queued earlier that starts during the wait counts too.
  const savedAt = question?.savedAt ?? question?.seenAt ?? null;
  const between = savedAt !== null && answeredAt !== null ? runs.filter(run => run.id !== question?.askedByRunId
    && [run.startedAt, run.createdAt].some(at => at && Date.parse(at) > savedAt && Date.parse(at) < answeredAt)) : [];
  const checks = [
    { name: "issue_done", ok: artifacts.issueStatus === "done", detail: `status=${artifacts.issueStatus ?? "unknown"}` },
    { name: "one_question_asked", ok: question?.interactionIds.length === 1, detail: `questions=${question?.interactionIds.length ?? 0}` },
    { name: "question_answered_by_board", ok: question?.answer?.httpStatus === 200,
      detail: question?.answer ? `${question.answer.code} http=${question.answer.httpStatus}${question.answer.error ? ` ${question.answer.error}` : ""}` : "never pending" },
    { name: "asking_run_settled", ok: asked?.status === "succeeded",
      detail: asked ? `${asked.id} ${asked.status}${asked.errorCode ? ` ${asked.errorCode}` : ""}` : `run=${question?.askedByRunId ?? "unknown"}` },
    { name: "no_failed_attempt", ok: failed.length === 0, detail: failed.map(run => `${run.id}:${run.status}:${run.errorCode ?? ""}`).join(",") || "none" },
    { name: "nothing_ran_before_answer", ok: between.length === 0, detail: between.map(run => run.id).join(",") || "none" },
    { name: "brief_has_answer", ok: brief.includes(q1AnswerMarker(nonce, code)), detail: q1AnswerMarker(nonce, code) },
    { name: "brief_has_three_bullets", ok: bullets >= 3, detail: `bullets=${bullets}` },
  ];
  return { verdict: checks.every(check => check.ok) ? "pass" : "fail", checks };
}

export const questionHandoffWorkload: WorkloadDefinition = {
  id: "Q1",
  label: "Saved question settles and is answered",
  usesRepository: false,
  // Provider-fault tasks fire no restart; with --faults K* the restart lands around the question.
  fireWindowMs: [20_000, 60_000],
  budgetMs: 15 * 60_000,
  title: nonce => `Chaos Q1 question ${nonce}`,
  description,
  collect: { documents: ["brief"], files: () => [], commands: [] },
  grade: gradeQuestionHandoff,
};
