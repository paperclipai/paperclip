import { describe, expect, it } from "vitest";
import { runnerMatrix, runnerSuites } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { discoverReportCatalog } from "./report-catalog.js";
import { gradeTaskTitle, taskTitlePrompt, taskTitleTasks, TASK_TITLE_EARLY_CALL_LIMIT, type TaskTitleEvidenceInput } from "./task-titles.js";

const prompt = taskTitlePrompt("fixture");
const provisional = prompt.replace(/\s+/g, " ").slice(0, 120);
const title = "API key rotation checklist";
const event = (eventType: string, payload: unknown) => ({ eventType, payload: { prpEvent: { payload } } });
const start = (id: string, name: string, input: unknown = {}) => event("item.started", { item: { id, name, type: "tool_use", input } });
function evidence(): TaskTitleEvidenceInput {
  return {
    prompt, explicitTitle: "", agentId: "agent", runId: "run",
    submitted: { description: prompt },
    initial: { id: "task", title: provisional, titleNeedsGeneration: true, description: prompt },
    final: { id: "task", title, titleNeedsGeneration: false, description: prompt, assigneeAgentId: "agent" },
    events: [
      start("context", "get_task_context"),
      start("naming", "set_task_title", { title, onlyIfProvisional: true, idempotencyKey: "initial-title" }),
      event("item.completed", { item: { id: "naming", tool_use_id: "naming", type: "tool_result", result: { id: "task", title, changed: true, titleNeedsGeneration: false } } }),
      event("tool.execution.completed", { name: "set_task_title", executionId: "naming", status: "completed" }),
      start("finish", "paperclip_finish"),
    ],
    activity: [{ entityId: "task", entityType: "issue", action: "issue.updated", actorType: "agent", actorId: "agent", runId: "run", details: { title, previous: { title: provisional } } }],
  };
}

describe("task title Product E2E", () => {
  it("registers six explicit-only local cells, with production instructions and no naming hints in the request", () => {
    const suite = runnerSuites.find(entry => entry.id === "task-titles")!;
    const selected = selectRunnerExecutions(parseRunnerSelectors(["--suite", suite.id]));
    expect(selected).toHaveLength(6);
    expect(selected.every(entry => entry.environment.id === "local" && entry.profile.provider === "codex")).toBe(true);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(entry => entry.suite.id === suite.id)).toBe(false);
    expect(suite.definitionMetadata).toMatchObject({ instructions: "production", providerRuns: 1, budgetMonthlyCents: 500 });
    for (const task of taskTitleTasks) {
      expect(task).toMatchObject({ expectedRunCount: 1, flow: "single_turn" });
      expect(task.buildPrompt("fixture")).not.toMatch(/title|set_task|\/api\/|finish_task|paperclip_finish/i);
    }
    const discovered = discoverReportCatalog({ catalog: runnerMatrix, expected: selected.map(entry => entry.id), results: [] });
    expect(discovered.filter(entry => entry.suite.id === suite.id)).toHaveLength(6);
  });

  it("accepts early, correlated tool evidence plus the same agent/run's persisted title mutation", () => {
    expect(gradeTaskTitle(evidence())).toMatchObject({ passed: true, initialTitle: provisional, finalTitle: title });
  });

  it.each([
    ["missing evidence", (input: TaskTitleEvidenceInput) => { input.events = []; input.activity = []; }],
    ["a missing creation request", (input: TaskTitleEvidenceInput) => { input.submitted = undefined; }],
    ["a narrated call", (input: TaskTitleEvidenceInput) => { input.events = [event("message", { text: `set_task_title(${title}) succeeded` })]; }],
    ["a stale prompt slice", (input: TaskTitleEvidenceInput) => { (input.final as Record<string, unknown>).title = provisional; }],
    ["a generic new title", (input: TaskTitleEvidenceInput) => { (input.final as Record<string, unknown>).title = "Complete the requested task"; }],
    ["a title supplied by the fixture", (input: TaskTitleEvidenceInput) => { input.submitted = { title: provisional, description: prompt }; }],
    ["missing provisional marker", (input: TaskTitleEvidenceInput) => { (input.initial as Record<string, unknown>).titleNeedsGeneration = false; }],
    ["a late title call", (input: TaskTitleEvidenceInput) => { input.events = [...Array.from({ length: TASK_TITLE_EARLY_CALL_LIMIT }, (_, i) => start(`read-${i}`, "get_task_context")), ...input.events]; }],
    ["naming after five shell tools", (input: TaskTitleEvidenceInput) => { input.events = [...Array.from({ length: TASK_TITLE_EARLY_CALL_LIMIT }, (_, i) => event("tool.execution.started", { executionId: `shell-${i}`, name: "shell" })), ...input.events]; }],
    ["naming after completion", (input: TaskTitleEvidenceInput) => { input.events = [start("already-finished", "paperclip_finish"), ...input.events]; }],
    ["an unmatched result", (input: TaskTitleEvidenceInput) => { input.events = input.events.filter(row => row.eventType !== "item.completed"); }],
    ["no successful execution receipt", (input: TaskTitleEvidenceInput) => { input.events = input.events.filter(row => row.eventType !== "tool.execution.completed"); }],
    ["another run's mutation", (input: TaskTitleEvidenceInput) => { (input.activity[0] as Record<string, unknown>).runId = "other-run"; }],
    ["a board-authored mutation", (input: TaskTitleEvidenceInput) => { (input.activity[0] as Record<string, unknown>).actorType = "user"; }],
    ["a different task", (input: TaskTitleEvidenceInput) => { (input.final as Record<string, unknown>).id = "other-task"; }],
    ["a truncated prompt", (input: TaskTitleEvidenceInput) => { (input.final as Record<string, unknown>).description = provisional; }],
  ] as const)("rejects %s", (_label, corrupt) => {
    const input = evidence(); corrupt(input);
    expect(gradeTaskTitle(input).passed).toBe(false);
  });

  it("preserves an explicit title and rejects a rename even if the original is later restored", () => {
    const input = evidence();
    input.explicitTitle = "My chosen title";
    input.submitted = { title: input.explicitTitle, description: prompt };
    input.initial = { ...(input.initial as object), title: input.explicitTitle, titleNeedsGeneration: false };
    input.final = { ...(input.final as object), title: input.explicitTitle };
    input.events = [start("context", "get_task_context"), start("finish", "paperclip_finish")];
    const forbiddenWrite = input.activity[0]; input.activity = [];
    expect(gradeTaskTitle(input).passed).toBe(true);
    const calls = input.events; input.events = [];
    expect(gradeTaskTitle(input).passed).toBe(false);
    input.events = calls;
    input.activity = [forbiddenWrite];
    expect(gradeTaskTitle(input).passed).toBe(false);
  });
});
