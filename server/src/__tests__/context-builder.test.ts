import { describe, expect, it } from "vitest";
import { buildBrabrixAgentContext } from "../services/context-builder.js";
import type { BrabrixTask, ProjectContext } from "../integrations/brabrix/brabrix-types.js";

describe("buildBrabrixAgentContext", () => {
  it("builds modular context with PRD, technical spec, skills, stack, rules and acceptance criteria", () => {
    const task: BrabrixTask = {
      taskId: "task-1",
      title: "Implementar endpoint de checkout",
      description: "Criar endpoint para processar checkout com validacoes.",
      agentTypeHint: "backend",
      prd: "Checkout deve permitir cartoes e pix.",
      technicalSpec: "Usar endpoint POST /api/checkout com idempotencia por request-id.",
      stack: ["Node.js", "PostgreSQL"],
      projectRules: ["Nao quebrar compatibilidade retroativa"],
      acceptanceCriteria: ["Retornar 200 com payload de confirmacao"],
      skillContext: [{ skillKey: "backend.api", name: "Backend API" }],
    };

    const projectContext: ProjectContext = {
      projectId: "project-1",
      name: "Brabrix Checkout",
      skills: [{ skillKey: "security.auth", name: "Auth Security" }],
      metadata: {
        stack: ["PostgreSQL", "Redis"],
        projectRules: ["Sem hardcode de secrets"],
        acceptanceCriteria: ["Cobrir testes de erro 4xx e 5xx"],
      },
    };

    const context = buildBrabrixAgentContext({ task, projectContext });
    const sectionKeys = context.sections.map((section) => section.key);

    expect(context.profile.key).toBe("backend");
    expect(sectionKeys).toEqual([
      "task",
      "prd",
      "technical_spec",
      "skills",
      "stack",
      "project_rules",
      "acceptance_criteria",
    ]);
    expect(context.skillsApplied).toEqual(["backend.api", "security.auth"]);
    expect(context.estimatedChars).toBeGreaterThan(100);
    expect(context.estimatedTokens).toBeGreaterThan(20);
  });

  it("infers frontend profile from task semantics", () => {
    const task: BrabrixTask = {
      taskId: "task-2",
      title: "Criar UI React para tela de onboarding",
      description: "Montar componentes de formulario com CSS responsivo.",
    };

    const context = buildBrabrixAgentContext({ task });
    expect(context.profile.key).toBe("frontend");
  });

  it("infers qa profile from testing semantics", () => {
    const task: BrabrixTask = {
      taskId: "task-3",
      title: "Executar testes E2E e regressao",
      description: "Validar fluxos criticos e reportar falhas.",
    };

    const context = buildBrabrixAgentContext({ task });
    expect(context.profile.key).toBe("qa");
  });
});
