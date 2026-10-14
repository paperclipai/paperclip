import { captureFirstTaskAttachments } from "./first-task-attachments.js";
import type { RunnerApi } from "./api.js";
import { renderRunnerE2EDashboard } from "./dashboard.js";
import { waitForFirstTaskReply } from "./first-task-replies.js";
import { firstTaskRejectionReplyRecorded, isFirstTaskRejectionCancellation } from "./first-task-rejection.js";
import { createIssueThreadInteractionSchema } from "../../packages/shared/src/validators/issue.js";
import { renderInteractionCard } from "./interaction-report.js";
import { main as judgeCommand } from "./first-task-judge.js";
import { projectFirstTaskResult, managedFirstTaskFileCheck, observeManagedFirstTaskSetup } from "./first-task-flow.js";
import { validateRetainedRunnerResult } from "./result-validation.js";
import { buildRuntimeUsage } from "./billing.js";
import { fixtureRuntimeCostCoverage, selectFixtureRuntimeLeases } from "./live-fixtures.js";
import {
  firstTaskNativeRuntimePatch,
  provisionFirstTaskFixtures,
  startFirstTaskWithRuntimeBound,
  MANAGED_FIRST_TASK_CELL,
} from "./first-task-fixtures.js";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runnerMatrix } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { firstTaskScenario, FIRST_TASK_CASES } from "./first-task-cases.js";
import {
  digestText,
  snapshotInstruction,
  gradeFirstTask,
  gradeNativeSessionContinuity,
  firstTaskCompletionSettled,
  type FirstTaskEvidence,
  type FirstTaskCheckpoint,
} from "./first-task-scoring.js";
import {
  FIRST_TASK_JUDGE_CONFIG,
  QUALITY_DIMENSIONS,
  judgeFirstTask,
  pendingQuality,
  qualityInput,
  validateQualityScores,
} from "./first-task-quality.js";
import { renderFirstTaskDetails } from "./first-task-report.js";
import {
  summarizeExecutionBilling,
  aggregateCampaignBilling,
} from "./billing.js";
import { packageEvidence } from "./evidence.js";
import type { RunnerE2EResult } from "./types.js";

function recording(caseId = "task-reply-accept"): FirstTaskEvidence {
  const scenario = firstTaskScenario(caseId, "test-nonce");
  const task = {
    id: "onboarding",
    status: "in_review",
    title: "Welcome",
    description: "/first-task",
  };
  const opening: FirstTaskCheckpoint = {
    id: "opening-0",
    phase: "opening",
    at: "2026-09-15T00:00:00Z",
    issueId: task.id,
    tasks: [task],
    agents: [{ id: "agent" }],
    comments: [
      { id: "greeting", authorAgentId: "agent", body: "Welcome to Paperclip" },
    ],
    interactions: [
      {
        id: "opening",
        kind: "ask_user_questions",
        status: "pending",
        payload: {
          questions: [
            {
              id: "first-task-opening",
              selectionMode: "single",
              options: [
                { id: "interview", label: "Interview me" },
                { id: "task", label: "I have a task in mind", freeText: true },
              ],
            },
          ],
        },
      },
    ],
    documents: [],
    runs: [],
  };
  const response = structuredClone(opening);
  Object.assign(response, {
    id: "response-1",
    phase: "response",
    at: "2026-09-15T00:01:00Z",
    runs: [{ id: "parent-run", status: "succeeded" }],
  });
  response.comments.push({
    id: "proposal",
    authorAgentId: "agent",
    body: "I propose one subtask to write the garden club welcome note. Shall I proceed?",
  });
  response.interactions[0].status = "answered";
  const accepted = structuredClone(response);
  Object.assign(accepted, {
    id: "accepted-2",
    phase: "accepted",
    at: "2026-09-15T00:02:00Z",
  });
  accepted.comments.push({
    id: "yes",
    body: scenario.acceptance,
    authorUserId: "board",
  });
  const finished = structuredClone(accepted);
  Object.assign(finished, {
    id: "finished-3",
    phase: "finished",
    at: "2026-09-15T00:03:00Z",
  });
  finished.tasks.push({
    id: "child",
    title: "Garden welcome note",
    status: "done",
    description: "",
    parentId: "onboarding",
    assigneeAgentId: "agent",
    createdAt: "2026-09-15T00:02:02Z",
  } as any);
  finished.documents.push({
    id: "note",
    issueId: "child",
    key: "welcome",
    body: `Welcome beginners to our free Saturday meetup. ${scenario.marker}`,
  });
  finished.runs.push({ id: "child-run", status: "succeeded" });
  return {
    caseId,
    nonce: "test-nonce",
    onboardingIssueId: "onboarding",
    agentId: "agent",
    initialTaskIds: ["onboarding"],
    instructions: ["AGENTS.md", "first-task/SKILL.md"].map((p) => ({
      path: p,
      content: `Full ${p}`,
      sha256: digestText(`Full ${p}`),
    })),
    configuredModel: "configured-model",
    observedModels: ["observed-model"],
    checkpoints: [opening, response, accepted, finished],
    checks: [],
  };
}
/** Reduced lifecycle evidence from gha-36307603818-1 / reject-no-execution.
 * The decision checkpoint models the repaired capture order, not a historical regrade. */
function rejectionRecording(): FirstTaskEvidence {
  const e = recording("reject-no-execution");
  const rejected = e.checkpoints[2];
  rejected.phase = "rejected";
  rejected.comments[rejected.comments.length - 1] = {
    id: "no", issueId: "onboarding", authorUserId: "board",
    body: firstTaskScenario(e.caseId, e.nonce).rejection,
    createdAt: "2026-09-15T00:02:00.100Z",
  };
  const last = e.checkpoints[3];
  last.tasks = [{ ...last.tasks[0], status: "cancelled" }];
  last.documents = [];
  last.runs = [...rejected.runs, {
    id: "refusal-run", agentId: "agent", status: "cancelled", errorCode: "cancelled",
    error: "Cancelled by control plane", startedAt: "2026-09-15T00:02:01Z", finishedAt: "2026-09-15T00:02:15Z",
    contextSnapshot: { issueId: "onboarding", commentId: "no", wakeCommentId: "no" },
  }];
  last.comments = [...rejected.comments, {
    id: "ack", issueId: "onboarding", authorAgentId: "agent", createdByRunId: "refusal-run",
    body: "Understood. Stopped at your request. No welcome note or child task was created.",
    createdAt: "2026-09-15T00:02:15.100Z",
  }];
  return e;
}

function result(e = recording()): RunnerE2EResult {
  return {
    schema: "paperclip.runner-e2e.result/v2",
    suiteId: "first-task",
    executionId: `first-task.legacy-codex.local.${e.caseId}`,
    attempt: 1,
    status: "failed",
    profileId: "legacy-codex",
    environmentId: "local",
    caseId: e.caseId,
    provider: "openai",
    model: "observed-model",
    runtimeMode: "legacy",
    runIds: ["parent-run", "child-run"],
    startedAt: "2026-09-15T00:00:00Z",
    finishedAt: "2026-09-15T00:03:00Z",
    durationMs: 180000,
    cleanup: "passed",
    firstTask: e,
    usage: {
      runs: [
        {
          runId: "parent-run",
          usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
        },
        {
          runId: "child-run",
          usage: { inputTokens: 200, outputTokens: 40, costUsd: 0.02 },
        },
      ],
    },
  };
}
const failed = (e: FirstTaskEvidence) =>
  gradeFirstTask(e)
    .filter((c) => !c.passed)
    .map((c) => c.id);
const scores = () =>
  QUALITY_DIMENSIONS.map((dimension) => ({
    dimension,
    score: 4,
    rationale: "Concrete and relevant",
    evidence: ["response-1"],
  }));

describe("first-task public result projection", () => {
  it("keeps fixture-visible evidence while excluding private records from both normalized result fields", () => {
    const e = recording();
    const sentinel = "PRIVATE_SESSION_ACCOUNT_SENTINEL";
    e.instructions[0].content = sentinel;
    e.instructions[0].path = `/private/${sentinel}/AGENTS.md`;
    e.runtimeSettings = {
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "gpt-5.6-sol", env: { OPENAI_API_KEY: sentinel }, codexHome: sentinel },
      runtimeConfig: { accountId: sentinel }, permissions: { privateTrace: sentinel },
      onboardingRuntime: { mode: "production-wizard", originalAdapterType: "paperclip_runner", testedAdapterType: "paperclip_runner", accountId: sentinel },
      onboardingRuntimeBound: { timeoutSec: 180, maxConcurrentRuns: 1, before: { runtimeConfig: { accountId: sentinel } }, after: { runtimeConfig: { accountId: sentinel } } },
    };
    for (const checkpoint of e.checkpoints) {
      checkpoint.tasks.forEach(t => Object.assign(t, { executionState: { sessionId: sentinel }, responsibleUserId: sentinel }));
      checkpoint.agents.forEach(a => Object.assign(a, { accountId: sentinel, metadata: { auth: sentinel }, adapterType: "paperclip_runner",
        adapterConfig: { provider: "codex", model: "gpt-5.6-sol", env: { TOKEN: sentinel }, home: sentinel } }));
      checkpoint.comments.forEach(c => Object.assign(c, { hiddenReasoning: sentinel, metadata: { sessionId: sentinel },
        ...(c.authorUserId ? { authorUserId: sentinel } : {}) }));
      checkpoint.interactions.forEach(i => Object.assign(i, { nativeQuestionId: sentinel, metadata: { sessionId: sentinel },
        payload: { ...i.payload, providerSessionId: sentinel, toolAction: { secret: sentinel } },
        result: { ...i.result, outcome: "answered", refreshToken: sentinel } }));
      checkpoint.documents.forEach(d => Object.assign(d, { privateStorageRef: sentinel }));
      checkpoint.runs.forEach(r => Object.assign(r, { nativeSessionId: sentinel, sessionIdBefore: sentinel, sessionIdAfter: sentinel,
        runnerProfileJson: { sessionCheckpoint: { providerSessionId: sentinel } }, contextSnapshot: { home: sentinel },
        resultJson: { model: "gpt-5.6-sol", privateAuth: sentinel }, stdoutExcerpt: sentinel, error: sentinel }));
    }
    e.checks = gradeFirstTask(e);
    e.checks.push({ id: "native-session-continuity", passed: false, evidence: ["finished-3"], detail: sentinel });
    const original = structuredClone(e);
    const raw = { ...result(e), error: sentinel, failureClass: "candidate_failure" as const,
      usage: { runs: [{ runId: "parent-run", usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30,
        costUsdExact: "0.499592800", costUsd: null, costStatus: "estimated", accountingReceiptReady: true,
        pricingProvenance: { source: "rate_card", version: "openai-standard-2026-09-30", accountId: sentinel },
        persistedSessionId: sentinel, providerRequestId: sentinel, accountingReceiptSourceId: sentinel } }] },
      matcherResults: e.checks.map(c => ({ matcher: { kind: "json_path" as const, path: `firstTask.checks.${c.id}`, expected: true }, passed: c.passed, detail: c.detail })) };
    raw.matcherResults.push({ matcher: { kind: "json_path", path: "cleanup.provider-retired", expected: true }, passed: false, detail: sentinel });
    const projected = projectFirstTaskResult(raw);
    const normalized = { results: [projected] };
    expect(JSON.stringify(normalized)).not.toContain(sentinel);
    expect(JSON.stringify(raw)).toContain(sentinel);
    expect(e).toEqual(original);
    expect(projected.firstTask!.checks.map(c => ({ id: c.id, passed: c.passed, notReached: Boolean(c.notReached) })))
      .toEqual(e.checks.map(c => ({ id: c.id, passed: c.passed, notReached: Boolean(c.notReached) })));
    expect(projected.matcherResults!.map(c => ({ matcher: c.matcher, passed: c.passed })))
      .toEqual(raw.matcherResults.map(c => ({ matcher: c.matcher, passed: c.passed })));
    expect(projected.firstTask!.runtimeSettings).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-sol" } });
    expect(projected.usage).toMatchObject({ runs: [{ runId: "parent-run", usage: { inputTokens: 100, outputTokens: 20,
      cachedInputTokens: 30, costUsdExact: "0.499592800", costStatus: "estimated", accountingReceiptReady: true,
      pricingProvenance: { source: "rate_card", version: "openai-standard-2026-09-30" } } }] });
    expect(summarizeExecutionBilling(projected)).toEqual(summarizeExecutionBilling(raw));
    expect(qualityInput(projected.firstTask!)).toContain(firstTaskScenario(e.caseId, e.nonce).acceptance);
    expect(qualityInput(projected.firstTask!)).toContain(firstTaskScenario(e.caseId, e.nonce).marker);
    expect(renderFirstTaskDetails(projected)).not.toContain(sentinel);
    expect(projected.firstTask!.checkpoints.at(-1)!.documents[0].body).toBe(e.checkpoints.at(-1)!.documents[0].body);
    validateRetainedRunnerResult(projected);
  });

  it("preserves failures, unreached checks, cleanup controls and private artifact hashes", () => {
    const e = recording();
    e.checks = [{ id: "recorded-response", passed: false, evidence: ["response-1"], detail: "private diagnostic" },
      { id: "durable-completion", passed: false, notReached: "private interrupted-session reason", evidence: ["finished-3"], detail: "private diagnostic" }];
    const raw = { ...result(e), error: "private transport/session error", failureClass: "candidate_failure" as const, cleanup: "failed" as const,
      matcherResults: [{ matcher: { kind: "json_path" as const, path: "cleanup.provider-retired", expected: true }, passed: false, detail: "private process details" }] };
    const projected = projectFirstTaskResult(raw);
    expect(projected).toMatchObject({ status: "failed", failureClass: "candidate_failure", cleanup: "failed" });
    expect(projected.firstTask!.checks[0].passed).toBe(false);
    expect(projected.firstTask!.checks[1]).toMatchObject({ passed: false, notReached: expect.any(String) });
    expect(projected.matcherResults![0]).toMatchObject({ matcher: raw.matcherResults[0].matcher, passed: false });
    expect(projected.firstTask!.instructions[0]).toMatchObject({ sha256: e.instructions[0].sha256, redacted: true });
    expect(raw.error).toBe("private transport/session error");
    expect(projected.error).not.toContain("private transport/session error");
    expect(projectFirstTaskResult(projected)).toEqual(projected);
  });
});

describe("first-task attachment evidence", () => {
  it("reads persisted bytes, verifies their hash, and redacts the retained text", async () => {
    const body = "Welcome SECRET-VALUE";
    const attachment = { id: "attachment", issueId: "child", byteSize: Buffer.byteLength(body), sha256: digestText(body), contentType: "text/markdown" };
    const request = { get: vi.fn().mockResolvedValue({ ok: () => true, body: async () => Buffer.from(body) }) };
    const api = { get: vi.fn().mockResolvedValue([attachment]), request } as unknown as RunnerApi;
    const rows = await captureFirstTaskAttachments(api, [{ id: "child" }], ["SECRET-VALUE"]);
    expect(rows[0]).toMatchObject({ issueId: "child", contentVerified: true });
    expect(rows[0].body).not.toContain("SECRET-VALUE");
    expect(rows[0].contentSha256).toBe(digestText(rows[0].body));
    expect(request.get).toHaveBeenCalledWith("/api/attachments/attachment/content");
    attachment.sha256 = "wrong";
    await expect(captureFirstTaskAttachments(api, [{ id: "child" }], [])).rejects.toThrow("hash mismatch");
  });

  it("retains unavailable text as metadata without claiming verified content", async () => {
    const request = { get: vi.fn() };
    const api = { get: vi.fn().mockResolvedValue([{ id: "binary", contentType: "application/pdf", byteSize: 100 }]), request } as unknown as RunnerApi;
    expect(await captureFirstTaskAttachments(api, [{ id: "child" }], [])).toEqual([{ id: "binary", issueId: "child", contentType: "application/pdf", byteSize: 100 }]);
    expect(request.get).not.toHaveBeenCalled();
  });
});

describe("first-task question presentation grading", () => {
  it("documents an API-valid text card that renders without a one-option choice", async () => {
    const reference = await readFile(
      new URL(
        "../../skills/paperclip/references/api-reference.md",
        import.meta.url,
      ),
      "utf8",
    );
    const section = reference.slice(
      reference.indexOf("For an open-ended answer,"),
    );
    const example = section.match(/```json\nPOST [^\n]+\n([\s\S]*?)\n```/)![1];
    const parsed = createIssueThreadInteractionSchema.parse(
      JSON.parse(example),
    );
    const card = { id: "documented-text-card", ...parsed };
    const rendered = renderInteractionCard(card);
    expect(rendered).toContain("Write your answer");
    expect(rendered).not.toContain("Choose one");
    expect(rendered).not.toContain('type="radio"');
    const e = recording();
    e.checkpoints[1].interactions.push(card);
    expect(failed(e)).toEqual([]);
  });

  const choiceCheck = (e: FirstTaskEvidence) =>
    gradeFirstTask(e).find((check) => check.id === "question-choice-options")!;
  const question = {
    id: "organization",
    prompt: "What does your organization do?",
    selectionMode: "single",
    options: [{ id: "describe", label: "I'll describe it", freeText: true }],
  };

  it.each(["single", "multi"])(
    "fails the recorded one-option legacy %s form with actionable evidence",
    (selectionMode) => {
      const e = recording();
      e.checkpoints[1].interactions.push({
        id: "bad-card",
        kind: "ask_user_questions",
        payload: { questions: [{ ...question, selectionMode }] },
      });
      const check = choiceCheck(e);
      expect(check.passed).toBe(false);
      expect(check.evidence).toEqual(["response-1"]);
      expect(check.detail).toContain("bad-card / organization");
      expect(check.detail).toContain(question.prompt);
      expect(check.detail).toContain("has 1 distinct choice option(s)");
    },
  );

  it.each(["single_select", "multi_select"])(
    "does not count custom text as a second %s choice",
    (answerMode) => {
      const e = recording();
      e.checkpoints[1].interactions.push({
        id: "bad-card",
        kind: "ask_user_questions",
        payload: {
          questionSet: {
            questions: [
              {
                ...question,
                answerMode,
                options: [{ id: "yes", label: "Yes" }],
                customAnswer: { enabled: true },
              },
            ],
          },
        },
      });
      expect(choiceCheck(e).passed).toBe(false);
    },
  );

  it("accepts canonical text presentation over its single-option storage fallback", () => {
    const e = recording();
    e.checkpoints[1].interactions.push({
      id: "text-card",
      kind: "ask_user_questions",
      payload: {
        questions: [question],
        questionSet: {
          questions: [
            { id: question.id, prompt: question.prompt, answerMode: "text" },
          ],
        },
      },
    });
    expect(choiceCheck(e).passed).toBe(true);
    // Includes the production opening's two paths, one with a text field.
    expect(failed(e)).toEqual([]);
  });

  it("catches later/superseded invalid presentations and deduplicates repeated snapshots", () => {
    const e = recording();
    const card = {
      id: "later-card",
      kind: "ask_user_questions",
      status: "pending",
      payload: { questions: [question] },
    };
    e.checkpoints[2].interactions.push(card);
    e.checkpoints[3].interactions.push({ ...card, status: "superseded" });
    const check = choiceCheck(e);
    expect(check.passed).toBe(false);
    expect(check.evidence).toEqual(["accepted-2"]);
    expect(check.detail.match(/later-card/g)).toHaveLength(1);
    e.checkpoints[3].interactions.at(-1)!.payload = {
      questionSet: { questions: [{ id: question.id, answerMode: "text" }] },
    };
    expect(choiceCheck(e).passed).toBe(false);
  });

  it("rejects empty or duplicate labels but accepts two distinct choices", () => {
    const e = recording();
    const q = {
      ...question,
      options: [
        { id: "a", label: "Yes" },
        { id: "b", label: " yes " },
        { id: "empty", label: " " },
      ],
    };
    e.checkpoints[1].interactions.push({
      id: "choices",
      kind: "ask_user_questions",
      payload: { questions: [q] },
    });
    expect(choiceCheck(e).passed).toBe(false);
    q.options = [
      { id: "a", label: "Yes" },
      { id: "b", label: "No" },
    ];
    expect(choiceCheck(e).passed).toBe(true);
  });

  it("still reports a bad card when the run never reached a settled response", () => {
    const e = recording();
    e.checkpoints = e.checkpoints.slice(0, 1);
    e.checkpoints[0].interactions.push({
      id: "bad-card",
      kind: "ask_user_questions",
      payload: { questions: [question] },
    });
    expect(failed(e)).toContain("question-choice-options");
  });
});

describe("first-task fixtures and state grading", () => {
  it("waits past optimistic submission until a new user acceptance is persisted", async () => {
    vi.useFakeTimers();
    try {
      const message = "Yes, I accept that proposal. Please do it.";
      const old = { id: "previous", body: message };
      const agent = { id: "agent-echo", authorAgentId: "agent", body: message };
      const user = {
        id: "new-user-reply",
        authorUserId: "board",
        body: message,
      };
      const load = vi
        .fn()
        .mockResolvedValueOnce([old])
        .mockResolvedValueOnce([old, agent])
        .mockResolvedValue([old, agent, user]);
      const waiting = waitForFirstTaskReply({
        load,
        message,
        previousIds: new Set([old.id]),
        deadlineAt: Date.now() + 1000,
      });
      await vi.runAllTimersAsync();
      expect(await waiting).toContainEqual(user);
      expect(load).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not record acceptance when only an unrelated new user reply arrives", async () => {
    vi.useFakeTimers();
    try {
      const waiting = waitForFirstTaskReply({
        load: async () => [
          { id: "clarification", body: "The meetup is Sunday." },
        ],
        message: "Yes, I accept that proposal. Please do it.",
        previousIds: new Set(),
        deadlineAt: Date.now() + 200,
      });
      const assertion = expect(waiting).rejects.toThrow(
        "first-task user reply persisted",
      );
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("recognizes a proposed task presented only in a confirmation card", () => {
    const e = recording("clear-task-first-response");
    e.checkpoints = e.checkpoints.slice(0, 2);
    e.checkpoints[1].comments.pop();
    e.checkpoints[1].interactions.push({
      id: "proposal-card",
      kind: "request_confirmation",
      status: "pending",
      payload: {
        prompt:
          "Proposed task: Write a two-sentence welcome note for the neighborhood garden club that invites beginners to the free Saturday meetup. I will save the finished note as a document attached to FIR-1. Approve this task so I can create it.",
      },
    });
    expect(failed(e)).toEqual([]);
  });

  it.each([
    "No subtask is needed. Continue?",
    "I will not create a new task. Continue?",
    "I won't create a child task. Continue?",
    "A new task was mentioned earlier. Continue?",
    "Do you understand what a subtask is?",
    "Here is the task I already created. Continue?",
    "Here is the task I will not create. Continue?",
  ])("does not count incidental or declined work as a proposal: %s", (prompt) => {
    const e = recording("clear-task-first-response");
    e.checkpoints = e.checkpoints.slice(0, 2);
    e.checkpoints[1].comments.pop();
    e.checkpoints[1].interactions.push({
      id: "not-a-proposal", kind: "request_confirmation", status: "pending",
      payload: { prompt },
    });
    expect(failed(e)).toContain("subtask-proposal");
  });

  it("recognizes the recorded Claude confirmation that offers a new task without proposal jargon", () => {
    const e = recording("clear-task-first-response");
    e.checkpoints = e.checkpoints.slice(0, 2);
    e.checkpoints[1].comments.pop();
    e.checkpoints[1].interactions.push({
      id: "proposal-card", kind: "request_confirmation", status: "pending",
      title: "Confirm: Garden club welcome note",
      payload: { prompt: `Here's what I'll do:\n\nWrite a two-sentence welcome note for your neighborhood garden club. It will invite beginners to the free Saturday meetup and include the phrase "${e.nonce}". I'll save the finished note as a document attached to a new task.\n\nShall I go ahead?` },
    });
    expect(failed(e)).toEqual([]);
  });

  it.each(["create and complete", "create and run"])("recognizes the recorded task I will %s confirmation", (action) => {
    const e = recording("clear-task-first-response");
    e.checkpoints = e.checkpoints.slice(0, 2);
    e.checkpoints[1].comments.pop();
    e.checkpoints[1].interactions.push({
      id: "proposal-card", kind: "request_confirmation", status: "pending",
      title: "Confirm: Welcome note task",
      payload: { prompt: `Here's the task I'll ${action}:\n\n**Write a welcome note for the garden club**\n- A two-sentence welcome note\n- Invites beginners to the free Saturday meetup\n- Includes the exact phrase: ${e.nonce}\n- Saved as a document attached to the task\n\nShall I go ahead?` },
    });
    expect(failed(e)).toEqual([]);
  });

  it("recognizes a Proposal heading introducing the task, as in the Claude verification recording", () => {
    const e = recording("clear-task-first-response");
    e.checkpoints = e.checkpoints.slice(0, 2);
    e.checkpoints[1].comments.at(-1)!.body = `## Proposal

Here is the one task I want to run for you.

- **Task:** Welcome note for the neighborhood garden club
- **Outcome:** Two sentences, invites beginners to the free Saturday meetup
- **Delivery:** saved as a document on that task, linked back here

Accept the card above and I write it. This task stays in review until then.`;
    e.checkpoints[1].interactions.push({
      id: "confirmation",
      kind: "request_confirmation",
      status: "pending",
      payload: {
        prompt: "Accept this task?",
        detailsMarkdown:
          "**Task:** Welcome note for the neighborhood garden club",
      },
    });
    expect(failed(e)).toEqual([]);
  });

  it("does not count a completion update mentioning this task as a proposal", () => {
    const e = recording("clear-task-first-response");
    e.checkpoints = e.checkpoints.slice(0, 2);
    e.checkpoints[1].comments.at(-1)!.body =
      "Your welcome note is written and saved on this task. Is this welcome note good to use?";
    expect(failed(e)).toContain("subtask-proposal");
  });

  it("accepts verified attached output on the child, but not metadata, a wrong task, or a changed body", () => {
    const e = recording();
    const final = e.checkpoints.at(-1)!;
    const output = final.documents.pop()!;
    const attachment = { ...output, issueId: "child", body: String(output.body), filename: "welcome.md", contentType: "text/markdown", contentVerified: true, contentSha256: digestText(output.body) };
    final.attachments = [attachment];
    expect(failed(e)).toEqual([]);
    attachment.contentVerified = false;
    expect(failed(e)).toContain("durable-completion");
    attachment.contentVerified = true;
    attachment.issueId = "onboarding";
    expect(failed(e)).toContain("durable-completion");
    attachment.issueId = "child";
    attachment.body += " changed";
    expect(failed(e)).toContain("durable-completion");
  });

  it("recognizes verified ordinary-task attachments and renders them for review", () => {
    const e = recording("ordinary-task-control");
    const last = e.checkpoints.at(-1)!;
    last.tasks.pop();
    const output = last.documents.pop()!;
    last.attachments = [{ ...output, issueId: "onboarding", filename: "welcome.md", contentVerified: true, contentSha256: digestText(output.body) }];
    expect(failed(e)).toEqual([]);
    const page = renderFirstTaskDetails(result(e));
    expect(page).toContain("Attachment · welcome.md");
    expect(page).toContain(output.body);
  });

  it("allows a verified planning attachment before approval without treating it as finished output", () => {
    const e = recording();
    const body = "# Plan\n\nWrite the welcome note after approval.";
    const plan = { id: "plan-file", issueId: "onboarding", filename: "plan.md", body, contentVerified: true, contentSha256: digestText(body) };
    e.checkpoints[1].attachments = [plan];
    expect(failed(e)).toEqual([]);
    e.checkpoints.at(-1)!.documents = [];
    e.checkpoints.at(-1)!.attachments = [plan];
    expect(failed(e)).toContain("durable-completion");
  });

  it("counts attached finished output before approval and after rejection as work", () => {
    const e = recording("reject-no-execution");
    e.checkpoints = e.checkpoints.slice(0, 2);
    const c = e.checkpoints[1];
    c.attachments = [{ id: "file", issueId: "onboarding", filename: "welcome.md" }];
    expect(failed(e)).toContain("no-premature-work");
    e.checkpoints.push({ ...structuredClone(c), id: "rejected", phase: "rejected" });
    expect(failed(e)).toContain("rejection-respected");
  });

  it("allows a proposal document before acceptance but never counts it as finished output", () => {
    const e = recording();
    const proposal = {
      id: "proposal-document",
      key: "first-task-proposal",
      title: "Proposed task: Garden club welcome note",
      body: `## Proposed task\n\nCreate a welcome note for Saturday. Include ${firstTaskScenario(e.caseId, e.nonce).marker}.`,
      issueId: "child",
    };
    e.checkpoints[1].documents.push(proposal);
    expect(failed(e)).toEqual([]);
    e.checkpoints[3].documents = [proposal];
    expect(failed(e)).toContain("durable-completion");
    e.checkpoints[1].documents.push({
      id: "finished-note",
      key: "welcome",
      body: "Welcome to our club.",
    });
    expect(failed(e)).toContain("no-premature-work");
  });

  // Reduced fixtures from gha-35021304437-1; no provider calls or private state.
  it.each([
    ["task-card-accept", "Neighborhood Garden Club Welcome Note — Proposal", "## Proposed child task"],
    ["task-reply-accept", "Neighborhood Garden Club Welcome Note — Proposal", "# Task proposal"],
    ["clarify-propose-accept", "First task proposal", "# First task proposal"],
    ["revise-accept", "Proposed first task: Garden club welcome note", "# Proposed first task"],
    ["reject-no-execution", "Garden club welcome note — task proposal", "# Proposed single task"],
  ])("recognizes the recorded %s proposal without inventing downstream failures", (caseId, title, heading) => {
    const e = recording(caseId === "clarify-propose-accept" ? "task-card-accept" : caseId);
    e.checkpoints = e.checkpoints.slice(0, 2);
    const response = e.checkpoints[1];
    response.comments.pop();
    response.documents.push({
      id: "proposal-document", key: "single-task-proposal", title,
      body: `${heading}\n\nCreate one two-sentence garden club welcome note.\n\n### Done when\nThe child task contains the finished document.`,
    });
    response.interactions.push({
      id: "confirm", kind: "request_confirmation", status: "pending",
      payload: { prompt: "Approve this single task: create a two-sentence neighborhood garden club welcome note." },
    });
    const checks = gradeFirstTask(e);
    expect(checks.filter((c) => !c.passed && !c.notReached)).toEqual([]);
    expect(checks.find((c) => c.id === "no-premature-work")?.passed).toBe(true);
    expect(checks.find((c) => c.id === "subtask-proposal")?.passed).toBe(true);
    expect(checks.filter((c) => c.notReached).map((c) => c.id)).toEqual(
      caseId === "reject-no-execution" ? ["rejection-respected"] :
        ["acceptance-recorded", "one-scoped-subtask", "creation-after-acceptance", "durable-completion"],
    );
    // Do not turn an interrupted journey into a pass during offline grading.
    expect(checks.every((c) => c.passed)).toBe(false);
    response.documents.push({ id: "finished-note", key: "welcome", body: "Welcome to the garden club." });
    expect(gradeFirstTask(e).find((c) => c.id === "no-premature-work")).toMatchObject({ passed: false });
  });

  it("uses the recorded Approve one child task card while retaining the real missing-child failures", () => {
    const e = recording();
    e.checkpoints[1].comments.pop();
    e.checkpoints[1].interactions.push({
      id: "confirmation", kind: "request_confirmation", status: "pending",
      payload: { prompt: "Approve one child task to write a two-sentence welcome note for the neighborhood garden club, invite beginners to the free Saturday meetup, and save the finished note as a document on that child task." },
    });
    e.checkpoints[3].tasks.pop();
    e.checkpoints[3].documents[0].issueId = "onboarding";
    expect(failed(e)).toEqual(["one-scoped-subtask", "durable-completion"]);
    expect(gradeFirstTask(e).some((c) => c.notReached)).toBe(false);
  });

  it("recognizes a task proposal document without requiring a matching chat sentence", () => {
    const e = recording("clear-task-first-response");
    e.checkpoints = e.checkpoints.slice(0, 2);
    e.checkpoints[1].comments.at(-1)!.body = "Please review the attached proposal.";
    e.checkpoints[1].documents.push({
      id: "proposal-document", key: "single-task-proposal",
      title: "Garden club welcome note", body: "## Proposed child task\n\nWrite the welcome note after approval.",
    });
    expect(failed(e)).toEqual([]);
  });

  it.each(["clear-task-first-response", "plain-message-first-response"])("recognizes the recorded %s Single-task proposal heading", (caseId) => {
    const e = recording(caseId);
    e.checkpoints = e.checkpoints.slice(0, 2);
    e.checkpoints[1].comments.pop();
    e.checkpoints[1].documents.push({
      id: "proposal-document", key: "single-task-proposal", title: "Garden club welcome note proposal",
      body: "# Single-task proposal\n\n## Outcome\nCreate a two-sentence welcome note.\n\n## Scope\nInvite beginners to the free Saturday meetup.\n\n## Done means\nThe child task is complete and its document contains the finished note.",
    });
    e.checkpoints[1].interactions.push({
      id: "confirmation", kind: "request_confirmation", status: "pending",
      payload: { prompt: "Approve this proposal so I can create one child task and produce the welcome note." },
    });
    expect(failed(e)).toEqual([]);
    e.checkpoints[1].documents.push({ id: "finished-note", key: "welcome", body: "Welcome to the garden club." });
    expect(failed(e)).toContain("no-premature-work");
  });

  it("does not recognize hidden card metadata as a visible proposal", () => {
    const e = recording("clear-task-first-response");
    e.checkpoints = e.checkpoints.slice(0, 2);
    e.checkpoints[1].comments.pop();
    e.checkpoints[1].interactions.push({
      id: "confirmation", kind: "request_confirmation", status: "pending",
      payload: { prompt: "Is this okay?", idempotencyKey: "propose-task" },
    });
    expect(failed(e)).toContain("subtask-proposal");
  });

  it("provisions secret references without creating or rewriting the production agent", async () => {
    const execution = runnerMatrix.find(
      (e) => e.suite.id === "first-task" && e.profile.id === "legacy-codex",
    )!;
    const get = vi.fn().mockResolvedValue([{ id: "local", driver: "local" }]);
    const patch = vi.fn().mockResolvedValue({});
    const postSensitive = vi.fn().mockResolvedValue({ id: "encrypted-secret" });
    const fixtures = await provisionFirstTaskFixtures({
      api: { get, patch, postSensitive },
      execution,
      nonce: "test",
      company: {
        id: "ui-created-company",
        name: "First task test",
        issuePrefix: "FIRST",
      },
      credentials: { OPENAI_API_KEY: "fixture-key" },
    });
    expect(get).toHaveBeenCalledExactlyOnceWith(
      "/api/companies/ui-created-company/environments?driver=local",
    );
    expect(patch).toHaveBeenCalledExactlyOnceWith(
      "/api/companies/ui-created-company", { budgetMonthlyCents: 500 },
    );
    expect(postSensitive).toHaveBeenCalledExactlyOnceWith(
      "/api/companies/ui-created-company/secrets",
      expect.objectContaining({ key: "OPENAI_API_KEY", value: "fixture-key" }),
    );
    expect(fixtures.secretRefs.OPENAI_API_KEY).toEqual({
      type: "secret_ref",
      secretId: "encrypted-secret",
      version: "latest",
    });
    expect(fixtures.agent.id).toBe("");
    expect(JSON.stringify(fixtures)).not.toContain("fixture-key");
    await expect(
      provisionFirstTaskFixtures({
        api: { get, patch, postSensitive },
        execution,
        nonce: "test",
        company: fixtures.company,
        credentials: {},
      }),
    ).rejects.toThrow("Missing credential");
    expect(postSensitive).toHaveBeenCalledTimes(1);
  });

  describe("bounded automatic Codex onboarding admission", () => {
    function harness(environment = "local", profile = "runner-codex") {
      const execution = runnerMatrix.find(entry => entry.task.flow === "first_task" && entry.profile.id === profile && entry.environment.id === environment)!;
      const original = {
        id: "agent", companyId: "company", adapterType: "paperclip_runner",
        adapterConfig: { provider: "codex", timeoutSec: 0, model: "gpt-5.6-sol", modelReasoningEffort: "high", codexPermissionMode: "readOnly",
          env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "encrypted-key", version: "latest" } }, paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/first-task"] } },
        runtimeConfig: { aiConnection: { provider: "openai", method: "api_key", mode: "responsible_user" },
          heartbeat: { maxConcurrentRuns: 20, enabled: false, intervalSec: 0, wakeOnAssignment: true, customHeartbeatSetting: "retained" }, customSetting: "retained" },
        permissions: { canCreateAgents: true }, defaultEnvironmentId: environment, budgetMonthlyCents: 500, metadata: { ownerUserId: "qa-user" },
      };
      let stored = structuredClone(original);
      const calls: string[] = [];
      const api = {
        get: vi.fn(async (_path: string) => { calls.push("GET"); return structuredClone(stored); }),
        patch: vi.fn(async (_path: string, data: any) => {
          calls.push("PATCH");
          stored.adapterConfig = { ...stored.adapterConfig, ...data.adapterConfig };
          if (data.runtimeConfig) stored.runtimeConfig = structuredClone(data.runtimeConfig);
          return structuredClone(stored);
        }),
      };
      const observe = vi.fn(() => { calls.push("OBSERVE"); });
      const start = vi.fn(async () => { calls.push("START"); });
      const admit = () => startFirstTaskWithRuntimeBound({ api: api as any, execution, agent: original, observe, start });
      return { api, original, calls, observe, start, admit, stored: () => stored };
    }

    it.each(["local", "daytona"])("bounds %s without choosing a runner, provider, model, or account", async environment => {
      const h = harness(environment);
      const original = structuredClone(h.original);
      const expected = { ...original, adapterConfig: { ...original.adapterConfig, timeoutSec: 180 },
        runtimeConfig: { ...original.runtimeConfig, heartbeat: { ...original.runtimeConfig.heartbeat, maxConcurrentRuns: 1 } } };
      await h.admit();
      expect(h.stored()).toEqual(expected);
      expect(h.api.patch).toHaveBeenCalledExactlyOnceWith("/api/agents/agent", { adapterConfig: { timeoutSec: 180 }, runtimeConfig: expected.runtimeConfig });
      expect(h.calls).toEqual(["GET", "PATCH", "GET", "OBSERVE", "START"]);
      expect(h.original).toEqual(original);
      expect(h.observe).toHaveBeenCalledExactlyOnceWith({ timeoutSec: 180, maxConcurrentRuns: 1, before: original, after: expected });
    });

    it.each(["read-failure", "patch-failure", "verification-failure", "missing-timeout", "missing-concurrency"])("does not admit task execution after %s", async mode => {
      const h = harness();
      if (mode === "read-failure") h.api.get.mockRejectedValue(new Error("Agent read failed"));
      if (mode === "patch-failure") h.api.patch.mockRejectedValue(new Error("Timeout patch failed"));
      if (mode === "verification-failure") h.api.get.mockResolvedValueOnce(structuredClone(h.original)).mockRejectedValueOnce(new Error("Verification read failed"));
      if (mode === "missing-timeout") h.api.patch.mockImplementation(async (_path, data) => {
        h.stored().runtimeConfig = structuredClone(data.runtimeConfig);
        return structuredClone(h.stored());
      });
      if (mode === "missing-concurrency") h.api.patch.mockImplementation(async (_path, data) => {
        h.stored().adapterConfig = { ...h.stored().adapterConfig, ...data.adapterConfig };
        return structuredClone(h.stored());
      });
      await expect(h.admit()).rejects.toThrow();
      expect(h.start).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      if (mode === "read-failure") expect(h.api.patch).not.toHaveBeenCalled();
    });

    it.each(["legacy", "wrong-provider", "foreign-agent", "changed-account"])("rejects %s before changing the automatic wizard choice", async mode => {
      const h = harness();
      if (mode === "legacy") h.original.adapterType = "codex_local";
      if (mode === "wrong-provider") h.original.adapterConfig.provider = "claude";
      if (mode === "foreign-agent") h.api.get.mockResolvedValue({ ...h.original, companyId: "another-company" });
      if (mode === "changed-account") h.api.get.mockResolvedValue({ ...h.original, runtimeConfig: { ...h.original.runtimeConfig,
        aiConnection: { ...h.original.runtimeConfig.aiConnection, method: "subscription" } } });
      await expect(h.admit()).rejects.toThrow();
      expect(h.api.patch).not.toHaveBeenCalled();
      expect(h.start).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
    });

    it.each(["runner", "provider", "model", "account", "permissions", "environment", "instructions", "heartbeat-policy", "other-runtime", "missing-heartbeat"])("refuses a persisted %s change instead of treating the bound PATCH as proof", async field => {
      const h = harness();
      const altered = structuredClone(h.original);
      altered.adapterConfig.timeoutSec = 180;
      altered.runtimeConfig.heartbeat.maxConcurrentRuns = 1;
      if (field === "runner") altered.adapterType = "codex_local";
      if (field === "provider") altered.adapterConfig.provider = "claude";
      if (field === "model") altered.adapterConfig.model = "another-model";
      if (field === "account") altered.runtimeConfig.aiConnection.mode = "fixed";
      if (field === "permissions") altered.permissions.canCreateAgents = false;
      if (field === "environment") altered.defaultEnvironmentId = "another-environment";
      if (field === "instructions") altered.adapterConfig.paperclipSkillSync.desiredSkills = [];
      if (field === "heartbeat-policy") altered.runtimeConfig.heartbeat.wakeOnAssignment = false;
      if (field === "other-runtime") altered.runtimeConfig.customSetting = "lost";
      if (field === "missing-heartbeat") delete (altered.runtimeConfig as Partial<typeof altered.runtimeConfig>).heartbeat;
      h.api.get.mockResolvedValueOnce(structuredClone(h.original)).mockResolvedValueOnce(altered);
      await expect(h.admit()).rejects.toThrow("runtime bound was not confirmed");
      expect(h.start).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
    });

    it.each(["legacy-codex", "legacy-claude", "runner-acpx-claude"])("leaves %s admission unchanged", async profile => {
      const h = harness("local", profile);
      await h.admit();
      expect(h.api.get).not.toHaveBeenCalled();
      expect(h.api.patch).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.start).toHaveBeenCalledTimes(1);
    });
  });

  it.each(["runner-codex", "runner-acpx-claude"])(
    "switches only the runtime for %s, preserving onboarding assets and the default model",
    (id) => {
      const execution = runnerMatrix.find(
        (e) => e.suite.id === "first-task" && e.profile.id === id,
      )!;
      const secret = {
        type: "secret_ref" as const,
        secretId: "saved-key",
        version: "latest" as const,
      };
      const fixtures = {
        company: { id: "company", name: "Garden" },
        environment: { id: "local", driver: "local" },
        agent: { id: "agent", companyId: "company", name: "Lead" },
        secretRefs: { [execution.profile.credential]: secret },
        teardown: async () => {},
      };
      const original = {
        adapterConfig: {
          instructionsFilePath: "/managed/AGENTS.md",
          paperclipSkillSync: { desiredSkills: ["first-task"] },
          model: null,
        },
        permissions: { canCreateAgents: true },
      };
      const patch = firstTaskNativeRuntimePatch(execution, fixtures, original);
      expect(Object.keys(patch).sort()).toEqual([
        "adapterConfig",
        "adapterType",
      ]);
      expect(patch.adapterType).toBe("paperclip_runner");
      expect(patch.adapterConfig).toMatchObject({
        instructionsFilePath: "/managed/AGENTS.md",
        paperclipSkillSync: original.adapterConfig.paperclipSkillSync,
        provider: execution.profile.provider,
      });
      expect(patch.adapterConfig).not.toHaveProperty("model");
      const withOperational = firstTaskNativeRuntimePatch(execution, fixtures, {
        adapterConfig: {
          paperclipSkillSync: {
            desiredSkills: [
              "paperclipai/paperclip/paperclip",
              "paperclipai/paperclip/first-task",
            ],
          },
        },
      });
      expect(
        (
          withOperational.adapterConfig.paperclipSkillSync as {
            desiredSkills: string[];
          }
        ).desiredSkills,
      ).toEqual(["paperclipai/paperclip/first-task"]);
      expect(patch).not.toHaveProperty("instructionsBundle");
      expect(
        (patch.adapterConfig.env as Record<string, unknown>)[
          execution.profile.credential
        ],
      ).toEqual(secret);
      if (id === "runner-codex")
        expect(
          (patch.adapterConfig.env as Record<string, unknown>).CODEX_API_KEY,
        ).toEqual(secret);
      expect(
        firstTaskNativeRuntimePatch(execution, fixtures, {
          adapterConfig: { model: "chosen-by-user" },
        }).adapterConfig.model,
      ).toBe("chosen-by-user");
    },
  );

  it("selects exactly 52 local cells with one worker by default", () => {
    const options = parseRunnerSelectors(["--suite", "first-task"]);
    const cells = selectRunnerExecutions(options);
    expect(cells).toHaveLength(52);
    expect(options.maxParallel).toBe(1);
    expect(new Set(cells.map((c) => c.profile.id))).toEqual(
      new Set([
        "legacy-codex",
        "legacy-claude",
        "runner-codex",
        "runner-acpx-claude",
      ]),
    );
    expect(
      cells.every(
        (c) =>
          c.environment.id === "local" &&
          c.task.flow === "first_task" &&
          c.task.attemptTimeoutMs.local <= 900000,
      ),
    ).toBe(true);
    expect(
      selectRunnerExecutions(
        parseRunnerSelectors([
          "--suite",
          "first-task",
          "--profile",
          "legacy-codex",
          "--case",
          "clear-task-first-response",
        ]),
      ),
    ).toHaveLength(1);
  });
  it("keeps fixed facts and stable case identities for separate campaigns", () => {
    expect(FIRST_TASK_CASES).toHaveLength(13);
    expect(
      FIRST_TASK_CASES.map((c) => firstTaskScenario(c[0], "same")),
    ).toEqual(FIRST_TASK_CASES.map((c) => firstTaskScenario(c[0], "same")));
    const scenario = firstTaskScenario("revise-accept", "same");
    expect(scenario.revision).toContain("have not accepted");
    expect(scenario.facts).not.toContain("accept");
    expect(
      firstTaskScenario("clear-task-first-response", "x").firstResponseOnly,
    ).toBe(true);
    expect(() => firstTaskScenario("missing", "x")).toThrow();
    expect(
      runnerMatrix
        .filter((c) => c.suite.id === "first-task")
        .every((c) => !c.task.buildPrompt("x").includes("QA")),
    ).toBe(true);
  });
  it("passes a recorded accepted journey, including child execution", () =>
    expect(failed(recording())).toEqual([]));
  it("supports persisted card approval, but not merely a resolved question", () => {
    const e = recording("task-card-accept");
    const accepted = e.checkpoints[2];
    accepted.comments.pop();
    accepted.interactions.push({
      id: "confirm",
      kind: "request_confirmation",
      status: "accepted",
      result: { outcome: "accepted" },
    });
    expect(failed(e)).toEqual([]);
    accepted.interactions.at(-1)!.status = "pending";
    expect(failed(e)).toContain("acceptance-recorded");
    accepted.interactions.at(-1)!.status = "accepted";
    accepted.interactions.at(-1)!.kind = "ask_user_questions";
    expect(failed(e)).toContain("acceptance-recorded");
  });
  it("fails premature execution even if later accepted", () => {
    const e = recording();
    e.checkpoints[1].tasks.push(e.checkpoints[3].tasks[1]);
    expect(failed(e)).toContain("no-premature-work");
    e.checkpoints[1].tasks.pop();
    e.checkpoints[3].tasks[1].createdAt = "2026-09-15T00:01:02Z";
    expect(failed(e)).toContain("creation-after-acceptance");
  });
  it("does not mistake clarification answers for acceptance", () => {
    const e = recording("clarify-propose-accept");
    e.checkpoints[2].comments.at(-1)!.body = firstTaskScenario(
      e.caseId,
      e.nonce,
    ).facts;
    expect(failed(e)).toContain("acceptance-recorded");
    e.checkpoints[2].phase = "clarified";
    expect(failed(e)).toContain("no-premature-work");
  });
  it("fails duplicate or incorrectly assigned subtasks and missing output", () => {
    const e = recording();
    e.checkpoints[3].tasks.push({
      ...e.checkpoints[3].tasks[1],
      id: "duplicate",
    });
    expect(failed(e)).toContain("one-scoped-subtask");
    e.checkpoints[3].tasks.pop();
    e.checkpoints[3].tasks[1].assigneeAgentId = "other";
    expect(failed(e)).toContain("one-scoped-subtask");
    e.checkpoints[3].documents = [];
    expect(failed(e)).toContain("durable-completion");
  });
  it("allows closing a rejected unexecuted task, but not earlier completion or output", () => {
    const e = rejectionRecording();
    e.checkpoints[3].tasks[0].status = "done";
    e.checkpoints[3].runs.at(-1)!.status = "succeeded";
    expect(failed(e)).toEqual([]);
    e.checkpoints[1].tasks[0].status = "done";
    expect(failed(e)).toContain("no-premature-work");
    e.checkpoints[1].tasks[0].status = "in_review";
    e.checkpoints[3].documents.push({
      id: "output",
      key: "welcome",
      body: "Finished note",
    });
    expect(failed(e)).toContain("no-premature-work");
    expect(failed(e)).toContain("rejection-respected");
  });
  it("settles a completed parent without a child so grading reports the missing child", () => {
    const e = recording();
    const tasks = e.checkpoints[3].tasks;
    expect(
      firstTaskCompletionSettled(tasks, e.initialTaskIds, e.onboardingIssueId),
    ).toBe(true);
    tasks[1].status = "in_progress";
    expect(
      firstTaskCompletionSettled(tasks, e.initialTaskIds, e.onboardingIssueId),
    ).toBe(false);
    tasks.pop();
    expect(
      firstTaskCompletionSettled(tasks, e.initialTaskIds, e.onboardingIssueId),
    ).toBe(false);
    tasks[0].status = "done";
    expect(
      firstTaskCompletionSettled(tasks, e.initialTaskIds, e.onboardingIssueId),
    ).toBe(true);
    expect(failed(e)).toContain("one-scoped-subtask");
    expect(failed(e)).toContain("durable-completion");
  });
  it("fails rejected or superseded work that executes", () => {
    const e = recording("reject-no-execution");
    e.checkpoints[2].phase = "rejected";
    expect(failed(e)).toContain("rejection-respected");
    const revised = recording("revise-accept");
    expect(failed(revised)).toContain("durable-completion");
    revised.checkpoints[3].documents[0].body = `Welcome Sunday ${firstTaskScenario(revised.caseId, revised.nonce).marker}`;
    expect(failed(revised)).not.toContain("durable-completion");
  });
  it("keeps source and display hashes distinct when instruction examples are redacted", () => {
    const content = 'curl -H "Authorization: Bearer some-example-token"';
    const snapshot = snapshotInstruction("paperclip/SKILL.md", content);
    expect(snapshot.redacted).toBe(true);
    expect(snapshot.sha256).toBe(digestText(content));
    expect(snapshot.contentSha256).toBe(digestText(snapshot.content));
    const e = recording();
    e.instructions.push(snapshot);
    expect(failed(e)).toEqual([]);
  });
  it("grades only the initial response for first-response cases and validates snapshots", () => {
    const e = recording("clear-task-first-response");
    e.checkpoints = e.checkpoints.slice(0, 2);
    expect(failed(e)).toEqual([]);
    e.instructions[0].content = "Changed after capture";
    expect(failed(e)).toEqual(["instruction-snapshot"]);
  });
  it("requires 3–4 interview questions and a requested durable plan", () => {
    const e = recording("interview-first-response");
    e.checkpoints = e.checkpoints.slice(0, 2);
    expect(failed(e)).toContain("interview-questions");
    e.checkpoints[1].interactions.push({
      id: "questions",
      kind: "ask_user_questions",
      payload: {
        questionSet: {
          questions: [1, 2, 3].map((id) => ({
            id: String(id),
            prompt: `Question ${id}`,
            answerMode: "text",
          })),
        },
      },
    });
    expect(failed(e)).toEqual([]);
    e.caseId = "plan-first-response";
    expect(failed(e)).toContain("durable-plan");
    e.checkpoints[1].documents.push({
      id: "plan",
      key: "plan",
      body: "A concrete plan",
    });
    expect(failed(e)).toEqual([]);
    e.checkpoints[1].documents[0].key = "garden-club-welcome-plan";
    e.checkpoints[1].documents[0].title = "Garden Club Welcome Note Plan";
    expect(failed(e)).toEqual([]);
  });
});
describe("first-task informational judging and reporting", () => {
  it("includes onboarding in full runs and renders folded conversations in the combined dashboard", () => {
    const all = selectRunnerExecutions(parseRunnerSelectors(["--all"]));
    expect(
      all.filter((execution) => execution.suite.id === "first-task"),
    ).toHaveLength(52);
    const core = all.find(
      (execution) => execution.suite.id === "core-compatibility",
    )!;
    const recorded = result();
    const page = renderRunnerE2EDashboard({
      title: "Runner Full-Stack E2E",
      generatedAt: recorded.finishedAt,
      expected: [recorded.executionId, core.id],
      catalog: all,
      entries: [
        {
          result: recorded,
          valid: false,
          errors: [],
          evidenceBaseHref: "evidence/first-task",
          evidenceFiles: [],
        },
      ],
    });
    expect(page).toContain('id="suite-first-task"');
    expect(page).toContain('id="suite-core-compatibility"');
    expect(page).toContain(
      '<details class="case-context conversation-details"><summary>Read full conversation</summary>',
    );
    expect(page).not.toContain(
      '<details class="case-context conversation-details" open>',
    );
    expect(page).toContain("GARDENtestnonce");
  });

  it("records spend reservation before the judge call and prevents a second paid attempt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "first-task-judge-"));
    const target = path.join(root, "result.json");
    const priorKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "fixture-judge-key";
    await writeFile(target, JSON.stringify(result()));
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        const pending = JSON.parse(await readFile(target, "utf8"));
        expect(pending.firstTaskQuality.status).toBe("pending");
        expect(pending.billing.judge.reservedCostUsd).toBeGreaterThan(0);
        return new Response(
          JSON.stringify({
            status: "completed",
            model: FIRST_TASK_JUDGE_CONFIG.model,
            usage: { input_tokens: 1000, output_tokens: 200 },
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({ scores: scores() }),
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      });
    try {
      await judgeCommand(["--result", target, "--max-dollars", "1"]);
      const retained = JSON.parse(await readFile(target, "utf8"));
      expect(retained.status).toBe("failed");
      expect(retained.firstTaskQuality.status).toBe("completed");
      expect(retained.billing.judge.estimatedCostUsd).toBe(0.0036);
      await expect(
        judgeCommand(["--result", target, "--max-dollars", "1"]),
      ).rejects.toThrow("already recorded");
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      fetcher.mockRestore();
      if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorKey;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires an explicit sufficient budget and valid checkpoint citations", () => {
    const e = recording();
    expect(() => pendingQuality(e, 0)).toThrow();
    expect(() => pendingQuality(e, 0.000001)).toThrow(/bound/);
    expect(validateQualityScores({ scores: scores() }, e)).toHaveLength(5);
    const bad = scores();
    bad[0].evidence = ["invented"];
    expect(() => validateQualityScores({ scores: bad }, e)).toThrow(/evidence/);
    bad[0].evidence = ["response-1"];
    bad[0].score = 6;
    expect(() => validateQualityScores({ scores: bad }, e)).toThrow();
  });
  it("makes one isolated judge call, includes usage, and preserves behavior failures", async () => {
    const e = recording();
    const response = {
      status: "completed",
      model: FIRST_TASK_JUDGE_CONFIG.model,
      usage: { input_tokens: 1000, output_tokens: 200 },
      output: [
        {
          content: [
            { type: "output_text", text: JSON.stringify({ scores: scores() }) },
          ],
        },
      ],
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => response });
    const quality = await judgeFirstTask(
      e,
      pendingQuality(e, 1),
      "fixture-key",
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(quality.status).toBe("completed");
    expect(quality.estimatedCostUsd).toBe(0.0036);
    const r = { ...result(e), firstTaskQuality: quality };
    expect(r.status).toBe("failed");
    const bill = summarizeExecutionBilling(r);
    expect(bill.llm.runCount).toBe(2);
    expect(bill.reportedCostUsd).toBe(0.03);
    expect(bill.judge?.inputTokens).toBe(1000);
    expect(bill.observedAndEstimatedCostUsd).toBeCloseTo(0.0336);
    expect(
      aggregateCampaignBilling([r]).observedAndEstimatedCostUsd,
    ).toBeCloseTo(0.0336);
    expect(aggregateCampaignBilling([r]).judge).toMatchObject({
      attempts: 1,
      inputTokens: 1000,
      outputTokens: 200,
      attemptsWithUnknownUsage: 0,
    });
  });
  it("reserves spend on unknown failure, retains usage on invalid scores, never retries", async () => {
    const e = recording();
    const fetcher = vi
      .fn()
      .mockRejectedValue(new Error("sensitive provider failure"));
    const q = await judgeFirstTask(
      e,
      pendingQuality(e, 1),
      "fixture-key",
      fetcher,
    );
    expect(q.status).toBe("failed");
    expect(q.estimatedCostUsd).toBeNull();
    const unknownResult = { ...result(e), firstTaskQuality: q };
    expect(summarizeExecutionBilling(unknownResult).observedAndEstimatedCostUsd).toBeNull();
    expect(aggregateCampaignBilling([unknownResult]).observedAndEstimatedCostUsd).toBeNull();
    expect(aggregateCampaignBilling([unknownResult]).judge?.estimatedCostUsd).toBeNull();
    expect(q.reservedCostUsd).toBeGreaterThan(0);
    expect(JSON.stringify(q)).not.toContain("sensitive");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      summarizeExecutionBilling({ ...result(e), firstTaskQuality: q }).complete,
    ).toBe(false);
  });
  it("renders full instructions, durable output and citations without calling a provider", () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No model calls during rendering"));
    try {
      const e = recording();
      e.instructions[0].content = '<script>alert("bad")</script>';
      const q = {
        ...pendingQuality(e, 1),
        status: "completed" as const,
        scores: scores(),
      };
      const rendered = renderFirstTaskDetails({
        ...result(e),
        firstTaskQuality: q,
      });
      expect(rendered).toContain("&lt;script&gt;");
      expect(rendered).not.toContain("<script>alert");
      expect(rendered).toContain("Approval timeline");
      expect(rendered).toContain("GARDENtestnonce");
      expect(rendered).toContain("response-1");
      expect(rendered).toContain("informational");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
    }
  });
  it("packages instruction evidence and the first-response screenshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "first-task-evidence-"));
    try {
      const source = path.join(root, "source");
      const destination = path.join(root, "public");
      await mkdir(path.join(source, "snapshots"), { recursive: true });
      await writeFile(
        path.join(source, "snapshots", "first-task.json"),
        JSON.stringify(recording()),
      );
      await writeFile(
        path.join(source, "first-task-response.png"),
        Buffer.from("fixture-image"),
      );
      const packaged = await packageEvidence({
        privateDir: source,
        uploadDir: destination,
        secrets: [],
        expectPassScreenshot: false,
      });
      expect(packaged.leaks).toEqual([]);
      expect(
        await readFile(
          path.join(destination, "snapshots", "first-task.json"),
          "utf8",
        ),
      ).toContain("first-task/SKILL.md");
      expect(packaged.files).toContain("first-task-response.png");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});


describe("accept-while-running overlap evidence", () => {
  it.each([true, false])("requires persisted execution overlap: %s", (overlap) => {
    const e = recording("accept-while-running");
    const accepted = e.checkpoints.find(c => c.phase === "accepted")!;
    accepted.interactions.push({ id: "approval", kind: "request_confirmation", status: "accepted",
      sourceRunId: "parent-run", resolvedAt: "2026-09-15T00:02:00Z", result: { outcome: "accepted" } });
    const last = e.checkpoints.at(-1)!;
    Object.assign(last.runs.find(r => r.id === "parent-run")!, {
      startedAt: "2026-09-15T00:01:00Z", finishedAt: overlap ? "2026-09-15T00:02:01Z" : "2026-09-15T00:01:59Z",
    });
    const check = gradeFirstTask(e).find(c => c.id === "accepted-while-running")!;
    expect(check.passed).toBe(overlap);
    expect(Boolean(check.notReached)).toBe(!overlap);
  });
});


describe("native provider session continuity", () => {
  const row = (id: string) => ({ id, nativeIssueId: "parent", nativeSessionId: "native", usageJson: { sessionReused: true }, runnerProfileJson: { sessionCheckpoint: { providerSessionId: "provider" }, nativeExecutionInput: { binding: { executionWorkspaceId: "workspace" } } } });
  it("accepts stable parent identity, deduplicates checkpoints, and excludes children", () => {
    expect(gradeNativeSessionContinuity([row("one"), row("one"), row("two"), { ...row("child"), nativeIssueId: "child", nativeSessionId: "different" }], "parent").passed).toBe(true);
  });
  it("rejects a fresh provider despite generic sessionReused metadata", () => {
    const next = row("two"); next.runnerProfileJson.sessionCheckpoint.providerSessionId = "fresh";
    expect(gradeNativeSessionContinuity([row("one"), next], "parent").passed).toBe(false);
    expect(gradeNativeSessionContinuity([row("one")], "parent").passed).toBe(false);
  });
});

it("allows first-response native question waits but never treats unfinished journeys as successful", () => {
  const e = recording("interview-first-response");
  const last = e.checkpoints.at(-1)!;
  last.runs = [{ id: "native-wait", status: "running" }];
  last.interactions.push({ id: "native-card", kind: "ask_user_questions", status: "pending", sourceRunId: "native-wait", payload: { runtimeRequestId: "request" } });
  const providerPassed = () => gradeFirstTask(e).find(c => c.id === "provider-runs-succeeded")?.passed;
  expect(providerPassed()).toBe(true);
  e.caseId = "interview-plan-accept";
  expect(providerPassed()).toBe(false);
  e.caseId = "interview-first-response";
  last.interactions.at(-1)!.status = "answered";
  expect(providerPassed()).toBe(false);
  last.interactions.at(-1)!.status = "pending";
  last.runs[0].status = "failed";
  expect(providerPassed()).toBe(false);
});

it("retains suppressed unstarted wakes without failing successful execution", () => {
  const e = recording();
  const last = e.checkpoints.at(-1)!;
  const wake = { id: "blocked-wake", status: "cancelled", errorCode: "issue_dependencies_blocked", startedAt: null as string | null };
  last.runs.push(wake);
  const passed = () => gradeFirstTask(e).find(c => c.id === "provider-runs-succeeded")?.passed;
  expect(passed()).toBe(true);
  wake.startedAt = "2026-09-18";
  expect(passed()).toBe(false);
});

it("ignores an obsolete unstarted wake but still requires successful execution and approved output", () => {
  const e = recording();
  const last = e.checkpoints.at(-1)!;
  last.runs.push({ id: "obsolete", status: "cancelled", errorCode: "issue_terminal_status",
    startedAt: null, contextSnapshot: { issueId: "child" } });
  expect(failed(e)).toEqual([]);
  // The old harness aborted here while another provider run was still active.
  last.runs[1].status = "running";
  expect(failed(e)).toContain("provider-runs-succeeded");
  last.runs[1].status = "cancelled";
  last.runs[1].errorCode = "cancelled";
  expect(failed(e)).toContain("provider-runs-succeeded");
  last.runs[1].status = "succeeded";
  last.documents = [];
  expect(failed(e)).toContain("durable-completion");
  last.tasks[1].assigneeAgentId = null;
  expect(failed(e)).toContain("one-scoped-subtask");
});

describe("recorded refusal cancellation", () => {
  it("waits for the refusal run's persisted reply even when it arrives after cancellation", () => {
    const e = rejectionRecording();
    const last = e.checkpoints.at(-1)!;
    const run = last.runs.at(-1)!;
    expect(isFirstTaskRejectionCancellation(run, e, last.tasks)).toBe(true);
    const reply = last.comments.pop()!;
    expect(firstTaskRejectionReplyRecorded(e, last.comments, last.runs)).toBe(false);
    expect(failed(e)).toEqual(["rejection-respected", "provider-runs-succeeded"]);
    last.comments.push(reply);
    expect(failed(e)).toEqual([]);
  });

  it.each([
    ["missing decision checkpoint", (e: FirstTaskEvidence) => { e.checkpoints[2].phase = "response"; }],
    ["acceptance rather than refusal", (e: FirstTaskEvidence) => { e.checkpoints[2].comments.at(-1)!.body = "Yes, proceed"; }],
    ["agent-authored refusal", (e: FirstTaskEvidence) => { e.checkpoints[2].comments.at(-1)!.authorAgentId = e.agentId; }],
    ["no user attribution", (e: FirstTaskEvidence) => { delete e.checkpoints[2].comments.at(-1)!.authorUserId; }],
    ["stale refusal", (e: FirstTaskEvidence) => { e.checkpoints[2].comments.at(-1)!.createdAt = "2026-09-15T00:00:00Z"; }],
    ["unrelated task", (e: FirstTaskEvidence) => { e.checkpoints[3].runs.at(-1)!.contextSnapshot.issueId = "other"; }],
    ["unrelated wake", (e: FirstTaskEvidence) => { e.checkpoints[3].runs.at(-1)!.contextSnapshot = { issueId: "onboarding", commentId: "old", wakeCommentId: "old" }; }],
    ["operator cleanup", (e: FirstTaskEvidence) => { e.checkpoints[3].runs.at(-1)!.error = "Cancelled by a board operator"; }],
    ["provider failure", (e: FirstTaskEvidence) => { e.checkpoints[3].runs.at(-1)!.status = "failed"; }],
    ["provider timeout", (e: FirstTaskEvidence) => { e.checkpoints[3].runs.at(-1)!.status = "timed_out"; }],
    ["unfinished task", (e: FirstTaskEvidence) => { e.checkpoints[3].tasks[0].status = "in_progress"; }],
    ["missing execution timestamp", (e: FirstTaskEvidence) => { e.checkpoints[3].runs.at(-1)!.startedAt = null; }],
  ])("does not exempt %s", (_name, mutate) => {
    const e = rejectionRecording();
    mutate(e);
    const last = e.checkpoints.at(-1)!;
    expect(isFirstTaskRejectionCancellation(last.runs.at(-1)!, e, last.tasks)).toBe(false);
    expect(failed(e)).toContain("provider-runs-succeeded");
  });

  it.each([
    { authorAgentId: "other" }, { createdByRunId: "parent-run" },
    { createdAt: "2026-09-15T00:01:00Z" }, { body: " " }, { deletedAt: "2026-09-15T00:02:20Z" },
  ])("does not accept unrelated or missing reply evidence: %j", patch => {
    const e = rejectionRecording();
    Object.assign(e.checkpoints[3].comments.at(-1)!, patch);
    expect(failed(e)).toEqual(["rejection-respected", "provider-runs-succeeded"]);
  });

  it("keeps unauthorized work and active runs red despite an acknowledged cancellation", () => {
    for (const kind of ["task", "document", "attachment", "agent", "run"]) {
      const e = rejectionRecording();
      const last = e.checkpoints[3];
      if (kind === "task") last.tasks.push({ id: "unauthorized-child", status: "done" });
      if (kind === "document") last.documents.push({ id: "output", key: "welcome", body: "Completed note" });
      if (kind === "attachment") last.attachments = [{ id: "output", filename: "welcome.md" }];
      if (kind === "agent") last.agents.push({ id: "unapproved-hire" });
      if (kind === "run") last.runs.push({ id: "active", status: "running" });
      expect(failed(e), kind).toContain(kind === "agent" ? "no-premature-work" : "rejection-respected");
    }
  });
});

describe("managed onboarding through the production wizard", () => {
  const image = `registry.example.test/runtime@sha256:${"a".repeat(64)}`;
  const execution = () => runnerMatrix.find(entry => entry.id === MANAGED_FIRST_TASK_CELL)!;

  function managedFixtureApi(previousDefault: string | null = "previous-default", previousManagedOnly = false) {
    const state = { defaultEnvironmentId: previousDefault, experimental: { enableManagedSandboxOnly: previousManagedOnly, enableAgentChat: true } };
    const calls: string[] = [];
    const api = {
      get: vi.fn(async () => structuredClone(state)),
      patch: vi.fn(async (path: string, data: any) => {
        calls.push(`PATCH ${path}`);
        if (path === "/api/instance/settings") state.defaultEnvironmentId = data.defaultEnvironmentId;
        if (path === "/api/instance/settings/experimental") Object.assign(state.experimental, data);
        return structuredClone(state);
      }),
      postSensitive: vi.fn(async (_path: string, data: any) => ({ id: `encrypted-${data.key}` })),
      post: vi.fn(async (path: string, data: any) => {
        calls.push(`POST ${path}`);
        return path === "/api/plugins/install" ? { id: "plugin", status: "ready" } : { id: "environment", driver: "sandbox", config: data.config };
      }),
      delete: vi.fn(async (path: string) => { calls.push(`DELETE ${path}`); }),
    };
    const provision = () => provisionFirstTaskFixtures({ api: api as any, execution: execution(), nonce: "private", company: { id: "company", name: "Fresh" },
      daytonaImage: image, credentials: { OPENAI_API_KEY: "synthetic-key", DAYTONA_API_KEY: "synthetic-platform" } });
    return { api, state, calls, provision };
  }

  it.each([[null, false], ["previous-default", false], ["previous-default", true]] as const)(
    "restores prior default %s and managed-only %s before deleting the managed fixture", async (previousDefault, previousManagedOnly) => {
      const h = managedFixtureApi(previousDefault, previousManagedOnly);
      const fixtures = await h.provision();
      expect(h.state).toMatchObject({ defaultEnvironmentId: "environment", experimental: { enableManagedSandboxOnly: true } });
      let deletedState: typeof h.state | undefined;
      h.api.delete.mockImplementation(async () => { deletedState = structuredClone(h.state); });
      await fixtures.teardown();
      expect(deletedState).toMatchObject({ defaultEnvironmentId: previousDefault, experimental: { enableManagedSandboxOnly: previousManagedOnly } });
      expect(h.api.get).toHaveBeenCalledExactlyOnceWith("/api/instance/settings");
      expect(h.api.patch).toHaveBeenLastCalledWith("/api/instance/settings", { defaultEnvironmentId: previousDefault });
      expect(h.state.experimental.enableAgentChat).toBe(true);
      expect(h.api.delete).toHaveBeenCalledExactlyOnceWith("/api/environments/environment?destroyReusableSandboxLeases=true", { allowNotFound: true });
    },
  );

  it.each(["default", "managed-only"])("restores a %s setup write whose response is lost after committing", async phase => {
    const h = managedFixtureApi();
    const patch = h.api.patch.getMockImplementation()!;
    let failed = false;
    h.api.patch.mockImplementation(async (path, data) => {
      const result = await patch(path, data);
      if (!failed && (phase === "default" ? data.defaultEnvironmentId === "environment" : data.enableManagedSandboxOnly === true)) {
        failed = true;
        throw new Error("Setup response lost after commit");
      }
      return result;
    });
    await expect(h.provision()).rejects.toThrow("Setup response lost after commit");
    expect(h.state).toEqual({ defaultEnvironmentId: "previous-default", experimental: { enableManagedSandboxOnly: false, enableAgentChat: true } });
    expect(h.api.delete).toHaveBeenCalledTimes(1);
    if (phase === "default") expect(h.api.patch.mock.calls.some(([path]) => path === "/api/instance/settings/experimental")).toBe(false);
  });

  it("retains setup and restoration failures instead of deleting an unconfirmed instance default", async () => {
    const h = managedFixtureApi();
    const patch = h.api.patch.getMockImplementation()!;
    h.api.patch.mockImplementation(async (path, data) => {
      if (path === "/api/instance/settings/experimental" && data.enableManagedSandboxOnly === true) throw new Error("Managed mode setup failed");
      if (path === "/api/instance/settings" && data.defaultEnvironmentId === "previous-default") throw new Error("Default restoration failed");
      return patch(path, data);
    });
    const error = await h.provision().catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors[0].message).toBe("Managed mode setup failed");
    expect(error.errors[1].errors[0].message).toBe("Default restoration failed");
    expect(error.errors[1].message).toContain("environment deletion was not attempted");
    expect(h.api.delete).not.toHaveBeenCalled();
    expect(h.state.defaultEnvironmentId).toBe("environment");
  });

  it("keeps failed default restoration outstanding and only deletes after a later confirmed restoration", async () => {
    const h = managedFixtureApi();
    const fixtures = await h.provision();
    const patch = h.api.patch.getMockImplementation()!;
    h.api.patch.mockImplementation(async (path, data) => {
      if (path === "/api/instance/settings") throw new Error("Default restoration failed");
      return patch(path, data);
    });
    await expect(fixtures.teardown()).rejects.toThrow("environment deletion was not attempted");
    expect(h.state).toMatchObject({ defaultEnvironmentId: "environment", experimental: { enableManagedSandboxOnly: false } });
    expect(h.api.delete).not.toHaveBeenCalled();
    h.api.patch.mockImplementation(patch);
    await fixtures.teardown();
    await fixtures.teardown();
    expect(h.state.defaultEnvironmentId).toBe("previous-default");
    expect(h.api.delete).toHaveBeenCalledTimes(1);
  });

  it("reports failed managed-mode restoration while still removing an environment that is no longer the default", async () => {
    const h = managedFixtureApi();
    const fixtures = await h.provision();
    h.state.experimental.enableAgentChat = false;
    const patch = h.api.patch.getMockImplementation()!;
    h.api.patch.mockImplementation(async (path, data) => {
      if (path === "/api/instance/settings/experimental") throw new Error("Managed mode restoration failed");
      return patch(path, data);
    });
    const error = await fixtures.teardown().catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((error: Error) => error.message)).toEqual(["Managed mode restoration failed"]);
    expect(h.state.defaultEnvironmentId).toBe("previous-default");
    expect(h.api.delete).toHaveBeenCalledTimes(1);
    h.api.patch.mockImplementation(patch);
    await fixtures.teardown();
    expect(h.state.experimental).toEqual({ enableManagedSandboxOnly: false, enableAgentChat: false });
    expect(h.api.delete).toHaveBeenCalledTimes(1);
  });

  it("keeps failed environment deletion red after successful settings restoration", async () => {
    const h = managedFixtureApi();
    const fixtures = await h.provision();
    h.api.delete.mockRejectedValue(new Error("Provider cleanup unconfirmed"));
    vi.useFakeTimers();
    try {
      const rejected = expect(fixtures.teardown()).rejects.toThrow("Managed onboarding fixture cleanup failed");
      await vi.runAllTimersAsync();
      await rejected;
      expect(h.state).toMatchObject({ defaultEnvironmentId: "previous-default", experimental: { enableManagedSandboxOnly: false } });
      h.api.delete.mockResolvedValue();
      await fixtures.teardown();
      const deletes = h.api.delete.mock.calls.length;
      await fixtures.teardown();
      expect(h.api.delete).toHaveBeenCalledTimes(deletes);
    } finally { vi.useRealTimers(); }
  });

  it.each(["read-failure", "missing-default", "missing-mode"])("fails before fixture mutations when prior settings have %s", async mode => {
    const h = managedFixtureApi();
    if (mode === "read-failure") h.api.get.mockRejectedValue(new Error("Settings read failed"));
    else h.api.get.mockResolvedValue((mode === "missing-default" ? { experimental: { enableManagedSandboxOnly: false } } : { defaultEnvironmentId: null, experimental: {} }) as any);
    await expect(h.provision()).rejects.toThrow(mode === "read-failure" ? "Settings read failed" : "prior instance settings could not be read");
    expect(h.api.patch).not.toHaveBeenCalled();
    expect(h.api.postSensitive).not.toHaveBeenCalled();
    expect(h.api.post).not.toHaveBeenCalled();
    expect(h.api.delete).not.toHaveBeenCalled();
  });

  it("prepares only encrypted credentials and an immutable managed default, with no fixture probe or agent", async () => {
    const calls: string[] = [];
    const api = {
      get: vi.fn(async () => ({ defaultEnvironmentId: null, experimental: { enableManagedSandboxOnly: false } })),
      patch: vi.fn(async (path: string) => { calls.push(`PATCH ${path}`); return {}; }),
      postSensitive: vi.fn(async (_path: string, data: any) => ({ id: `encrypted-${data.key}` })),
      post: vi.fn(async (path: string, data: any) => {
        calls.push(`POST ${path}`);
        if (path === "/api/plugins/install") return { id: "plugin", status: "ready" };
        expect(path).toBe("/api/companies/company/environments");
        expect(data.config).toMatchObject({ image, apiKey: { type: "secret_ref", secretId: "encrypted-DAYTONA_API_KEY", version: "latest" } });
        expect(data).not.toHaveProperty("metadata");
        return { id: "environment", driver: "sandbox", config: data.config };
      }),
      delete: vi.fn(async () => {}),
    };
    const fixtures = await provisionFirstTaskFixtures({ api: api as any, execution: execution(), nonce: "private", company: { id: "company", name: "Fresh" },
      daytonaImage: image, credentials: { OPENAI_API_KEY: "synthetic-key", DAYTONA_API_KEY: "synthetic-platform" } });
    expect(calls).toEqual(["PATCH /api/companies/company", "POST /api/plugins/install", "POST /api/companies/company/environments", "PATCH /api/instance/settings", "PATCH /api/instance/settings/experimental"]);
    expect(api.patch).toHaveBeenCalledWith("/api/instance/settings", { defaultEnvironmentId: "environment" });
    expect(api.patch).toHaveBeenCalledWith("/api/instance/settings/experimental", { enableManagedSandboxOnly: true });
    expect(fixtures.agent.id).toBe("");
    expect(fixtures.setupLeases).toEqual([]);
    expect(JSON.stringify(fixtures)).not.toContain("synthetic");
    await fixtures.teardown();
    expect(api.delete).toHaveBeenCalledExactlyOnceWith("/api/environments/environment?destroyReusableSandboxLeases=true", { allowNotFound: true });
  });

  it.each(["missing-key", "mutable-image", "other-cell"])("rejects %s before admitting a managed browser fixture", async mode => {
    const api = { get: vi.fn(), patch: vi.fn(), postSensitive: vi.fn(), post: vi.fn(), delete: vi.fn() };
    await expect(provisionFirstTaskFixtures({ api, execution: mode === "other-cell" ? { ...execution(), id: "other" } : execution(), nonce: "private", company: { id: "company", name: "Fresh" },
      daytonaImage: mode === "mutable-image" ? "ubuntu:24.04" : image,
      credentials: mode === "missing-key" ? { OPENAI_API_KEY: "synthetic" } : { OPENAI_API_KEY: "synthetic", DAYTONA_API_KEY: "synthetic" } })).rejects.toThrow();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.postSensitive).not.toHaveBeenCalled();
  });

  function fileEvidence() {
    const e = recording("task-card-accept");
    const last = e.checkpoints.at(-1)!;
    last.tasks = [{ id: "child", parentId: e.onboardingIssueId, status: "done" }];
    const body = `Welcome beginners. Join our free Saturday meetup ${firstTaskScenario(e.caseId, e.nonce).marker}.`;
    last.attachments = [{ id: "file", issueId: "child", originalFilename: "garden-welcome.txt", contentType: "text/plain", body,
      contentVerified: true, contentSha256: digestText(body) }];
    return e;
  }
  it("requires the downloaded verified physical artifact", () => {
    expect(managedFirstTaskFileCheck(fileEvidence()).passed).toBe(true);
  });
  it.each(["document-only", "unverified", "wrong-hash", "wrong-child", "wrong-name", "wrong-marker"])("rejects %s as physical-file proof", async mode => {
    const e = fileEvidence();
    const last = e.checkpoints.at(-1)!;
    const file = last.attachments![0]!;
    if (mode === "document-only") { last.documents = [{ ...file, key: "welcome" }]; last.attachments = []; }
    if (mode === "unverified") file.contentVerified = false;
    if (mode === "wrong-hash") file.contentSha256 = "0".repeat(64);
    if (mode === "wrong-child") file.issueId = "foreign";
    if (mode === "wrong-name") file.originalFilename = "plan.txt";
    if (mode === "wrong-marker") { file.body = "A different welcome note"; file.contentSha256 = digestText(file.body); }
    expect(managedFirstTaskFileCheck(e).passed).toBe(false);
  });

  function setupHarness(mode = "success") {
    const listeners = new Map<string, Set<(event: any) => void>>();
    const page = { on: (name: string, callback: (event: any) => void) => { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); },
      off: (name: string, callback: (event: any) => void) => listeners.get(name)?.delete(callback) };
    const fixtures = { company: { id: "company", name: "Fresh" }, environment: { id: "environment", driver: "sandbox" },
      agent: { id: "", companyId: "company", name: "Ada" }, secretRefs: {}, setupLeases: [],
      setupQualification: { recorded: false, adapterType: null, platformResponses: 0, adapterResponses: 0 }, teardown: async () => {} } as import("./live-fixtures.js").LiveFixtureValues;
    const rows = ["platform", "adapter"].map(id => ({ id, companyId: "company", environmentId: "environment", provider: "daytona", heartbeatRunId: null, issueId: null,
      status: mode === "cleanup" ? "failed" : "released", cleanupStatus: "success" }));
    if (mode === "foreign") rows[0]!.companyId = "another-company";
    let begun = false;
    const api = { get: vi.fn(async (path: string) => path.includes("environment-leases/") ? rows.find(row => path.endsWith(`/${row.id}`))
      : begun ? [...rows, { ...rows[0], id: "unrelated", issueId: "other-task" }] : []) } as unknown as RunnerApi;
    const start = (kind: "platform" | "discovery" | "adapter", runner?: string) => {
      begun = true;
      const request = { url: () => `http://fixture.test${kind === "platform" ? "/api/environments/environment/probe?companyId=company"
        : kind === "discovery" ? "/api/adapters?companyId=company&environmentId=environment" : "/api/companies/company/adapters/codex_local/test-environment"}`,
        method: () => kind === "discovery" ? "GET" : "POST", postDataJSON: () => runner ? { runner } : {} };
      for (const listener of listeners.get("request") ?? []) listener(request);
      return request;
    };
    const respond = (request: ReturnType<typeof start>, body: any) => {
      const response = { request: () => request, json: async () => body, ok: () => true };
      for (const listener of listeners.get("response") ?? []) listener(response);
    };
    const emit = (kind: "platform" | "discovery" | "adapter", body: any, runner?: string) => respond(start(kind, runner), body);
    const fail = (request: ReturnType<typeof start>) => {
      for (const listener of listeners.get("requestfailed") ?? []) listener(request);
    };
    return { fixtures, page: page as unknown as import("@playwright/test").Page, api, emit, start, respond, fail, listeners, rows };
  }

  it.each(["missing-response", "request-failed"])("retains unknown adapter setup cost after %s without an attributable row", async mode => {
    const h = setupHarness();
    h.rows.splice(1);
    const stop = await observeManagedFirstTaskSetup(h.page, h.api, h.fixtures, Date.now() + 1000);
    h.emit("platform", { ok: true, details: { platformQualificationRecorded: true, leaseId: "platform" } });
    const request = h.start("adapter");
    if (mode === "request-failed") h.fail(request);
    await stop(false);
    expect(h.fixtures.setupLeases!.map(row => row.leaseId)).toEqual(["platform"]);
    expect(h.fixtures.setupLeaseAccountingIncomplete).toBe(true);
    expect(h.fixtures.setupQualification!.adapterResponses).toBe(0);
    const leases = selectFixtureRuntimeLeases({ leases: h.rows.map(row => ({ ...row,
      acquiredAt: "2026-10-13T00:00:00Z", releasedAt: "2026-10-13T00:00:02Z", metadata: { cpu: 4, memory: 4, disk: 10 } })),
      runIds: [], setupLeaseIds: h.fixtures.setupLeases!.map(row => row.leaseId) });
    const usage = fixtureRuntimeCostCoverage(buildRuntimeUsage({ environmentId: "daytona", runs: [], leases }), h.fixtures);
    expect(usage.leaseCount).toBe(1);
    expect(usage.costStatus).toBe("unavailable");
    expect(usage).not.toHaveProperty("estimatedListCostUsd");
    expect([...h.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
  });

  it("retains unknown failed platform setup without a response or visible lease row", async () => {
    const h = setupHarness();
    h.rows.splice(0);
    const stop = await observeManagedFirstTaskSetup(h.page, h.api, h.fixtures, Date.now() + 1000);
    h.fail(h.start("platform"));
    await stop(false);
    expect(h.fixtures.setupLeases).toEqual([]);
    expect(h.fixtures.setupLeaseAccountingIncomplete).toBe(true);
    expect(h.fixtures.setupQualification!.recorded).toBe(false);
  });

  it("does not clear failed-request accounting uncertainty when later responses correlate", async () => {
    const h = setupHarness();
    const stop = await observeManagedFirstTaskSetup(h.page, h.api, h.fixtures, Date.now() + 1000);
    h.emit("platform", { ok: true, details: { platformQualificationRecorded: true, leaseId: "platform" } });
    const request = h.start("adapter");
    h.fail(request);
    h.respond(request, { adapterType: "paperclip_runner", status: "pass", checks: [{ code: "sandbox_test_identity", detail: "paperclipLeaseId=adapter" }] });
    await stop(false);
    expect(h.fixtures.setupLeases!.map(row => row.leaseId)).toEqual(["platform", "adapter"]);
    expect(h.fixtures.setupLeaseAccountingIncomplete).toBe(true);
  });

  it.each(["success", "missing-discovery", "explicit-runner", "duplicate", "foreign", "cleanup"])("verifies exact UI setup responses and owned cleanup for %s", async mode => {
    const h = setupHarness(mode);
    const stop = await observeManagedFirstTaskSetup(h.page, h.api, h.fixtures, mode === "cleanup" ? Date.now() - 1 : Date.now() + 1000);
    const platform = { ok: true, details: { platformQualificationRecorded: true, leaseId: "platform" } };
    h.emit("platform", platform);
    if (mode === "duplicate") h.emit("platform", platform);
    if (mode !== "missing-discovery") h.emit("discovery", [{ type: "codex_local", defaultRunner: "paperclip", supportedRunners: ["paperclip", "legacy"] }]);
    h.emit("adapter", { adapterType: "paperclip_runner", status: "pass", checks: [{ code: "sandbox_test_identity", detail: "paperclipLeaseId=adapter; providerLeaseId=private-provider" }] }, mode === "explicit-runner" ? "paperclip" : undefined);
    if (mode === "success") { await stop(true); expect(h.fixtures.setupLeases!.map(row => row.leaseId)).toEqual(["platform", "adapter"]); }
    else await expect(stop(true)).rejects.toThrow();
    expect(h.fixtures.setupLeases!.some(row => row.leaseId === "unrelated")).toBe(false);
    expect([...h.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
  });

  it("reports a rejected platform setup immediately without waiting for the long browser deadline", async () => {
    const h = setupHarness();
    const stop = await observeManagedFirstTaskSetup(h.page, h.api, h.fixtures, Date.now() + 1000);
    const rejected = expect(stop.failure).rejects.toThrow("UI environment qualification did not pass");
    h.emit("platform", { ok: false, details: { leaseId: "platform", platformQualificationRecorded: false } });
    await rejected;
    await stop(false);
    expect(h.fixtures.setupLeases!.map(row => row.leaseId)).toEqual(["platform"]);
  });

  it("keeps an uncorrelated lease out of setup billing and retains unavailable cost coverage", async () => {
    const h = setupHarness();
    const stop = await observeManagedFirstTaskSetup(h.page, h.api, h.fixtures, Date.now() + 1000);
    h.emit("platform", { ok: false, details: { leaseId: "platform", platformQualificationRecorded: false } });
    await stop(false);
    expect(h.fixtures.setupLeases!.map(row => row.leaseId)).toEqual(["platform"]);
    expect(h.fixtures.setupLeaseAccountingIncomplete).toBe(true);
    expect(h.fixtures.setupQualification!.recorded).toBe(false);
  });

  it("retains exact failed setup leases for accounting without granting qualification", async () => {
    const h = setupHarness();
    const stop = await observeManagedFirstTaskSetup(h.page, h.api, h.fixtures, Date.now() + 1000);
    h.emit("platform", { ok: true, details: { leaseId: "platform", platformQualificationRecorded: true } });
    h.emit("adapter", { adapterType: "paperclip_runner", status: "fail", checks: [{ code: "sandbox_test_identity", detail: "paperclipLeaseId=adapter; providerLeaseId=private-provider" }] });
    await stop(false);
    expect(h.fixtures.setupLeases!.map(row => row.leaseId)).toEqual(["platform", "adapter"]);
    expect(h.fixtures.setupQualification!.adapterType).toBeNull();
  });

  it("keeps a missing response lease ID unknown even without visible lease history", async () => {
    const h = setupHarness();
    h.rows.splice(0);
    const stop = await observeManagedFirstTaskSetup(h.page, h.api, h.fixtures, Date.now() + 1000);
    h.emit("platform", { ok: false, details: { platformQualificationRecorded: false } });
    await stop(false);
    expect(h.fixtures.setupLeases).toEqual([]);
    expect(h.fixtures.setupLeaseAccountingIncomplete).toBe(true);
    expect(h.fixtures.setupQualification!.recorded).toBe(false);
  });
});
