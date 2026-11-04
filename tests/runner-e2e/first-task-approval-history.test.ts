import { describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { runnerMatrix } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { firstTaskScenario } from "./first-task-cases.js";
import { APPROVAL_HISTORY_CASE, APPROVAL_HISTORY_SUITE, DRAFT_OPTION, PUBLISH_OPTION, approvalHistoryWriter, readApprovalHistoryRevision } from "./first-task-approval-history.js";
import { gradeFirstTask, snapshotInstruction, type FirstTaskCheckpoint, type FirstTaskEvidence, type Row } from "./first-task-scoring.js";
import { projectFirstTaskResult } from "./first-task-flow.js";
import { runApprovalHistoryDecisions } from "./first-task-approval-history-flow.js";
import { validateRetainedRunnerResult } from "./result-validation.js";
import type { RunnerE2EResult } from "./types.js";

function recording(): FirstTaskEvidence {
  const { marker } = firstTaskScenario(APPROVAL_HISTORY_CASE, "history");
  const at = (minute: number) => `2026-11-01T00:${String(minute).padStart(2, "0")}:00Z`;
  const parent = { id: "parent", title: "First task", status: "in_review", description: "/first-task" };
  const plan = { id: "plan", issueId: "parent", key: "plan", title: "Plan", body: `Draft then publish ${marker}`, latestRevisionId: "revision" };
  const planCard = { id: "plan-card", kind: "request_checkbox_confirmation", status: "pending", createdAt: at(2), payload: {
    options: [{ id: "draft", label: DRAFT_OPTION }, { id: "publish", label: PUBLISH_OPTION }], defaultSelectedOptionIds: ["draft", "publish"],
    target: { type: "issue_document", key: "plan", documentId: "plan", revisionId: "revision" },
  } };
  const hireCard = { id: "hire-card", kind: "request_checkbox_confirmation", status: "pending", createdAt: at(4),
    payload: { options: [{ id: "writer", label: `Hire ${approvalHistoryWriter(marker)}` }] } };
  const executionCard = { id: "execution-card", kind: "request_confirmation", status: "pending", createdAt: at(6), payload: { prompt: "Start drafting" } };
  const resolve = (card: Row, minute: number, ids?: string[]) => ({ ...card, status: "accepted", resolvedByUserId: "human", resolvedAt: at(minute),
    result: { outcome: "accepted", ...(ids ? { selectedOptionIds: ids } : {}) } });
  const checkpoints: FirstTaskCheckpoint[] = [];
  const checkpoint = (phase: FirstTaskCheckpoint["phase"], minute: number, updates: Partial<FirstTaskCheckpoint> = {}) => {
    const value = structuredClone({ id: `${phase}-${minute}`, phase, at: at(minute), issueId: parent.id,
      tasks: [parent], agents: [{ id: "lead" }], comments: [], interactions: [], documents: [], runs: [],
      ...checkpoints.at(-1), ...updates });
    Object.assign(value, { id: `${phase}-${minute}`, phase, at: at(minute) });
    checkpoints.push(value);
    return value;
  };
  checkpoint("opening", 0);
  checkpoint("response", 1, { comments: [{ id: "interview-comment", authorAgentId: "lead", body: "Tell me about the club." }],
    interactions: [{ id: "interview", kind: "ask_user_questions", status: "answered", payload: {
      questions: ["goal", "audience", "done"].map(id => ({ id, answerMode: "text", prompt: id })),
    } }], runs: [{ id: "interview-run", status: "succeeded" }] });
  checkpoint("clarified", 2, { interactions: [planCard], documents: [plan] });
  checkpoint("plan-accepted", 3, { interactions: [resolve(planCard, 3, ["draft"])] });
  checkpoint("hiring-proposed", 4, { interactions: [resolve(planCard, 3, ["draft"]), hireCard] });
  checkpoint("hiring-accepted", 5, { interactions: [resolve(planCard, 3, ["draft"]), resolve(hireCard, 5, ["writer"])] });
  checkpoint("execution-proposed", 6, { agents: [{ id: "lead" }, { id: "writer", name: approvalHistoryWriter(marker), createdAt: at(5) }],
    interactions: [resolve(planCard, 3, ["draft"]), resolve(hireCard, 5, ["writer"]), executionCard] });
  checkpoint("accepted", 7, { interactions: [resolve(planCard, 3, ["draft"]), resolve(hireCard, 5, ["writer"]), resolve(executionCard, 7)] });
  checkpoint("finished", 8, { tasks: [{ ...parent, status: "done" }, { id: "child", parentId: "parent", assigneeAgentId: "writer", status: "done", createdAt: at(7) }],
    documents: [plan, { id: "welcome", issueId: "child", key: "welcome", latestRevisionId: "welcome-revision",
      body: `Welcome, beginners. Join our free Saturday meetup ${marker}.`, savedRevision: { id: "welcome-revision", documentId: "welcome",
        issueId: "child", key: "welcome", body: `Welcome, beginners. Join our free Saturday meetup ${marker}.`,
        createdByAgentId: "writer", createdByRunId: "child-run", createdByUserId: null } }],
    runs: [{ id: "parent-run", nativeIssueId: "parent", agentId: "lead", status: "succeeded", startedAt: at(7) },
      { id: "child-run", nativeIssueId: "child", agentId: "writer", status: "succeeded", runtimeMode: "native", startedAt: at(7) }] });
  checkpoint("finished", 9);
  return { caseId: APPROVAL_HISTORY_CASE, nonce: "history", onboardingIssueId: "parent", agentId: "lead", initialTaskIds: ["parent"],
    configuredModel: "fixture-model", observedModels: ["fixture-model"], instructions: [snapshotInstruction("AGENTS.md", "Persona"),
      snapshotInstruction("first-task/SKILL.md", "First-task instructions")], checkpoints, checks: [] };
}
const failures = (e: FirstTaskEvidence) => gradeFirstTask(e).filter(check => !check.passed).map(check => check.id);

describe("onboarding approval history journey", () => {
  it("registers two explicit native cells without changing the default paid campaign", () => {
    const cells = selectRunnerExecutions(parseRunnerSelectors(["--suite", APPROVAL_HISTORY_SUITE]));
    expect(cells.map(cell => cell.id)).toEqual([`onboarding-approval-history.runner-codex.local.${APPROVAL_HISTORY_CASE}`,
      `onboarding-approval-history.runner-acpx-claude.local.${APPROVAL_HISTORY_CASE}`]);
    expect(cells.every(cell => cell.task.automaticRetryPolicy === "single_attempt" && cell.task.expectedRunCount === 7)).toBe(true);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(cell => cell.suite.id === APPROVAL_HISTORY_SUITE)).toBe(false);
    expect(runnerMatrix.filter(cell => cell.suite.id === "first-task")).toHaveLength(52);
  });

  it("accepts the complete interview, partial plan approval, hiring, execution, and reload recording", () => {
    expect(failures(recording())).toEqual([]);
  });

  it.each(runnerMatrix.filter(cell => cell.suite.id === APPROVAL_HISTORY_SUITE))(
    "the grader's completed task matches the outer runner's expected statuses for $id", execution => {
      const evidence = recording();
      expect(failures(evidence)).toEqual([]);
      const finished = evidence.checkpoints.at(-1)!;
      const parent = finished.tasks.find(task => task.id === evidence.onboardingIssueId)!;
      const parentRuns = finished.runs.filter(run => run.nativeIssueId === parent.id);
      expect(parent.status).toBe(execution.task.expectedTerminalState.issue);
      expect(parentRuns).not.toHaveLength(0);
      expect(parentRuns.every(run => run.status === execution.task.expectedTerminalState.run)).toBe(true);
    });

  it("rejects a completed writer task when the onboarding parent remains in review", () => {
    const evidence = recording();
    for (const checkpoint of evidence.checkpoints.filter(c => c.phase === "finished")) {
      checkpoint.tasks.find(task => task.id === evidence.onboardingIssueId)!.status = "in_review";
    }
    expect(failures(evidence)).toContain("reload-retains-completion");
  });

  it("reads the exact saved document revision through its production API", async () => {
    const document = recording().checkpoints.at(-1)!.documents[1];
    const get = vi.fn(async (_path: string) => document.savedRevision);
    const read = await readApprovalHistoryRevision({ get: async <T>(path: string) => await get(path) as T }, document);
    expect(get).toHaveBeenCalledExactlyOnceWith("/api/issues/child/documents/welcome/revisions/welcome-revision");
    expect(read.savedRevision).toMatchObject({ createdByAgentId: "writer", createdByRunId: "child-run" });
  });

  it.each(["id", "documentId", "issueId", "key", "body"])("rejects a mismatched saved revision %s", async field => {
    const document = recording().checkpoints.at(-1)!.documents[1];
    const get = async <T>() => ({ ...document.savedRevision, [field]: "foreign" }) as T;
    await expect(readApprovalHistoryRevision({ get }, document)).rejects.toThrow("onboarding_saved_revision_binding_mismatch");
  });

  it("clears the unchecked plan step and operates all three saved approval controls before reload", async () => {
    const evidence = recording();
    const events: string[] = [];
    const clickedAt: number[] = [];
    const state = (phase: FirstTaskCheckpoint["phase"]) => structuredClone(evidence.checkpoints.find(c => c.phase === phase)!);
    let current = state("clarified");
    const selections = new Set(["draft", "publish"]);
    const page = { getByRole: (_role: string, { name }: { name: string }) => ({ last: () => ({
      check: async () => { events.push(`check:${name}`); if (name === DRAFT_OPTION) selections.add("draft"); },
      uncheck: async () => { events.push(`uncheck:${name}`); selections.delete("publish"); },
      click: async () => {
        clickedAt.push(Date.now());
        // Work can begin while the acceptance response is still in flight.
        vi.setSystemTime(Date.now() + 5_000);
        const pending = current.interactions.find(card => card.status === "pending")!;
        events.push(`accept:${pending.id}`);
        current = state(pending.id === "plan-card" ? "plan-accepted" : pending.id === "hire-card" ? "hiring-accepted" : "accepted");
        if (pending.id === "plan-card") current.interactions[0].result.selectedOptionIds = [...selections];
      },
    }) }), reload: async () => { events.push("reload"); } } as unknown as Page;
    const snapshot = vi.fn(async (phase: FirstTaskCheckpoint["phase"], _at?: string) => { events.push(phase); return structuredClone(current); });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await runApprovalHistoryDecisions({ page, api: { get: async <T>() => structuredClone(current.interactions) as T }, issueId: "parent",
        marker: firstTaskScenario(APPROVAL_HISTORY_CASE, "history").marker, deadlineAt: Date.now() + 30_000,
        allRuns: async () => current.runs, snapshot, capture: vi.fn(async () => undefined),
        settle: async (_runs, completion) => {
          current = state(completion ? "finished" : current.phase === "plan-accepted" ? "hiring-proposed" : "execution-proposed");
        },
      });
      expect(snapshot.mock.calls.filter(([phase]) => ["plan-accepted", "hiring-accepted", "accepted"].includes(phase)).map(([, at]) => at))
        .toEqual(clickedAt.map(at => new Date(at).toISOString()));
    } finally { vi.useRealTimers(); }
    expect([...selections]).toEqual(["draft"]);
    expect(events).toEqual([`check:${DRAFT_OPTION}`, `uncheck:${PUBLISH_OPTION}`, "accept:plan-card", "plan-accepted", "hiring-proposed",
      `check:Hire ${approvalHistoryWriter(firstTaskScenario(APPROVAL_HISTORY_CASE, "history").marker)}`, "accept:hire-card", "hiring-accepted",
      "execution-proposed", "accept:execution-card", "accepted", "finished", "reload", "finished"]);
  });

  it.each<readonly [string, (e: FirstTaskEvidence) => void, string]>([
    ["approved run without a child", e => { e.checkpoints.at(-1)!.tasks.pop(); }, "approved-writer-executes-once"],
    ["missing execution decision", e => { e.checkpoints.at(-1)!.interactions.pop(); }, "three-separate-human-approvals"],
    ["agent-only execution acceptance", e => { e.checkpoints.at(-1)!.interactions.at(-1)!.resolvedByAgentId = "lead"; }, "three-separate-human-approvals"],
    ["hiring accepted with no writer selected", e => { e.checkpoints.at(-1)!.interactions[1].result.selectedOptionIds = []; }, "three-separate-human-approvals"],
    ["execution confirmation targeted to the plan", e => { e.checkpoints.at(-1)!.interactions.at(-1)!.payload.target = { key: "plan" }; }, "three-separate-human-approvals"],
    ["new task before execution approval", e => { e.checkpoints.find(c => c.phase === "execution-proposed")!.tasks.push({ id: "early" }); }, "no-premature-work"],
    ["hire before hiring approval", e => { e.checkpoints.find(c => c.phase === "hiring-proposed")!.agents.push({ id: "early" }); }, "no-premature-work"],
    ["defaults substituted for actual choices", e => { e.checkpoints.at(-1)!.interactions[0].result.selectedOptionIds = ["draft", "publish"]; }, "selected-plan-scope-retained"],
    ["changed plan revision", e => { e.checkpoints.at(-1)!.documents[0].latestRevisionId = "changed"; }, "selected-plan-scope-retained"],
    ["task assigned to the lead", e => { e.checkpoints.at(-1)!.tasks[1].assigneeAgentId = "lead"; }, "approved-writer-executes-once"],
    ["duplicate child execution", e => { e.checkpoints.at(-1)!.runs.push({ ...e.checkpoints.at(-1)!.runs[1], id: "duplicate" }); }, "approved-writer-executes-once"],
    ["no saved output after successful runs", e => { e.checkpoints.at(-1)!.documents.pop(); }, "durable-completion"],
    ["no persisted output after reload", e => { e.checkpoints.at(-1)!.documents.pop(); }, "reload-retains-completion"],
    ["lead-authored writer output", e => { e.checkpoints.at(-1)!.documents[1].savedRevision.createdByAgentId = "lead"; }, "writer-authored-output"],
    ["output from the wrong child run", e => { e.checkpoints.at(-1)!.documents[1].savedRevision.createdByRunId = "parent-run"; }, "writer-authored-output"],
    ["missing saved revision proof", e => { delete e.checkpoints.at(-1)!.documents[1].savedRevision; }, "writer-authored-output"],
    ["saved revision body mismatch", e => { e.checkpoints.at(-1)!.documents[1].savedRevision.body = "Different output"; }, "writer-authored-output"],
    ["output without a current revision reference", e => { delete e.checkpoints.at(-1)!.documents[1].latestRevisionId; }, "writer-authored-output"],
    ["writer switched to legacy execution", e => { e.checkpoints.at(-1)!.runs[1].runtimeMode = "legacy"; }, "writer-authored-output"],
    ["changed saved output after reload", e => { e.checkpoints.at(-1)!.documents[1].body += " Changed."; }, "reload-retains-completion"],
    ["duplicate approval left pending", e => { e.checkpoints.at(-1)!.interactions.push({ id: "duplicate", status: "pending", kind: "request_confirmation" }); }, "no-pending-approvals"],
    ["missing intermediate approval observations", e => { e.checkpoints = e.checkpoints.filter(c => c.phase !== "hiring-accepted"); }, "approval-history-stages"],
  ])("rejects %s", (_name, mutate, expected) => {
    const evidence = recording();
    mutate(evidence);
    expect(failures(evidence)).toContain(expected);
  });

  it("retains enough public evidence to regrade actual checkbox choices and the later child run", () => {
    const evidence = recording();
    const result: RunnerE2EResult = { schema: "paperclip.runner-e2e.result/v2", suiteId: APPROVAL_HISTORY_SUITE,
      executionId: `${APPROVAL_HISTORY_SUITE}.runner-codex.local.${APPROVAL_HISTORY_CASE}`, attempt: 1, status: "passed",
      profileId: "runner-codex", environmentId: "local", caseId: APPROVAL_HISTORY_CASE, provider: "openai", model: "fixture-model",
      runtimeMode: "native", runIds: ["parent-run", "child-run"], startedAt: "2026-11-01T00:00:00Z", finishedAt: "2026-11-01T00:09:00Z",
      durationMs: 540_000, cleanup: "passed", firstTask: evidence };
    const projected = projectFirstTaskResult(result);
    validateRetainedRunnerResult(projected);
    expect(failures(projected.firstTask!)).toEqual([]);
    expect(projected.firstTask!.checkpoints.at(-1)!.interactions[0].result.selectedOptionIds).toEqual(["draft"]);
  });
});
