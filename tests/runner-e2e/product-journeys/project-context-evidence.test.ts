import { describe, expect, it } from "vitest";
import { parseTargetConfig, preparationPreview, productJourneys } from "./catalog.js";
import { projectContextEvidencePasses, type ProjectContextObservation } from "./project-context-evidence.js";
import { journeyRequiredChecks } from "./success-contract.js";

function observation(): ProjectContextObservation {
  const project = { id: "project", companyId: "company", name: "Journey project campaign", status: "planned", archivedAt: null };
  const task = { id: "task", companyId: "company", title: "Journey task campaign", description: "Review this myself.", projectId: "project",
    assigneeUserId: "user", assigneeAgentId: null, workMode: "standard" };
  return { companyId: "company", userId: "user", projectId: "project", projectName: project.name,
    taskId: "task", taskTitle: task.title, prompt: task.description,
    projectBeforeReload: { ...project }, projectAfterReload: { ...project }, taskBeforeReload: { ...task }, taskAfterReload: { ...task },
    projectTasks: [{ ...task }], runsBeforeReload: [], runsAfterReload: [] };
}

describe("project/task context independent saved-state oracle", () => {
  it("accepts exact persisted project, task, assignment and work mode with no work runs", () => {
    expect(projectContextEvidencePasses(observation())).toBe(true);
  });
  it.each(["projectBeforeReload", "projectAfterReload"] as const)("rejects a wrong or missing %s", key => {
    for (const patch of [{ id: "foreign" }, { companyId: "foreign" }, { name: "another project" }, { status: "completed" }, { archivedAt: "2099-01-01T00:00:00Z" }]) {
      const saved = observation();
      Object.assign(saved[key], patch);
      expect(projectContextEvidencePasses(saved)).toBe(false);
    }
    const missing = observation();
    Reflect.deleteProperty(missing, key);
    expect(projectContextEvidencePasses(missing)).toBe(false);
  });
  it.each(["taskBeforeReload", "taskAfterReload"] as const)("rejects plausible false passes in %s", key => {
    for (const patch of [{ id: "foreign" }, { companyId: "foreign" }, { title: "wrong" }, { description: "lost prompt" }, { projectId: null },
      { projectId: "foreign" }, { assigneeUserId: "foreign" }, { assigneeAgentId: "agent" }, { workMode: "ask" }]) {
      const saved = observation();
      Object.assign(saved[key], patch);
      expect(projectContextEvidencePasses(saved)).toBe(false);
    }
    const missing = observation();
    Reflect.deleteProperty(missing, key);
    expect(projectContextEvidencePasses(missing)).toBe(false);
  });
  it("requires exact project-filtered membership and rejects any native work before or after reload", () => {
    const changes: Array<(saved: ProjectContextObservation) => void> = [
      saved => { saved.projectTasks = []; }, saved => { saved.projectTasks.push({ ...saved.projectTasks[0]! }); },
      saved => { saved.projectTasks[0]!.projectId = "foreign"; }, saved => { saved.projectTasks[0]!.companyId = "foreign"; },
      saved => { saved.projectTasks[0]!.id = "another task"; }, saved => { saved.runsBeforeReload = [{ id: "run" }]; },
      saved => { saved.runsAfterReload = [{ id: "run" }]; }, saved => { Reflect.deleteProperty(saved, "runsAfterReload"); },
      saved => { Reflect.deleteProperty(saved, "projectTasks"); }, saved => { saved.projectId = ""; },
    ];
    for (const change of changes) { const saved = observation(); change(saved); expect(projectContextEvidencePasses(saved)).toBe(false); }
  });
  it("is discoverable as a browser journey with zero model budget or native work", () => {
    const config = parseTargetConfig({ version: 1, id: "project-qa", mode: "managed-self-hosted", journeys: ["project-task-context"],
      executionEnvironment: "local", baseline: { features: {}, connections: [] }, limits: { durationMs: 300_000, modelBudgetCents: 0, maxRuns: 0 } });
    const entry = productJourneys.find(journey => journey.id === "project-task-context")!;
    expect(entry.paid).toBe(false);
    expect(entry.requires).toEqual(["company", "board-user", "task-write"]);
    expect(preparationPreview(config).journeys).toEqual([entry]);
    expect(journeyRequiredChecks[entry.id]).toEqual(["browser-created-project-persisted", "browser-created-project-task-persisted",
      "project-task-association-reloaded", "project-task-context-visible", "no-agent-work"]);
  });
});
