import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { awaitingQuestionAnswer, gradeQuestionHandoff, q1AnswerMarker, q1Code, questionStep, type QuestionArtifacts } from "./question-handoff.js";
import { planTasks, taskFaultSchedule } from "./scheduler.js";
import { rotateAgentSession } from "./session-faults.js";
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

  describe("SR1: session replaced while the asking owner is retained", () => {
    it("is a warm Q1-only fault that schedules no restart", () => {
      const command = parseCommand(["--adapters", "codex", "--workloads", "Q1", "--faults", "SR1", "--lifecycle", "warm", "--tasks", "2", "--concurrency", "2"]);
      if (command.mode !== "wave") throw new Error("expected a wave");
      expect(command.options).toMatchObject({ faults: [], sessionFaults: ["SR1"] });
      const tasks = planTasks(command.options);
      expect(tasks.map(task => task.fault)).toEqual(["SR1", "SR1"]);
      expect(tasks.flatMap(taskFaultSchedule)).toEqual([]);
      expect(() => parseCommand(["--workloads", "Q1", "--faults", "SR1"])).toThrow("--lifecycle warm");
      expect(() => parseCommand(["--workloads", "A1", "--faults", "SR1", "--lifecycle", "warm"])).toThrow("remove A1");
      expect(() => parseCommand(["--workloads", "Q1", "--faults", "SR1,K1", "--lifecycle", "warm"])).toThrow("without K* or PV*");
    });

    it("changes the agent's session configuration after the asking run settles, then answers on a later poll", async () => {
      const task = record();
      const { api, posts } = fakeApi([pendingQuestion]);
      const patches: Array<{ route: string; body: unknown }> = [];
      const patchApi = { async patch<T>(route: string, body?: unknown) { patches.push({ route, body }); return {} as T; } };
      const notes: string[] = [];
      const step = (status: string, now: number) => questionStep({ api, issueId: "i1", nonce: NONCE, record: task, sample: sample(status), now,
        boardMayAct: true, note: kind => notes.push(kind), beforeAnswer: () => rotateAgentSession(patchApi, "agent-1", 1, now) });
      await step("running", 1_000);
      expect(patches).toHaveLength(0);
      await step("succeeded", 2_000);
      expect(patches).toEqual([{ route: "/api/agents/agent-1", body: { adapterConfig: { idleTimeoutMs: 300_002 } } }]);
      expect(posts).toHaveLength(0);
      await step("succeeded", 3_000);
      expect(patches).toHaveLength(1);
      expect(posts).toHaveLength(1);
      expect(notes).toEqual(["question_pending", "session_rotated", "question_answered"]);
      const graded = gradeQuestionHandoff(NONCE, artifacts({ rotation: task.question!.rotation }));
      expect(graded.checks.find(check => check.name === "session_rotated_before_answer")).toMatchObject({ ok: true });
      // A resumed session would not exercise the superseded-owner retirement.
      expect(graded.checks.find(check => check.name === "follow_up_new_session")).toMatchObject({ ok: false });
      const sessions = (first: string, second: string) => question({ rotation: task.question!.rotation }).runs
        .map((run, index) => ({ ...run, nativeSessionId: index === 0 ? first : second }));
      const replaced = gradeQuestionHandoff(NONCE, artifacts({ rotation: task.question!.rotation, runs: sessions("s1", "s2") }));
      expect(replaced).toMatchObject({ verdict: "pass" });
      expect(gradeQuestionHandoff(NONCE, artifacts({ rotation: task.question!.rotation, runs: sessions("s1", "s1") })).verdict).toBe("fail");
      const refused = gradeQuestionHandoff(NONCE, artifacts({ rotation: { at: 2_000, idleTimeoutMs: 300_002, httpStatus: 422, error: "invalid" } }));
      expect(refused.verdict).toBe("fail");
    });
  });
});
