import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { withProviderFaultRules } from "./provider-faults.js";
import {
  awaitingQuestionAnswer, gradeQuestionHandoff, gradeQuestionSequence, q1AnswerMarker, q1Code, q4SecondQuestion, q4Tone, q4ToneMarker,
  questionStep, type QuestionArtifacts,
} from "./question-handoff.js";
import type { OracleArtifacts, TaskRecord, TaskSample } from "./types.js";
import { workloadDefinitions } from "./workloads.js";

const NONCE = "0bcd1234";
const record = () => ({ plan: {}, issueId: "i1" } as unknown as TaskRecord);
const sample = (status: string): TaskSample => ({ at: 0, reachable: true, serverReady: true,
  runs: [{ id: "run-1", status, createdAt: null, startedAt: null, finishedAt: null, errorCode: null, retryOfRunId: null, wakeCommentIds: [], livenessState: null }] });

function fakeApi(interactions: Array<Record<string, unknown>>) {
  const posts: Array<{ route: string; body: unknown }> = [];
  return { posts, api: {
    async get<T>(route: string) { return (route.endsWith("/interactions") ? interactions : []) as T; },
    async post<T>(route: string, body?: unknown) { posts.push({ route, body }); return {} as T; },
  } };
}

const pendingQuestion = { id: "q1", kind: "ask_user_questions", status: "pending", sourceRunId: "run-1",
  payload: { questions: [{ id: "codename", options: [{ id: "opt-a", label: "ALPHA" }, { id: "opt-b", label: "BRAVO" }] }] } };

describe("Q4 second saved question from a continuation", () => {
  const second = { id: "q2", kind: "ask_user_questions", status: "pending", sourceRunId: "run-1",
    payload: { questions: [{ id: "tone", prompt: q4SecondQuestion(NONCE), options: [{ id: "opt-c", label: "CALM" }, { id: "opt-d", label: "BRISK" }] }] } };

  it("is an opt-in provider-fault workload whose fault takes the second interrupt", () => {
    expect(workloadDefinitions.Q4.description(NONCE)).toContain(q4SecondQuestion(NONCE));
    const command = parseCommand(["--adapters", "codex", "--workloads", "Q4", "--faults", "PV2"]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options.workloads).toEqual(["Q4"]);
    const plain = parseCommand(["--adapters", "codex,claude"]);
    if (plain.mode !== "wave") throw new Error("expected a wave");
    expect(plain.options.workloads).not.toContain("Q4");
    const [planned] = withProviderFaultRules([{ taskId: "t01", index: 0, workload: "Q4", adapter: "codex", fault: "PV2",
      fireAfterMs: 0, holdMs: 0, followUpAfterMs: null, nonce: NONCE }], {});
    expect(planned!.providerFault).toMatchObject({ kind: "PV2", message: "terminal", occurrence: 2 });
  });

  it("answers each question once, after its asking run settled, with the nonce's options", async () => {
    const task = record();
    const interactions: Array<Record<string, unknown>> = [pendingQuestion];
    const { api, posts } = fakeApi(interactions);
    const step = (status: string, now: number) => questionStep({ api, issueId: "i1", nonce: NONCE, record: task, sample: sample(status), now,
      boardMayAct: true, sequence: true, note: () => undefined });
    await step("running", 1_000);
    expect(awaitingQuestionAnswer(task)).toBe(true);
    await step("succeeded", 2_000);
    interactions[0] = { ...pendingQuestion, status: "answered" };
    await step("succeeded", 2_500);
    expect(awaitingQuestionAnswer(task)).toBe(false);
    interactions.push(second);
    await step("running", 3_000);
    expect(posts).toHaveLength(1);
    await step("succeeded", 4_000);
    await step("succeeded", 5_000);
    expect(posts.map(post => post.route)).toEqual(["/api/issues/i1/interactions/q1/respond", "/api/issues/i1/interactions/q2/respond"]);
    expect(posts[1]!.body).toEqual({ answers: [{ questionId: "tone", optionIds: [q4Tone(NONCE) === "CALM" ? "opt-c" : "opt-d"] }] });
    expect(task.question?.answers?.map(answer => answer.code)).toEqual([q1Code(NONCE), q4Tone(NONCE)]);
  });

  it("fails a cancelled run, as staging run e892cf75 ended", () => {
    const artifacts = (status: string, errorCode: string | null): OracleArtifacts => ({ issueStatus: "done", agentComments: [], files: {}, commands: {},
      workspacePath: null, documents: { brief: `${q1AnswerMarker(NONCE, q1Code(NONCE))}\n${q4ToneMarker(NONCE, q4Tone(NONCE))}\n- a\n- b\n- c\n` },
      question: { interactionIds: ["q1", "q2"], seenAt: 1, askedByRunId: "run-1", pendingNow: false, statuses: { q1: "answered", q2: "answered" },
        answers: [{ at: 2, interactionId: "q1", code: q1Code(NONCE), httpStatus: 200, error: null, askedByRunId: "run-1" },
          { at: 4, interactionId: "q2", code: q4Tone(NONCE), httpStatus: 200, error: null, askedByRunId: "run-2" }],
        runs: [{ id: "run-1", status: "succeeded", errorCode: null, createdAt: null }, { id: "run-2", status, errorCode, createdAt: null },
          { id: "run-3", status: "succeeded", errorCode: null, createdAt: null }] } });
    expect(gradeQuestionSequence(NONCE, artifacts("succeeded", null)).verdict).toBe("pass");
    const cancelled = gradeQuestionSequence(NONCE, artifacts("cancelled", "execution_reconciliation_required"));
    expect(cancelled.checks.filter(check => !check.ok).map(check => check.name)).toEqual(["asking_runs_settled", "no_failed_or_cancelled_run"]);
  });
});

describe("Q1 saved question", () => {
  it("is registered as an opt-in workload", () => {
    expect(workloadDefinitions.Q1.id).toBe("Q1");
    const command = parseCommand(["--adapters", "codex,claude"]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options.workloads).not.toContain("Q1");
    expect(workloadDefinitions.Q1.description(NONCE)).toContain("request_human_input");
  });

  it("waits for the asking run to settle, then answers once with the nonce's option", async () => {
    const task = record();
    const { api, posts } = fakeApi([pendingQuestion]);
    const notes: string[] = [];
    const step = (status: string, now: number) => questionStep({ api, issueId: "i1", nonce: NONCE, record: task, sample: sample(status), now,
      boardMayAct: true, note: kind => notes.push(kind) });
    await step("running", 1_000);
    expect(task.question).toMatchObject({ seenAt: 1_000, askedByRunId: "run-1", pendingNow: true });
    expect(awaitingQuestionAnswer(task)).toBe(true);
    expect(posts).toHaveLength(0);
    await step("succeeded", 2_000);
    expect(posts).toEqual([{ route: "/api/issues/i1/interactions/q1/respond",
      body: { answers: [{ questionId: "codename", optionIds: [q1Code(NONCE) === "ALPHA" ? "opt-a" : "opt-b"] }] } }]);
    expect(awaitingQuestionAnswer(task)).toBe(false);
    await step("succeeded", 3_000);
    expect(posts).toHaveLength(1);
    expect(notes).toEqual(["question_pending", "question_answered"]);
  });

  it("does not answer while the board may not act (fault in progress)", async () => {
    const task = record();
    const { api, posts } = fakeApi([pendingQuestion]);
    await questionStep({ api, issueId: "i1", nonce: NONCE, record: task, sample: sample("succeeded"), now: 1, boardMayAct: false, note: () => undefined });
    expect(posts).toHaveLength(0);
    expect(awaitingQuestionAnswer(task)).toBe(true);
  });

  const question = (overrides: Partial<QuestionArtifacts> = {}): QuestionArtifacts => ({ interactionIds: ["q1"], seenAt: 1_000, askedByRunId: "run-1",
    pendingNow: false, answer: { at: 5_000, interactionId: "q1", code: q1Code(NONCE), httpStatus: 200, error: null }, statuses: { q1: "answered" },
    runs: [{ id: "run-1", status: "succeeded", errorCode: null, createdAt: new Date(500).toISOString() },
      { id: "run-2", status: "succeeded", errorCode: null, createdAt: new Date(6_000).toISOString() }], ...overrides });
  const artifacts = (overrides: Partial<QuestionArtifacts> = {}): OracleArtifacts => ({ issueStatus: "done",
    documents: { brief: `${q1AnswerMarker(NONCE, q1Code(NONCE))}\n- a\n- b\n- c\n` }, agentComments: [], files: {}, commands: {}, workspacePath: null,
    question: question(overrides) });

  it("passes a saved question that settled once and was answered", () => {
    expect(gradeQuestionHandoff(NONCE, artifacts())).toMatchObject({ verdict: "pass" });
  });

  it("fails a failed attempt, a repeated question or work before the answer", () => {
    const failed = gradeQuestionHandoff(NONCE, artifacts({ runs: [{ id: "run-1", status: "failed", errorCode: "governed_wait_provider_terminal_unproven", createdAt: null }] }));
    expect(failed.verdict).toBe("fail");
    expect(failed.checks.filter(check => !check.ok).map(check => check.name)).toEqual(expect.arrayContaining(["asking_run_settled", "no_failed_attempt"]));
    expect(gradeQuestionHandoff(NONCE, artifacts({ interactionIds: ["q1", "q2"] })).checks.find(check => check.name === "one_question_asked")?.ok).toBe(false);
    const between = gradeQuestionHandoff(NONCE, artifacts({ runs: [...question().runs, { id: "run-3", status: "succeeded", errorCode: null, createdAt: new Date(3_000).toISOString() }] }));
    expect(between.checks.find(check => check.name === "nothing_ran_before_answer")?.ok).toBe(false);
  });

  it("measures the wait from when the question was saved, and counts a queued run that starts during it", () => {
    const check = (overrides: Partial<QuestionArtifacts>) => gradeQuestionHandoff(NONCE, artifacts(overrides)).checks
      .find(candidate => candidate.name === "nothing_ran_before_answer")?.ok;
    // Created after the save but before the first poll saw the question.
    expect(check({ savedAt: 800, runs: [...question().runs, { id: "run-3", status: "succeeded", errorCode: null, createdAt: new Date(900).toISOString() }] })).toBe(false);
    // Queued before the save, started while the question waited.
    expect(check({ savedAt: 800, runs: [...question().runs, { id: "run-3", status: "succeeded", errorCode: null,
      createdAt: new Date(100).toISOString(), startedAt: new Date(2_000).toISOString() }] })).toBe(false);
    expect(check({ savedAt: 800 })).toBe(true);
  });

  it("records when the question was saved", async () => {
    const task = record();
    const { api } = fakeApi([{ ...pendingQuestion, createdAt: new Date(400).toISOString() }]);
    await questionStep({ api, issueId: "i1", nonce: NONCE, record: task, sample: sample("running"), now: 1_000, boardMayAct: true, note: () => undefined });
    expect(task.question).toMatchObject({ seenAt: 1_000, savedAt: 400 });
  });
});
