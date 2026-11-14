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
import { PREDECESSOR_RETIREMENT_UNPROVEN_CAUSE, type SessionRotation } from "./session-faults.js";

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
  answer?: QuestionAnswer;
  /** Q4: every answer the board gave, in order (`answer` is the first). */
  answers?: QuestionAnswer[];
  /** SR1: the agent configuration change made after the asking run settled, before the answer. */
  rotation?: SessionRotation;
}

export interface QuestionAnswer {
  at: number; interactionId: string; code: string; httpStatus: number | null; error: string | null;
  /** Q4: the run that asked the answered question. */
  askedByRunId?: string | null;
}

export interface QuestionArtifacts extends QuestionRecord {
  runs: Array<{ id: string; status: string; errorCode: string | null; createdAt: string | null; startedAt?: string | null;
    /** SR1: the run's normalized provider session, read only when the board replaced the session. */
    nativeSessionId?: string | null;
    /** SR1U: the run's failure cause and the sandbox it ran on. */
    failureCause?: string | null; providerLeaseId?: string | null }>;
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

/**
 * Q4: two saved questions in a row. The second is asked by the run that the first answer woke (a
 * resolved-interaction continuation), so its governed wait is saved inside a continuation run. With
 * a provider fault on that second wait (provider-faults.ts `occurrence` 2), shutdown confirmation of
 * the retained execution is late or lost, and the run's same-run resume must still settle the wait
 * by itself. Staging run e892cf75 was instead cancelled by its own recovery action.
 */
export const Q4_TONES = ["CALM", "BRISK"] as const;
export function q4Tone(nonce: string): (typeof Q4_TONES)[number] {
  return Number.parseInt(nonce.slice(-2, -1), 16) % 2 === 0 ? "CALM" : "BRISK";
}
export const q4SecondQuestion = (nonce: string) => `Which tone should the Q4-${nonce} brief use?`;
export const q4ToneMarker = (nonce: string, tone: string) => `TONE-${nonce}-${tone}`;

const q4Description = (nonce: string) => [
  "This task needs two answers from the board, one after the other, before you write anything.",
  `1. Ask exactly one question with your \`request_human_input\` tool: a questions card (continuationPolicy \`wake_assignee\`,`,
  `   idempotencyKey \`q4a-${nonce}\`) with one required single-select question "${q1Question(nonce)}"`,
  `   and exactly two options labelled \`${Q1_CODES[0]}\` and \`${Q1_CODES[1]}\`. Then end your turn and wait for the answer.`,
  "2. When you are woken with that answer, ask the second question the same way, with your `request_human_input` tool:",
  `   a questions card (continuationPolicy \`wake_assignee\`, idempotencyKey \`q4b-${nonce}\`) with one required single-select`,
  `   question "${q4SecondQuestion(nonce)}" and exactly two options labelled \`${Q4_TONES[0]}\` and \`${Q4_TONES[1]}\`.`,
  "   Then end your turn and wait for the answer.",
  "3. Never guess an answer, never ask either question twice, and create no documents, files or tasks before both answers.",
  "4. When you are woken with the second answer, save this issue's document with key `brief` (title \"Brief\"), in markdown.",
  `   It must contain the line \`${q1AnswerMarker(nonce, "<CODENAME>")}\` and the line \`${q4ToneMarker(nonce, "<TONE>")}\`, each exactly`,
  "   and on its own line, with <CODENAME> and <TONE> replaced by the chosen options, and at least three bullet points",
  "   starting with \"- \" on why a saved question must survive a provider that stops answering.",
  "5. When the document is saved, mark this task done.",
].join("\n");

function questionInteractions(rows: Json[] | null | undefined): Json[] {
  return (rows ?? []).filter(row => row.kind === "ask_user_questions");
}

type QuestionStepInput = { api: Pick<ChaosApi, "get" | "post">; issueId: string; nonce: string; record: TaskRecord;
  sample: TaskSample; now: number; boardMayAct: boolean; note: (kind: string, data: Record<string, unknown>) => void;
  /** Q4: answer each saved question once, in order. */
  sequence?: boolean;
  /** SR1: replace the saved session while the asking run's owner is still retained. */
  beforeAnswer?: () => Promise<SessionRotation> };

/** Q1 and Q4 board step, called on every poll. */
export async function questionStep(input: QuestionStepInput): Promise<void> {
  if (input.sequence) return questionSequenceStep(input);
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
  if (input.beforeAnswer && !question.rotation) {
    question.rotation = await input.beforeAnswer();
    input.note("session_rotated", { ...question.rotation });
    // Answer on a later poll, so the change is committed before the wake.
    return;
  }
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

async function questionSequenceStep(input: QuestionStepInput): Promise<void> {
  const question = input.record.question ??= { interactionIds: [], seenAt: null, askedByRunId: null, pendingNow: false };
  const answers = question.answers ??= [];
  const rows = await input.api.get<Json[]>(`/api/issues/${input.issueId}/interactions`, 5_000).catch(() => null);
  if (rows === null) return;
  const interactions = questionInteractions(rows);
  for (const interaction of interactions) if (!question.interactionIds.includes(String(interaction.id))) question.interactionIds.push(String(interaction.id));
  const pending = interactions.find(interaction => interaction.status === "pending"
    && !answers.some(answer => answer.interactionId === String(interaction.id)));
  question.pendingNow = Boolean(pending);
  if (!pending) return;
  const askedByRunId = typeof pending.sourceRunId === "string" ? pending.sourceRunId
    : (input.sample.runs ?? []).find(run => run.status === "running")?.id ?? null;
  if (question.seenAt === null) {
    question.seenAt = input.now;
    const created = Date.parse(String(pending.createdAt ?? ""));
    question.savedAt = Number.isFinite(created) ? Math.min(created, input.now) : input.now;
    question.askedByRunId = askedByRunId;
    input.note("question_pending", { interactionId: pending.id, askedByRunId, ordinal: answers.length + 1 });
  }
  // Each saved question must settle on its own first: answer only once nothing of the task is running.
  if (!input.boardMayAct || (input.sample.runs ?? []).some(run => ACTIVE.has(run.status))) return;
  const target = ((pending.payload?.questions ?? []) as Json[])[0];
  const prompt = String(target?.prompt ?? "");
  const code = prompt.includes(q4SecondQuestion(input.nonce)) ? q4Tone(input.nonce) : q1Code(input.nonce);
  const option = ((target?.options ?? []) as Json[]).find(candidate => String(candidate.label ?? "").toUpperCase().includes(code));
  const answer: QuestionAnswer = { at: input.now, interactionId: String(pending.id), code, httpStatus: null, error: null, askedByRunId };
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
  answers.push(answer);
  question.answer ??= answer;
  question.pendingNow = false;
  input.note("question_answered", { ...answer, ordinal: answers.length });
}

/** The task waits on the board while a question is pending and unanswered. */
export function awaitingQuestionAnswer(record: TaskRecord): boolean {
  if (record.question?.answers) return Boolean(record.question.pendingNow);
  return Boolean(record.question?.pendingNow) && !record.question?.answer;
}

export async function collectQuestionArtifacts(api: Pick<ChaosApi, "get">, issueId: string, record: TaskRecord): Promise<QuestionArtifacts> {
  const runs = await api.get<Json[]>(`/api/issues/${issueId}/runs`, 10_000).catch(() => []);
  const interactions = questionInteractions(await api.get<Json[]>(`/api/issues/${issueId}/interactions`, 10_000).catch(() => []));
  const question = record.question ?? { interactionIds: [], seenAt: null, askedByRunId: null, pendingNow: false };
  // SR1 proves its follow-up started a new provider session, so a pass is not a resumed session.
  const sessions = new Map<string, string | null>();
  const sandboxes = new Map<string, { failureCause: string | null; providerLeaseId: string | null }>();
  if (question.rotation) for (const run of runs ?? []) {
    const id = String(run.runId ?? run.id);
    const detail = await api.get<Json>(`/api/heartbeat-runs/${id}`, 10_000).catch(() => null);
    sessions.set(id, typeof detail?.nativeSessionId === "string" ? detail.nativeSessionId : null);
    const failureCause = detail?.resultJson?.failureCause, providerLeaseId = detail?.runnerProfileJson?.remoteWorkspace?.providerLeaseId;
    sandboxes.set(id, { failureCause: typeof failureCause === "string" ? failureCause : null,
      providerLeaseId: typeof providerLeaseId === "string" ? providerLeaseId : null });
  }
  return {
    ...question,
    interactionIds: [...new Set([...question.interactionIds, ...interactions.map(interaction => String(interaction.id))])],
    statuses: Object.fromEntries(interactions.map(interaction => [String(interaction.id), String(interaction.status)])),
    runs: (runs ?? []).map(run => ({ id: String(run.runId ?? run.id), status: String(run.status), errorCode: run.errorCode ?? null,
      createdAt: run.createdAt ?? null, startedAt: run.startedAt ?? null,
      ...(sessions.has(String(run.runId ?? run.id)) ? { nativeSessionId: sessions.get(String(run.runId ?? run.id)) } : {}),
      ...(question.rotation?.predecessorUnretirable ? sandboxes.get(String(run.runId ?? run.id)) ?? {} : {}) })),
  };
}

/** SR1: a run created after the answer used a different provider session than the asking run. */
function followUpSessionCheck(runs: QuestionArtifacts["runs"], asked: QuestionArtifacts["runs"][number] | undefined, answeredAt: number | null) {
  const followUps = runs.filter(run => run.id !== asked?.id && answeredAt !== null && run.createdAt && Date.parse(run.createdAt) > answeredAt);
  const before = asked?.nativeSessionId ?? null;
  const replaced = before !== null && followUps.some(run => typeof run.nativeSessionId === "string" && run.nativeSessionId !== before);
  return { name: "follow_up_new_session", ok: replaced,
    detail: `asked=${before ?? "unknown"} followUps=${followUps.map(run => run.nativeSessionId ?? "unknown").join(",") || "none"}` };
}

/**
 * SR1U: the retained owner could not be retired, so the follow-up's first
 * attempt failed before provider work and its retry finished on another
 * sandbox. Those pre-provider failures are the fallback, not a failed attempt.
 */
function freshSandboxChecks(runs: QuestionArtifacts["runs"], asked: QuestionArtifacts["runs"][number] | undefined, answeredAt: number | null) {
  const fellBack = runs.filter(run => run.status === "failed" && run.failureCause === PREDECESSOR_RETIREMENT_UNPROVEN_CAUSE);
  const reused = asked?.providerLeaseId ?? null;
  const fresh = runs.filter(run => run.id !== asked?.id && run.status === "succeeded" && answeredAt !== null && run.createdAt
    && Date.parse(run.createdAt) > answeredAt && typeof run.providerLeaseId === "string" && run.providerLeaseId !== reused);
  return [
    { name: "predecessor_unretirable_fell_back", ok: fellBack.length > 0, detail: fellBack.map(run => run.id).join(",") || "none" },
    { name: "follow_up_fresh_sandbox", ok: reused !== null && fresh.length > 0,
      detail: `asked=${reused ?? "unknown"} followUps=${fresh.map(run => run.providerLeaseId).join(",") || "none"}` },
  ];
}

export function gradeQuestionHandoff(nonce: string, artifacts: OracleArtifacts): OracleResult {
  const question = artifacts.question;
  const code = q1Code(nonce);
  const brief = artifacts.documents.brief ?? "";
  const bullets = brief.split(/\r?\n/).filter(line => /^\s*[-*] \S/.test(line)).length;
  const runs = question?.runs ?? [];
  const unretirable = question?.rotation?.predecessorUnretirable === true;
  const failed = runs.filter(run => (run.status === "failed" || run.status === "timed_out")
    && !(unretirable && run.failureCause === PREDECESSOR_RETIREMENT_UNPROVEN_CAUSE));
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
    ...(question?.rotation ? [followUpSessionCheck(runs, asked, answeredAt), { name: "session_rotated_before_answer", ok: question.rotation.httpStatus === 200
      && (answeredAt === null || question.rotation.at < answeredAt),
      detail: `idleTimeoutMs=${question.rotation.idleTimeoutMs} http=${question.rotation.httpStatus}${question.rotation.error ? ` ${question.rotation.error}` : ""}` }] : []),
    ...(unretirable ? freshSandboxChecks(runs, asked, answeredAt) : []),
    { name: "brief_has_answer", ok: brief.includes(q1AnswerMarker(nonce, code)), detail: q1AnswerMarker(nonce, code) },
    { name: "brief_has_three_bullets", ok: bullets >= 3, detail: `bullets=${bullets}` },
  ];
  return { verdict: checks.every(check => check.ok) ? "pass" : "fail", checks };
}

/**
 * Q4 oracle. Beyond Q1: two questions, each answered once; no run of the task failed or was
 * cancelled (staging run e892cf75 ended `cancelled` with execution_reconciliation_required);
 * both asking runs settled; the brief carries both answers.
 */
export function gradeQuestionSequence(nonce: string, artifacts: OracleArtifacts): OracleResult {
  const question = artifacts.question;
  const brief = artifacts.documents.brief ?? "";
  const bullets = brief.split(/\r?\n/).filter(line => /^\s*[-*] \S/.test(line)).length;
  const runs = question?.runs ?? [];
  const answers = question?.answers ?? [];
  const stopped = runs.filter(run => ["failed", "timed_out", "cancelled"].includes(run.status));
  const askers = answers.map(answer => answer.askedByRunId ? runs.find(run => run.id === answer.askedByRunId) : undefined);
  const statuses = Object.values(question?.statuses ?? {});
  const code = q1Code(nonce), tone = q4Tone(nonce);
  const checks = [
    { name: "issue_done", ok: artifacts.issueStatus === "done", detail: `status=${artifacts.issueStatus ?? "unknown"}` },
    { name: "two_questions_asked", ok: question?.interactionIds.length === 2, detail: `questions=${question?.interactionIds.length ?? 0}` },
    { name: "both_answered_by_board", ok: answers.length === 2 && answers.every(answer => answer.httpStatus === 200),
      detail: answers.map(answer => `${answer.code}:${answer.httpStatus}${answer.error ? ` ${answer.error}` : ""}`).join(",") || "none" },
    { name: "questions_settled", ok: statuses.length === 2 && statuses.every(status => status === "answered"), detail: statuses.join(",") || "none" },
    // The second question must come from the run the first answer woke, the case under test.
    { name: "second_asked_by_continuation", ok: askers.length === 2 && Boolean(askers[0] && askers[1]) && askers[0]!.id !== askers[1]!.id
        && Boolean(askers[1]!.createdAt) && Date.parse(askers[1]!.createdAt!) > answers[0]!.at,
      detail: askers.map(run => run ? `${run.id}@${run.createdAt ?? "?"}` : "unknown").join(",") || "none" },
    { name: "asking_runs_settled", ok: askers.length === 2 && askers.every(run => run?.status === "succeeded"),
      detail: askers.map((run, index) => run ? `${run.id}:${run.status}${run.errorCode ? `:${run.errorCode}` : ""}`
        : `run=${answers[index]?.askedByRunId ?? "unknown"}`).join(",") || "none" },
    { name: "no_failed_or_cancelled_run", ok: stopped.length === 0,
      detail: stopped.map(run => `${run.id}:${run.status}:${run.errorCode ?? ""}`).join(",") || "none" },
    { name: "brief_has_answers", ok: brief.includes(q1AnswerMarker(nonce, code)) && brief.includes(q4ToneMarker(nonce, tone)),
      detail: `${q1AnswerMarker(nonce, code)} ${q4ToneMarker(nonce, tone)}` },
    { name: "brief_has_three_bullets", ok: bullets >= 3, detail: `bullets=${bullets}` },
  ];
  return { verdict: checks.every(check => check.ok) ? "pass" : "fail", checks };
}

export const questionSequenceWorkload: WorkloadDefinition = {
  id: "Q4",
  label: "Second saved question, asked by the first answer's continuation, settles and is answered",
  usesRepository: false,
  fireWindowMs: [20_000, 60_000],
  budgetMs: 20 * 60_000,
  title: nonce => `Chaos Q4 question sequence ${nonce}`,
  description: q4Description,
  collect: { documents: ["brief"], files: () => [], commands: [] },
  grade: gradeQuestionSequence,
};

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
