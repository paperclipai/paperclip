import { describe, expect, it } from "vitest";
import { mapBrabrixTaskToAgentGoal } from "../services/brabrix-task-goal-mapper.js";
import type { BrabrixTask, ProjectContext } from "../integrations/brabrix/brabrix-types.js";

describe("mapBrabrixTaskToAgentGoal", () => {
  it("maps a Brabrix task into an agent goal with contextual metadata", () => {
    const task: BrabrixTask = {
      taskId: "task-44",
      title: "Implementar testes de regressao no fluxo de pagamento",
      description: "Adicionar cobertura automatizada para regressao do checkout.",
      projectId: "project-9",
      priority: "high",
      agentTypeHint: "qa",
      acceptanceCriteria: ["Todos os cenarios criticos devem passar em CI"],
      skillContext: [{ skillKey: "qa.e2e", name: "QA E2E" }],
    };
    const projectContext: ProjectContext = {
      projectId: "project-9",
      name: "Checkout Project",
    };

    const mapped = mapBrabrixTaskToAgentGoal({ task, projectContext });

    expect(mapped.goal).toMatchObject({
      source: "brabrix",
      sourceTaskId: "task-44",
      sourceProjectId: "project-9",
      title: "Implementar testes de regressao no fluxo de pagamento",
      level: "task",
      status: "planned",
      agentProfile: "qa",
    });
    expect(mapped.goal.metadata).toMatchObject({
      priority: "high",
      preferredModel: "gpt-5.4-mini",
      skillsApplied: ["qa.e2e"],
    });
    expect(mapped.goal.description).toContain("Acceptance Criteria");
    expect(mapped.context.profile.key).toBe("qa");
    expect(mapped.context.sections.some((section) => section.key === "acceptance_criteria")).toBe(true);
  });
});
