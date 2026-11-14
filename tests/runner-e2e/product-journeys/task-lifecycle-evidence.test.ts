import { describe, expect, it } from "vitest";
import { createIssueLabelSchema } from "../../../packages/shared/src/validators/issue.js";
import { taskLifecycleEvidence, taskLifecycleLabelName, type LifecycleObservation, type LifecycleTask } from "./task-lifecycle-evidence.js";
import { parseTargetConfig, preparationPreview } from "./catalog.js";
import { journeyRequiredChecks } from "./success-contract.js";
import { validateRetainedRunnerResult } from "../result-validation.js";
import type { RunnerE2EResult } from "../types.js";

function fixture(): Parameters<typeof taskLifecycleEvidence>[0] {
  const expected = { taskId: "task-1", companyId: "company-1", userId: "user-1", originalTitle: "Original task",
    revisedTitle: "Revised task", description: "Exact persisted context", labelName: "Owned label" };
  const initial: LifecycleTask = { id: expected.taskId, companyId: expected.companyId, identifier: "QA-1", title: expected.originalTitle,
    description: expected.description, status: "todo", priority: "medium", projectId: "project-1", assigneeUserId: expected.userId,
    assigneeAgentId: null, createdByUserId: expected.userId, createdByAgentId: null, labelIds: [], completedAt: null };
  const observe = (task: LifecycleTask, labelVisible: boolean): LifecycleObservation => ({ task: structuredClone(task), runCount: 0,
    titleVisible: true, descriptionVisible: true, statusVisible: true, labelVisible });
  const edited = { ...initial, title: expected.revisedTitle, status: "in_progress", labelIds: ["label-1"] };
  return { expected, label: { id: "label-1", name: expected.labelName, companyId: expected.companyId, color: "#0088ff" },
    created: observe(initial, false), edited: observe(edited, true), reloaded: observe(edited, true),
    completed: observe({ ...edited, status: "done", completedAt: "2026-01-01T00:00:00.000Z" }, true),
    reopened: observe({ ...edited, status: "todo" }, true) };
}
const stages = ["created", "edited", "reloaded", "completed", "reopened"] as const;

describe("task lifecycle saved-state oracle", () => {
  it("keeps a full generated campaign identity within the production label-name limit", () => {
    const campaigns = ["journey-1793720364049-f3055878", "journey-9999999999999-ffffffff"];
    const labels = campaigns.map(taskLifecycleLabelName);
    for (const [index, name] of labels.entries()) {
      expect(name).toContain(campaigns[index]);
      expect(createIssueLabelSchema.shape.name.safeParse(name).success).toBe(true);
    }
    expect(new Set(labels).size).toBe(campaigns.length);
  });
  it("rejects an overlong campaign before it can produce a browser label", () => {
    expect(() => taskLifecycleLabelName("c".repeat(32))).toThrow("task_lifecycle_campaign_label_name_invalid");
  });
  it("accepts the complete browser-edit/reload/complete/reopen sequence", () => {
    expect(taskLifecycleEvidence(fixture())).toEqual({ created: true, edited: true, reloaded: true,
      completedAndReopened: true, uneditedFieldsPreserved: true, noAgentWork: true });
  });
  it("accepts a fresh backlog task and an absent project without changing either contract", () => {
    const input = fixture(); input.created.task!.status = "backlog";
    for (const stage of stages) input[stage].task!.projectId = null;
    expect(Object.values(taskLifecycleEvidence(input)).every(Boolean)).toBe(true);
  });
  it.each(stages)("rejects a missing saved task at %s", stage => {
    const input = fixture(); input[stage].task = null;
    const result = taskLifecycleEvidence(input);
    expect(result.uneditedFieldsPreserved).toBe(false);
    expect(Object.values(result).every(Boolean)).toBe(false);
  });
  it.each(["id", "companyId", "assigneeUserId", "assigneeAgentId", "createdByUserId", "createdByAgentId", "description"] as const)(
    "rejects a wrong owner or saved context field: %s", key => {
      const input = fixture(); Object.assign(input.reopened.task!, { [key]: "foreign" });
      expect(taskLifecycleEvidence(input).completedAndReopened).toBe(false);
      expect(taskLifecycleEvidence(input).uneditedFieldsPreserved).toBe(false);
    });
  it.each(["identifier", "priority", "projectId"] as const)("requires %s to survive every edit", key => {
    for (const stage of stages.slice(1)) {
      const input = fixture(); Object.assign(input[stage].task!, { [key]: "changed" });
      expect(taskLifecycleEvidence(input).uneditedFieldsPreserved).toBe(false);
    }
  });
  it.each(["edited", "reloaded", "completed", "reopened"] as const)("rejects a lost title or label at %s", stage => {
    for (const patch of [{ title: "Original task" }, { labelIds: [] }, { labelIds: ["foreign"] }, { labelIds: ["label-1", "label-1"] }]) {
      const input = fixture(); Object.assign(input[stage].task!, patch);
      expect(Object.values(taskLifecycleEvidence(input)).every(Boolean)).toBe(false);
    }
  });
  it.each(["titleVisible", "descriptionVisible", "statusVisible", "labelVisible"] as const)("requires visible reloaded %s", key => {
    for (const stage of ["reloaded", "completed", "reopened"] as const) {
      const input = fixture(); input[stage][key] = false;
      expect(Object.values(taskLifecycleEvidence(input)).every(Boolean)).toBe(false);
    }
  });
  it("does not accept a completed-looking UI without saved Done or completion time", () => {
    const wrongStatus = fixture(); wrongStatus.completed.task!.status = "in_review";
    expect(taskLifecycleEvidence(wrongStatus).completedAndReopened).toBe(false);
    for (const completedAt of [null, "", "not a timestamp"]) {
      const input = fixture(); input.completed.task!.completedAt = completedAt;
      expect(taskLifecycleEvidence(input).completedAndReopened).toBe(false);
    }
  });
  it("requires reopened Todo with its completion time cleared", () => {
    for (const patch of [{ status: "done" }, { completedAt: "2026-01-01T00:00:00.000Z" }]) {
      const input = fixture(); Object.assign(input.reopened.task!, patch);
      expect(taskLifecycleEvidence(input).completedAndReopened).toBe(false);
    }
  });
  it.each(stages)("requires an explicit zero-run observation at %s", stage => {
    for (const runCount of [null, 1, -1]) {
      const input = fixture(); input[stage].runCount = runCount;
      expect(taskLifecycleEvidence(input).noAgentWork).toBe(false);
    }
  });
  it("rejects stale starting data, a wrong label and an unchanged expected title", () => {
    for (const change of [
      (input: ReturnType<typeof fixture>) => { input.created.task!.labelIds = ["existing"]; },
      (input: ReturnType<typeof fixture>) => { input.created.task!.status = "done"; },
      (input: ReturnType<typeof fixture>) => { input.label = null; },
      (input: ReturnType<typeof fixture>) => { input.label!.companyId = "foreign"; },
      (input: ReturnType<typeof fixture>) => { input.label!.name = "Other label"; },
      (input: ReturnType<typeof fixture>) => { input.label!.color = "invalid"; },
      (input: ReturnType<typeof fixture>) => { input.expected.revisedTitle = input.expected.originalTitle; },
    ]) {
      const input = fixture(); change(input);
      expect(Object.values(taskLifecycleEvidence(input)).every(Boolean)).toBe(false);
    }
  });
});

function result(): RunnerE2EResult {
  return { schema: "paperclip.runner-e2e.result/v2", suiteId: "product-journeys", suiteDefinitionHash: "test",
    executionId: "product-journeys.qa.browser.daytona.task-edit-lifecycle", profileId: "browser", environmentId: "daytona",
    caseId: "task-edit-lifecycle", provider: null, model: null, runtimeMode: "none", status: "passed", cleanup: "passed",
    attempt: 1, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", durationMs: 1000,
    productJourney: { outcome: "passed", startingState: "recipe", phases: [{ phase: "journey", outcome: "passed" }],
      checks: journeyRequiredChecks["task-edit-lifecycle"]!.map(id => ({ id, passed: true })), privacy: "private", resourceDisposition: "released",
      deployment: { kind: "cloud", targetId: "qa", origin: "https://qa.example.test", commit: "a".repeat(40),
        cloudRelease: "test", runtimeImage: null, configurationHash: "test" } } };
}

describe("task lifecycle discovery and report contract", () => {
  it("previews a browser-only existing target with no provider allowance", () => {
    const config = parseTargetConfig({ version: 1, id: "qa", mode: "existing-cloud", adapterModule: "/private/adapter.mjs",
      journeys: ["task-edit-lifecycle"], executionEnvironment: "daytona", baseline: { features: {}, connections: [] },
      limits: { durationMs: 180000, maxRuns: 0, modelBudgetCents: 0 } });
    expect(preparationPreview(config).journeys).toMatchObject([{ id: "task-edit-lifecycle", paid: false }]);
    expect(config.limits.maxRuns).toBe(0);
  });
  it("rejects every missing required check and unexpected native work", () => {
    expect(() => validateRetainedRunnerResult(result())).not.toThrow();
    for (const id of journeyRequiredChecks["task-edit-lifecycle"]!) {
      const missing = result(); missing.productJourney!.checks = missing.productJourney!.checks.filter(check => check.id !== id);
      expect(() => validateRetainedRunnerResult(missing)).toThrow();
    }
    for (const patch of [{ provider: "openai" }, { model: "wrong" }, { runtimeMode: "native" }, { runIds: ["unexpected"] }]) {
      expect(() => validateRetainedRunnerResult({ ...result(), ...patch })).toThrow();
    }
    const usage = result(); usage.usage = { runs: [{ runId: "unexpected", usage: { inputTokens: 1 } }] };
    expect(() => validateRetainedRunnerResult(usage)).toThrow("result.browserOnly");
    const emptyUsage = result(); emptyUsage.usage = { runs: [] };
    expect(() => validateRetainedRunnerResult(emptyUsage)).not.toThrow();
  });
});
