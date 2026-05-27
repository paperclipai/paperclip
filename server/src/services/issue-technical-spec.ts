import type { IssueDocument } from "@paperclipai/shared";

export type IssueTechnicalSpecLanguage = "en" | "pt-BR";

export interface IssueTechnicalSpecIssueContext {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  labels: Array<{ name: string }>;
}

export interface IssueTechnicalSpecProjectContext {
  id: string;
  name: string;
  description: string | null;
}

export interface IssueTechnicalSpecGoalContext {
  id: string;
  title: string;
  description: string | null;
  status: string;
}

export interface IssueTechnicalSpecWorkspaceContext {
  id: string;
  name: string;
  cwd: string | null;
}

export interface BuildIssueTechnicalSpecInput {
  language: IssueTechnicalSpecLanguage;
  issue: IssueTechnicalSpecIssueContext;
  project: IssueTechnicalSpecProjectContext | null;
  goal: IssueTechnicalSpecGoalContext | null;
  workspace: IssueTechnicalSpecWorkspaceContext | null;
  planContext: string | null;
  projectContext: string | null;
  documents: Array<Pick<IssueDocument, "key" | "title" | "body">>;
}

const MAX_CONTEXT_SNIPPET_CHARS = 1_200;

const COPY = {
  en: {
    title: "Technical Spec",
    sectionTitle: {
      summary: "1. Summary",
      context: "2. Context",
      objective: "3. Technical Objective",
      businessRules: "4. Business Rules",
      inScope: "5. Included Scope",
      outOfScope: "6. Out of Scope",
      impacts: "7. Technical Impacts",
      apiContracts: "8. APIs/Contracts",
      dataModel: "9. Data Model",
      acceptanceCriteria: "10. Acceptance Criteria",
      testPlan: "11. Test Plan",
      risks: "12. Risks and Attention Points",
      checklist: "13. Implementation Checklist",
      subtasks: "14. Suggested Subtasks",
    },
    labels: {
      unknown: "Not provided.",
      none: "None",
      notApplicable: "Not applicable for now.",
      yes: "Yes",
      issueStatus: "Issue status",
      issuePriority: "Issue priority",
      issueLabels: "Issue labels",
      relatedProject: "Related project",
      relatedGoal: "Related goal",
      currentWorkspace: "Current workspace",
      projectContextAvailable: "Project context available",
      planContextAvailable: "Issue plan context available",
      projectContextHeading: "Project context",
      planContextHeading: "Issue plan context",
      impactProject: "Project domain",
      impactWorkspace: "Workspace/runtime touchpoint",
      impactGoal: "Goal alignment",
      impactDocuments: "Issue documents to review",
    },
    status: {
      backlog: "Backlog",
      todo: "To do",
      in_progress: "In progress",
      in_review: "In review",
      blocked: "Blocked",
      done: "Done",
      cancelled: "Cancelled",
    },
    priority: {
      low: "Low",
      medium: "Medium",
      high: "High",
      critical: "Critical",
    },
    defaults: {
      summary:
        "Implement the issue with focus on predictable delivery, preserving existing behavior and system compatibility.",
      objective:
        "Deliver the requested functionality end-to-end with clear technical boundaries and no regressions in existing flows.",
      businessRules: [
        "Respect the current issue workflow and status transitions.",
        "Do not break current user-facing behavior unless explicitly requested.",
        "Keep compatibility with existing project and workspace conventions.",
      ],
      inScope: [
        "Implement only what is required to complete this issue.",
        "Update tests and validation points directly related to this change.",
        "Document implementation decisions when they affect maintenance or onboarding.",
      ],
      outOfScope: [
        "Large architectural rewrites unrelated to this issue.",
        "Breaking changes across unrelated modules.",
        "Scope expansion without explicit product or engineering approval.",
      ],
      apiContracts: [
        "Reuse existing APIs/contracts whenever possible.",
        "If new contracts are needed, keep them minimal and backward-compatible.",
      ],
      dataModel: [
        "No data model changes are required unless the implementation explicitly needs persistence updates.",
      ],
      acceptanceCriteria: [
        "The implementation satisfies the issue objective.",
        "No regressions are introduced in existing flows.",
        "Changes can be validated with repeatable test scenarios.",
      ],
      testPlan: [
        "Unit tests for new/changed logic.",
        "Integration checks for touched boundaries.",
        "Manual validation for main user path and edge cases.",
      ],
      risks: [
        "Ambiguous requirements can create rework.",
        "Hidden coupling with adjacent modules may cause regressions.",
        "Missing environment parity can affect reproducibility.",
      ],
      checklist: [
        "Review issue context, dependencies, and constraints.",
        "Implement the change with clear commit boundaries.",
        "Validate behavior with automated and manual tests.",
        "Document important decisions and follow-up tasks.",
      ],
      subtasks: [
        "Refine technical approach and impacted components.",
        "Implement backend and/or frontend changes.",
        "Add/update tests and quality checks.",
        "Run final verification and prepare review notes.",
      ],
    },
  },
  "pt-BR": {
    title: "Spec Técnica",
    sectionTitle: {
      summary: "1. Resumo",
      context: "2. Contexto",
      objective: "3. Objetivo técnico",
      businessRules: "4. Regras de negócio",
      inScope: "5. Escopo incluído",
      outOfScope: "6. Fora de escopo",
      impacts: "7. Impactos técnicos",
      apiContracts: "8. APIs/Contratos",
      dataModel: "9. Modelo de dados",
      acceptanceCriteria: "10. Critérios de aceite",
      testPlan: "11. Plano de testes",
      risks: "12. Riscos e pontos de atenção",
      checklist: "13. Checklist de implementação",
      subtasks: "14. Sugestão de subtasks",
    },
    labels: {
      unknown: "Não informado.",
      none: "Nenhuma",
      notApplicable: "Não aplicável no momento.",
      yes: "Sim",
      issueStatus: "Status da issue",
      issuePriority: "Prioridade da issue",
      issueLabels: "Labels da issue",
      relatedProject: "Projeto relacionado",
      relatedGoal: "Objetivo relacionado",
      currentWorkspace: "Workspace atual",
      projectContextAvailable: "Contexto do projeto disponível",
      planContextAvailable: "Contexto de plano da issue disponível",
      projectContextHeading: "Contexto do projeto",
      planContextHeading: "Contexto de plano da issue",
      impactProject: "Domínio de projeto",
      impactWorkspace: "Ponto de contato de workspace/runtime",
      impactGoal: "Alinhamento com objetivo",
      impactDocuments: "Documentos da issue para revisar",
    },
    status: {
      backlog: "Backlog",
      todo: "A fazer",
      in_progress: "Em andamento",
      in_review: "Em revisão",
      blocked: "Bloqueada",
      done: "Concluída",
      cancelled: "Cancelada",
    },
    priority: {
      low: "Baixa",
      medium: "Média",
      high: "Alta",
      critical: "Crítica",
    },
    defaults: {
      summary:
        "Implementar a issue com foco em entrega previsível, preservando comportamento existente e compatibilidade do sistema.",
      objective:
        "Entregar a funcionalidade solicitada de ponta a ponta com limites técnicos claros e sem regressões nos fluxos atuais.",
      businessRules: [
        "Respeitar o workflow atual da issue e transições de status.",
        "Não quebrar comportamento visível ao usuário sem solicitação explícita.",
        "Manter compatibilidade com convenções existentes de projeto e workspace.",
      ],
      inScope: [
        "Implementar apenas o necessário para concluir esta issue.",
        "Atualizar testes e pontos de validação diretamente relacionados à mudança.",
        "Documentar decisões de implementação quando impactarem manutenção ou onboarding.",
      ],
      outOfScope: [
        "Reescritas arquiteturais amplas não relacionadas a esta issue.",
        "Mudanças breaking em módulos não relacionados.",
        "Expansão de escopo sem alinhamento explícito de produto ou engenharia.",
      ],
      apiContracts: [
        "Reutilizar APIs/contratos existentes sempre que possível.",
        "Se novos contratos forem necessários, mantê-los mínimos e retrocompatíveis.",
      ],
      dataModel: [
        "Nenhuma mudança de modelo de dados é necessária, salvo quando a implementação exigir persistência adicional.",
      ],
      acceptanceCriteria: [
        "A implementação atende ao objetivo da issue.",
        "Não há regressões nos fluxos existentes.",
        "As mudanças podem ser validadas com cenários de teste reproduzíveis.",
      ],
      testPlan: [
        "Testes unitários para a lógica nova/alterada.",
        "Verificações de integração nos limites impactados.",
        "Validação manual do fluxo principal e casos de borda.",
      ],
      risks: [
        "Requisitos ambíguos podem gerar retrabalho.",
        "Acoplamentos ocultos com módulos adjacentes podem causar regressões.",
        "Diferenças de ambiente podem afetar reprodutibilidade.",
      ],
      checklist: [
        "Revisar contexto, dependências e restrições da issue.",
        "Implementar a mudança com limites claros de commit.",
        "Validar comportamento com testes automatizados e manuais.",
        "Documentar decisões importantes e próximos passos.",
      ],
      subtasks: [
        "Refinar abordagem técnica e componentes impactados.",
        "Implementar mudanças de backend e/ou frontend.",
        "Adicionar/atualizar testes e validações de qualidade.",
        "Executar verificação final e preparar notas para revisão.",
      ],
    },
  },
} as const;

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function truncate(value: string, maxChars = MAX_CONTEXT_SNIPPET_CHARS): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function linesFromDescription(description: string | null): string[] {
  const normalized = nonEmpty(description);
  if (!normalized) return [];
  return normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function bulletLines(input: string[]): string[] {
  return input
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "").trim())
    .filter(Boolean);
}

function takeBulletCandidates(description: string | null, limit = 6): string[] {
  const candidates = bulletLines(
    linesFromDescription(description).filter((line) => /^[-*]\s+/.test(line) || /^\d+[.)]\s+/.test(line)),
  );
  return candidates.slice(0, limit);
}

function inferScopeFromDescription(description: string | null, limit = 5): string[] {
  const bullets = takeBulletCandidates(description, limit);
  if (bullets.length > 0) return bullets;

  const normalized = nonEmpty(description);
  if (!normalized) return [];
  const sentenceCandidates = normalized
    .split(/[.!?]\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 20);
  return sentenceCandidates.slice(0, limit).map((part) => truncate(part, 220));
}

function formatBullets(lines: readonly string[], fallback: string): string {
  if (lines.length === 0) return `- ${fallback}`;
  return lines.map((line) => `- ${line}`).join("\n");
}

function statusLabel(language: IssueTechnicalSpecLanguage, status: string): string {
  const byKey = COPY[language].status as Record<string, string>;
  return byKey[status] ?? status;
}

function priorityLabel(language: IssueTechnicalSpecLanguage, priority: string): string {
  const byKey = COPY[language].priority as Record<string, string>;
  return byKey[priority] ?? priority;
}

function normalizeDocumentTitle(document: Pick<IssueDocument, "key" | "title">): string {
  return nonEmpty(document.title) ?? document.key;
}

function mapIssueDocuments(documents: Array<Pick<IssueDocument, "key" | "title" | "body">>, limit = 8): string[] {
  return documents
    .slice(0, limit)
    .map((document) => {
      const title = normalizeDocumentTitle(document);
      return `\`${document.key}\` (${title})`;
    });
}

export function normalizeTechnicalSpecLanguage(value: string | null | undefined): IssueTechnicalSpecLanguage {
  if (!value) return "en";
  const normalized = value.trim().toLowerCase();
  if (normalized === "pt-br" || normalized === "pt_br" || normalized === "pt") {
    return "pt-BR";
  }
  return "en";
}

export function buildIssueTechnicalSpecMarkdown(input: BuildIssueTechnicalSpecInput): string {
  const copy = COPY[input.language];
  const description = nonEmpty(input.issue.description);
  const summary = description ? truncate(description, 360) : copy.defaults.summary;
  const objective = description ? truncate(description, 420) : copy.defaults.objective;

  const labelNames = input.issue.labels.map((label) => label.name).filter(Boolean);
  const contextBullets: string[] = [
    `${copy.labels.issueStatus}: ${statusLabel(input.language, input.issue.status)}`,
    `${copy.labels.issuePriority}: ${priorityLabel(input.language, input.issue.priority)}`,
    `${copy.labels.issueLabels}: ${labelNames.length > 0 ? labelNames.join(", ") : copy.labels.none}`,
  ];

  if (input.project) {
    contextBullets.push(`${copy.labels.relatedProject}: ${input.project.name} (${input.project.id})`);
  }
  if (input.goal) {
    contextBullets.push(`${copy.labels.relatedGoal}: ${input.goal.title} (${input.goal.status})`);
  }
  if (input.workspace) {
    const workspaceLocation = input.workspace.cwd ? ` - ${input.workspace.cwd}` : "";
    contextBullets.push(`${copy.labels.currentWorkspace}: ${input.workspace.name}${workspaceLocation}`);
  }
  if (nonEmpty(input.projectContext)) {
    contextBullets.push(`${copy.labels.projectContextAvailable}: ${copy.labels.yes}`);
  }
  if (nonEmpty(input.planContext)) {
    contextBullets.push(`${copy.labels.planContextAvailable}: ${copy.labels.yes}`);
  }

  const projectContextSnippet = nonEmpty(input.projectContext)
    ? truncate(input.projectContext!, MAX_CONTEXT_SNIPPET_CHARS)
    : null;
  const planContextSnippet = nonEmpty(input.planContext)
    ? truncate(input.planContext!, MAX_CONTEXT_SNIPPET_CHARS)
    : null;

  const includedScope = inferScopeFromDescription(input.issue.description, 5);
  const acceptanceCriteria = takeBulletCandidates(input.issue.description, 6);

  const impactBullets: string[] = [];
  if (input.project) impactBullets.push(`${copy.labels.impactProject}: ${input.project.name}`);
  if (input.workspace) impactBullets.push(`${copy.labels.impactWorkspace}: ${input.workspace.name}`);
  if (input.goal) impactBullets.push(`${copy.labels.impactGoal}: ${input.goal.title}`);

  const documentRefs = mapIssueDocuments(
    input.documents.filter((document) => document.key !== "technical-spec"),
  );
  if (documentRefs.length > 0) {
    impactBullets.push(`${copy.labels.impactDocuments}: ${documentRefs.join(", ")}`);
  }

  const apiContractHints = bulletLines(
    linesFromDescription(input.issue.description).filter((line) => /api|endpoint|contract|event|webhook/i.test(line)),
  ).slice(0, 5);

  const dataModelHints = bulletLines(
    linesFromDescription(input.issue.description).filter((line) => /database|schema|table|column|model|entity|migration/i.test(line)),
  ).slice(0, 5);

  const body = [
    `# ${copy.title}`,
    "",
    `## ${copy.sectionTitle.summary}`,
    summary,
    "",
    `## ${copy.sectionTitle.context}`,
    formatBullets(contextBullets, copy.labels.unknown),
    projectContextSnippet ? `\n${copy.labels.projectContextHeading}:\n\n${projectContextSnippet}` : "",
    planContextSnippet ? `\n${copy.labels.planContextHeading}:\n\n${planContextSnippet}` : "",
    "",
    `## ${copy.sectionTitle.objective}`,
    objective,
    "",
    `## ${copy.sectionTitle.businessRules}`,
    formatBullets(copy.defaults.businessRules, copy.labels.notApplicable),
    "",
    `## ${copy.sectionTitle.inScope}`,
    formatBullets(includedScope.length > 0 ? includedScope : copy.defaults.inScope, copy.labels.notApplicable),
    "",
    `## ${copy.sectionTitle.outOfScope}`,
    formatBullets(copy.defaults.outOfScope, copy.labels.notApplicable),
    "",
    `## ${copy.sectionTitle.impacts}`,
    formatBullets(impactBullets.length > 0 ? impactBullets : [copy.labels.notApplicable], copy.labels.notApplicable),
    "",
    `## ${copy.sectionTitle.apiContracts}`,
    formatBullets(apiContractHints.length > 0 ? apiContractHints : copy.defaults.apiContracts, copy.labels.notApplicable),
    "",
    `## ${copy.sectionTitle.dataModel}`,
    formatBullets(dataModelHints.length > 0 ? dataModelHints : copy.defaults.dataModel, copy.labels.notApplicable),
    "",
    `## ${copy.sectionTitle.acceptanceCriteria}`,
    formatBullets(
      acceptanceCriteria.length > 0 ? acceptanceCriteria : copy.defaults.acceptanceCriteria,
      copy.labels.notApplicable,
    ),
    "",
    `## ${copy.sectionTitle.testPlan}`,
    formatBullets(copy.defaults.testPlan, copy.labels.notApplicable),
    "",
    `## ${copy.sectionTitle.risks}`,
    formatBullets(copy.defaults.risks, copy.labels.notApplicable),
    "",
    `## ${copy.sectionTitle.checklist}`,
    formatBullets(copy.defaults.checklist, copy.labels.notApplicable),
    "",
    `## ${copy.sectionTitle.subtasks}`,
    formatBullets(copy.defaults.subtasks, copy.labels.notApplicable),
  ]
    .filter((line) => line !== "")
    .join("\n");

  return `${body.trim()}\n`;
}
