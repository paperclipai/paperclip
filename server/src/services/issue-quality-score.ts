import type { IssueDocument } from "@paperclipai/shared";

export type IssueQualityLanguage = "en" | "pt-BR";
export type IssueQualityRating = "excellent" | "good" | "regular" | "weak" | "critical";
export type IssueQualityAmbiguityRiskLevel = "low" | "medium" | "high";

export interface IssueQualityIssueContext {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  labels: Array<{ name: string }>;
}

export interface IssueQualityProjectContext {
  id: string;
  name: string;
  description: string | null;
}

export interface IssueQualityGoalContext {
  id: string;
  title: string;
  description: string | null;
  status: string;
}

export interface IssueQualityWorkspaceContext {
  id: string;
  name: string;
  cwd: string | null;
}

export interface IssueQualitySubtaskContext {
  id: string;
  title: string;
  status: string;
  priority: string;
}

export interface BuildIssueQualityScoreInput {
  language: IssueQualityLanguage;
  issue: IssueQualityIssueContext;
  project: IssueQualityProjectContext | null;
  goal: IssueQualityGoalContext | null;
  workspace: IssueQualityWorkspaceContext | null;
  planContext: string | null;
  projectContext: string | null;
  technicalSpec: string | null;
  projectRules: string[];
  skills: string[];
  subtasks: IssueQualitySubtaskContext[];
  documents: Array<Pick<IssueDocument, "key" | "title" | "body">>;
  model?: string;
  generatedAt?: Date;
}

export interface IssueQualityScore {
  id: string;
  issueId: string;
  overallScore: number;
  rating: IssueQualityRating;
  clarityScore: number;
  problemContextScore: number;
  acceptanceCriteriaScore: number;
  businessRulesScore: number;
  technicalContextScore: number;
  testabilityScore: number;
  scopeScore: number;
  ambiguityRiskScore: number;
  ambiguityRiskLevel: IssueQualityAmbiguityRiskLevel;
  strengths: string[];
  problems: string[];
  suggestions: string[];
  missingFields: string[];
  recommendation: string;
  language: IssueQualityLanguage;
  generatedBy: "agent";
  model?: string;
  promptBlueprint: string;
  analysisMode: "heuristic_v1";
  createdAt: string;
  updatedAt: string;
}

const MAX_CONTEXT_SCAN_CHARS = 8_000;

const WEIGHTS = {
  clarity: 0.2,
  acceptanceCriteria: 0.2,
  technicalContext: 0.15,
  businessRules: 0.15,
  testability: 0.1,
  scope: 0.1,
  problemContext: 0.05,
  ambiguity: 0.05,
} as const;

const EN_COPY = {
  sectionTitle: "Issue Quality Analysis",
  labels: {
    issue: "Issue",
    overall: "Overall score",
    rating: "Classification",
    ambiguity: "Ambiguity risk",
    low: "Low",
    medium: "Medium",
    high: "High",
    criteria: "Criteria scores",
    strengths: "Strengths",
    problems: "Problems found",
    suggestions: "Suggestions",
    missing: "Missing or incomplete fields",
    recommendation: "Final recommendation",
  },
  ratings: {
    excellent: "Excellent",
    good: "Good",
    regular: "Regular",
    weak: "Weak",
    critical: "Critical",
  },
  criteria: {
    clarity: "Description clarity",
    problemContext: "Problem context",
    acceptanceCriteria: "Acceptance criteria",
    businessRules: "Business rules",
    technicalContext: "Technical context",
    testability: "Testability",
    scope: "Defined scope",
    ambiguity: "Ambiguity risk (inverse)",
  },
  strengths: {
    clarity: "The issue has clear intent and enough detail to start implementation.",
    problemContext: "The problem context is understandable and linked to a goal/project.",
    acceptanceCriteria: "Acceptance criteria are explicit and measurable.",
    businessRules: "Business behavior expectations are present and actionable.",
    technicalContext: "Technical context exists (spec, project context, impacted areas).",
    testability: "The issue includes strong testing and validation signals.",
    scope: "Scope appears bounded enough for predictable delivery.",
    ambiguity: "Ambiguity risk is low based on the available context.",
  },
  problems: {
    clarity: "The description is too short or too vague.",
    problemContext: "Problem context is weak or disconnected from project goals.",
    acceptanceCriteria: "Acceptance criteria are missing or not objective.",
    businessRules: "Business rules are unclear or absent.",
    technicalContext: "Technical context is insufficient for safe implementation.",
    testability: "Testing expectations are weak or missing.",
    scope: "Scope boundaries are unclear, increasing rework risk.",
    ambiguity: "High ambiguity risk was detected in the current issue context.",
  },
  suggestions: {
    clarity: "Rewrite the description with concrete steps, expected behavior, and target outcome.",
    problemContext: "Add why this issue exists and how it impacts project or user outcomes.",
    acceptanceCriteria: "Add objective acceptance criteria (for example: given/when/then or measurable checks).",
    businessRules: "List business rules, constraints, and edge-case behavior explicitly.",
    technicalContext: "Include impacted files/components/APIs and attach or generate a technical spec.",
    testability: "Define validation scenarios, expected errors, and minimum test coverage.",
    scope: "Clarify included vs out-of-scope work to reduce ambiguity and churn.",
    ambiguity: "Break the issue into smaller subtasks and resolve open questions before execution.",
  },
  missing: {
    description: "Issue description",
    labels: "Issue labels/tags",
    goal: "Related goal",
    project: "Related project",
    technicalSpec: "Technical spec",
    acceptanceCriteria: "Acceptance criteria",
    businessRules: "Business rules",
    testPlan: "Test plan",
    scope: "Included/out-of-scope boundaries",
  },
  recommendation: {
    excellent: "Ready for execution. Keep this level of detail for implementation handoff.",
    good: "Ready with minor improvements. Address the suggestions for a smoother delivery.",
    regular: "Usable, but should be improved before execution to reduce risk.",
    weak: "Needs refinement before implementation. Strengthen context and acceptance criteria.",
    critical: "Do not execute yet. Rework description, scope, and technical/testing context first.",
  },
};

const PT_BR_COPY = {
  sectionTitle: "Análise de Qualidade da Issue",
  labels: {
    issue: "Issue",
    overall: "Score geral",
    rating: "Classificação",
    ambiguity: "Risco de ambiguidade",
    low: "Baixo",
    medium: "Médio",
    high: "Alto",
    criteria: "Scores por critério",
    strengths: "Pontos fortes",
    problems: "Problemas encontrados",
    suggestions: "Sugestões",
    missing: "Campos ausentes ou incompletos",
    recommendation: "Recomendação final",
  },
  ratings: {
    excellent: "Excelente",
    good: "Boa",
    regular: "Regular",
    weak: "Fraca",
    critical: "Crítica",
  },
  criteria: {
    clarity: "Clareza da descrição",
    problemContext: "Contexto do problema",
    acceptanceCriteria: "Critérios de aceite",
    businessRules: "Regras de negócio",
    technicalContext: "Contexto técnico",
    testability: "Testabilidade",
    scope: "Escopo definido",
    ambiguity: "Risco de ambiguidade (inverso)",
  },
  strengths: {
    clarity: "A issue possui intenção clara e detalhe suficiente para iniciar a implementação.",
    problemContext: "O contexto do problema está compreensível e ligado ao objetivo/projeto.",
    acceptanceCriteria: "Os critérios de aceite estão explícitos e mensuráveis.",
    businessRules: "As expectativas de comportamento de negócio estão presentes e acionáveis.",
    technicalContext: "Existe contexto técnico (spec, contexto de projeto, áreas impactadas).",
    testability: "A issue contém bons sinais de validação e testes.",
    scope: "O escopo parece delimitado para uma entrega previsível.",
    ambiguity: "O risco de ambiguidade está baixo com base no contexto disponível.",
  },
  problems: {
    clarity: "A descrição está curta demais ou vaga.",
    problemContext: "O contexto do problema está fraco ou desconectado dos objetivos do projeto.",
    acceptanceCriteria: "Faltam critérios de aceite objetivos.",
    businessRules: "As regras de negócio estão ausentes ou pouco claras.",
    technicalContext: "O contexto técnico é insuficiente para implementação segura.",
    testability: "As expectativas de teste estão fracas ou ausentes.",
    scope: "Os limites de escopo estão indefinidos, aumentando risco de retrabalho.",
    ambiguity: "Foi detectado alto risco de ambiguidade no contexto atual da issue.",
  },
  suggestions: {
    clarity: "Reescreva a descrição com passos concretos, comportamento esperado e resultado alvo.",
    problemContext: "Inclua por que essa issue existe e qual impacto esperado no projeto/usuário.",
    acceptanceCriteria: "Adicione critérios de aceite objetivos (exemplo: dado/quando/então ou checks mensuráveis).",
    businessRules: "Liste regras de negócio, restrições e comportamento em casos de borda.",
    technicalContext: "Informe arquivos/componentes/APIs impactados e anexe ou gere uma spec técnica.",
    testability: "Defina cenários de validação, erros esperados e cobertura mínima de testes.",
    scope: "Deixe claro o que entra e o que fica fora de escopo para reduzir ambiguidade.",
    ambiguity: "Quebre a issue em subtasks menores e resolva perguntas em aberto antes da execução.",
  },
  missing: {
    description: "Descrição da issue",
    labels: "Labels/tags da issue",
    goal: "Objetivo relacionado",
    project: "Projeto relacionado",
    technicalSpec: "Spec técnica",
    acceptanceCriteria: "Critérios de aceite",
    businessRules: "Regras de negócio",
    testPlan: "Plano de testes",
    scope: "Limites de escopo (incluído/fora de escopo)",
  },
  recommendation: {
    excellent: "Pronta para execução. Mantenha esse nível de detalhe no handoff para implementação.",
    good: "Pronta com pequenos ajustes. Enderece as sugestões para uma entrega mais fluida.",
    regular: "Executável, porém deve ser melhorada antes para reduzir risco.",
    weak: "Precisa de refinamento antes da implementação. Fortaleça contexto e critérios de aceite.",
    critical: "Não executar ainda. Reestruture descrição, escopo e contexto técnico/testes primeiro.",
  },
};

function getCopy(language: IssueQualityLanguage) {
  return language === "pt-BR" ? PT_BR_COPY : EN_COPY;
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeForSearch(value: string | null | undefined): string {
  if (!value) return "";
  return value.trim().toLowerCase();
}

function countWords(value: string | null | undefined): number {
  if (!hasText(value)) return 0;
  return value.trim().split(/\s+/).filter((token) => token.length > 0).length;
}

function truncateForScan(value: string | null | undefined): string {
  if (!hasText(value)) return "";
  if (value.length <= MAX_CONTEXT_SCAN_CHARS) return value;
  return value.slice(0, MAX_CONTEXT_SCAN_CHARS);
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function computeRating(overallScore: number): IssueQualityRating {
  if (overallScore >= 90) return "excellent";
  if (overallScore >= 75) return "good";
  if (overallScore >= 60) return "regular";
  if (overallScore >= 40) return "weak";
  return "critical";
}

function dedupeLines(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function formatIssueReference(input: {
  id: string;
  identifier: string | null;
  title: string;
}): string {
  return input.identifier ? `${input.identifier} - ${input.title}` : `${input.title} (${input.id})`;
}

function stringifyJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function buildTechnicalSignals(input: BuildIssueQualityScoreInput) {
  const issueText = normalizeForSearch(`${input.issue.title}\n${input.issue.description ?? ""}`);
  const specText = normalizeForSearch(input.technicalSpec);
  const projectText = normalizeForSearch(input.projectContext ?? input.project?.description ?? null);
  const planText = normalizeForSearch(input.planContext);
  const documentsText = normalizeForSearch(
    input.documents
      .map((document) => `${document.key} ${document.title ?? ""} ${truncateForScan(document.body)}`)
      .join("\n"),
  );

  const allContext = [issueText, specText, projectText, planText, documentsText]
    .filter((value) => value.length > 0)
    .join("\n");

  const keywords = {
    acceptance: ["acceptance criteria", "criteria", "critério", "criterio", "given", "when", "then", "deve", "must"],
    business: ["business rule", "regra", "policy", "compliance", "constraint", "restri", "if", "when", "quando"],
    technical: ["api", "endpoint", "schema", "database", "migration", "component", "frontend", "backend", "service", "repository"],
    testing: ["test", "qa", "e2e", "integration", "unit", "cenario", "cenário", "validation", "validação"],
    scope: ["out of scope", "fora de escopo", "in scope", "escopo", "only", "apenas", "não inclui", "nao inclui"],
    context: ["because", "motivation", "problem", "context", "impact", "por que", "porque", "motiva", "problema"],
    ambiguity: ["maybe", "perhaps", "asap", "todo", "tbd", "to define", "algum", "depois", "avaliar"],
  } as const;

  return {
    issueText,
    specText,
    projectText,
    planText,
    documentsText,
    allContext,
    keywords,
  };
}

function computeClarityScore(input: BuildIssueQualityScoreInput): number {
  let score = 40;
  const titleWords = countWords(input.issue.title);
  const descriptionWords = countWords(input.issue.description);
  const description = input.issue.description ?? "";

  if (titleWords >= 4) score += 8;
  if (titleWords >= 8) score += 5;
  if (descriptionWords >= 30) score += 15;
  if (descriptionWords >= 80) score += 10;
  if (/\n\s*[-*]|\n\s*\d+\./.test(description)) score += 10;
  if (/[:.;]/.test(description)) score += 6;
  if (descriptionWords < 12) score -= 15;
  if (!hasText(input.issue.description)) score -= 30;

  return clampScore(score);
}

function computeProblemContextScore(input: BuildIssueQualityScoreInput, signals: ReturnType<typeof buildTechnicalSignals>): number {
  let score = 30;

  if (includesAny(signals.allContext, signals.keywords.context)) score += 20;
  if (input.project || input.goal) score += 18;
  if (hasText(input.projectContext) || hasText(input.project?.description)) score += 15;
  if (hasText(input.planContext)) score += 10;
  if (input.issue.labels.length > 0) score += 7;

  return clampScore(score);
}

function computeAcceptanceCriteriaScore(
  input: BuildIssueQualityScoreInput,
  signals: ReturnType<typeof buildTechnicalSignals>,
): number {
  let score = 18;
  if (includesAny(signals.allContext, signals.keywords.acceptance)) score += 32;
  if (hasText(input.technicalSpec)) score += 20;
  if (hasText(input.planContext)) score += 12;
  if (input.subtasks.length > 0) score += 8;

  return clampScore(score);
}

function computeBusinessRulesScore(
  input: BuildIssueQualityScoreInput,
  signals: ReturnType<typeof buildTechnicalSignals>,
): number {
  let score = 22;
  if (includesAny(signals.allContext, signals.keywords.business)) score += 30;
  if (input.projectRules.length > 0) score += 22;
  if (hasText(input.goal?.description)) score += 8;

  return clampScore(score);
}

function computeTechnicalContextScore(
  input: BuildIssueQualityScoreInput,
  signals: ReturnType<typeof buildTechnicalSignals>,
): number {
  let score = 20;

  if (includesAny(signals.allContext, signals.keywords.technical)) score += 25;
  if (hasText(input.technicalSpec)) score += 26;
  if (hasText(input.projectContext) || hasText(input.project?.description)) score += 12;
  if (input.workspace) score += 7;
  if (input.skills.length > 0) score += 10;

  return clampScore(score);
}

function computeTestabilityScore(
  input: BuildIssueQualityScoreInput,
  signals: ReturnType<typeof buildTechnicalSignals>,
): number {
  let score = 22;

  if (includesAny(signals.allContext, signals.keywords.testing)) score += 38;
  if (hasText(input.technicalSpec)) score += 15;
  if (input.subtasks.length > 0) score += 8;

  return clampScore(score);
}

function computeScopeScore(
  input: BuildIssueQualityScoreInput,
  signals: ReturnType<typeof buildTechnicalSignals>,
): number {
  let score = 28;

  if (includesAny(signals.allContext, signals.keywords.scope)) score += 24;
  if (input.subtasks.length > 0 && input.subtasks.length <= 8) score += 12;
  if (input.subtasks.length > 8) score -= 6;
  if (countWords(input.issue.description) > 220) score -= 5;
  if (!hasText(input.issue.description)) score -= 18;

  return clampScore(score);
}

function computeAmbiguityRisk(input: {
  clarityScore: number;
  acceptanceCriteriaScore: number;
  scopeScore: number;
  problemContextScore: number;
  technicalContextScore: number;
  signals: ReturnType<typeof buildTechnicalSignals>;
}) {
  let risk = 70;

  risk -= Math.round(input.clarityScore * 0.18);
  risk -= Math.round(input.acceptanceCriteriaScore * 0.22);
  risk -= Math.round(input.scopeScore * 0.14);
  risk -= Math.round(input.problemContextScore * 0.1);
  risk -= Math.round(input.technicalContextScore * 0.12);

  if (includesAny(input.signals.allContext, input.signals.keywords.ambiguity)) {
    risk += 14;
  }

  const normalizedRisk = clampScore(risk);
  const ambiguityRiskScore = clampScore(100 - normalizedRisk);
  const ambiguityRiskLevel: IssueQualityAmbiguityRiskLevel = normalizedRisk <= 35
    ? "low"
    : normalizedRisk <= 65
      ? "medium"
      : "high";

  return {
    ambiguityRiskScore,
    ambiguityRiskLevel,
  };
}

function buildMissingFields(input: BuildIssueQualityScoreInput, signals: ReturnType<typeof buildTechnicalSignals>) {
  const missingKeys: Array<keyof typeof EN_COPY.missing> = [];
  if (!hasText(input.issue.description)) missingKeys.push("description");
  if (input.issue.labels.length === 0) missingKeys.push("labels");
  if (!input.goal) missingKeys.push("goal");
  if (!input.project) missingKeys.push("project");
  if (!hasText(input.technicalSpec)) missingKeys.push("technicalSpec");
  if (!includesAny(signals.allContext, signals.keywords.acceptance)) missingKeys.push("acceptanceCriteria");
  if (!includesAny(signals.allContext, signals.keywords.business) && input.projectRules.length === 0) {
    missingKeys.push("businessRules");
  }
  if (!includesAny(signals.allContext, signals.keywords.testing)) missingKeys.push("testPlan");
  if (!includesAny(signals.allContext, signals.keywords.scope)) missingKeys.push("scope");

  return missingKeys;
}

export function buildIssueQualityPromptBlueprint(input: BuildIssueQualityScoreInput): string {
  const compactContext = {
    issue: {
      id: input.issue.id,
      identifier: input.issue.identifier,
      title: input.issue.title,
      description: truncateForScan(input.issue.description),
      status: input.issue.status,
      priority: input.issue.priority,
      labels: input.issue.labels.map((label) => label.name),
    },
    project: input.project,
    goal: input.goal,
    workspace: input.workspace,
    hasTechnicalSpec: hasText(input.technicalSpec),
    subtaskCount: input.subtasks.length,
    documentKeys: input.documents.map((document) => document.key),
    language: input.language,
  };

  return [
    "You are an issue quality analyzer for execution readiness.",
    "Evaluate only with provided data and never invent missing information.",
    "Return strict JSON with scores from 0 to 100 and practical improvement suggestions.",
    "Criteria: clarity, problemContext, acceptanceCriteria, businessRules, technicalContext, testability, scope, ambiguityRisk.",
    "Ambiguity risk is inverse for quality (lower risk means higher ambiguityRiskScore).",
    "Language must match requested locale.",
    "JSON shape:",
    "{ overallScore, rating, clarityScore, problemContextScore, acceptanceCriteriaScore, businessRulesScore, technicalContextScore, testabilityScore, scopeScore, ambiguityRiskScore, ambiguityRiskLevel, strengths[], problems[], suggestions[], missingFields[], recommendation }",
    "Context:",
    stringifyJson(compactContext),
  ].join("\n");
}

export function normalizeIssueQualityLanguage(value: string | null | undefined): IssueQualityLanguage {
  if (!value) return "en";
  const normalized = value.trim().toLowerCase();
  if (normalized === "pt" || normalized.startsWith("pt-")) return "pt-BR";
  return "en";
}

export function buildIssueQualityScore(input: BuildIssueQualityScoreInput): IssueQualityScore {
  const generatedAt = input.generatedAt ?? new Date();
  const generatedAtIso = generatedAt.toISOString();
  const copy = getCopy(input.language);

  const signals = buildTechnicalSignals(input);
  const clarityScore = computeClarityScore(input);
  const problemContextScore = computeProblemContextScore(input, signals);
  const acceptanceCriteriaScore = computeAcceptanceCriteriaScore(input, signals);
  const businessRulesScore = computeBusinessRulesScore(input, signals);
  const technicalContextScore = computeTechnicalContextScore(input, signals);
  const testabilityScore = computeTestabilityScore(input, signals);
  const scopeScore = computeScopeScore(input, signals);
  const { ambiguityRiskScore, ambiguityRiskLevel } = computeAmbiguityRisk({
    clarityScore,
    acceptanceCriteriaScore,
    scopeScore,
    problemContextScore,
    technicalContextScore,
    signals,
  });

  const overallScore = clampScore(
    clarityScore * WEIGHTS.clarity +
      acceptanceCriteriaScore * WEIGHTS.acceptanceCriteria +
      technicalContextScore * WEIGHTS.technicalContext +
      businessRulesScore * WEIGHTS.businessRules +
      testabilityScore * WEIGHTS.testability +
      scopeScore * WEIGHTS.scope +
      problemContextScore * WEIGHTS.problemContext +
      ambiguityRiskScore * WEIGHTS.ambiguity,
  );

  const rating = computeRating(overallScore);

  const strengths: string[] = [];
  if (clarityScore >= 80) strengths.push(copy.strengths.clarity);
  if (problemContextScore >= 80) strengths.push(copy.strengths.problemContext);
  if (acceptanceCriteriaScore >= 80) strengths.push(copy.strengths.acceptanceCriteria);
  if (businessRulesScore >= 80) strengths.push(copy.strengths.businessRules);
  if (technicalContextScore >= 80) strengths.push(copy.strengths.technicalContext);
  if (testabilityScore >= 80) strengths.push(copy.strengths.testability);
  if (scopeScore >= 80) strengths.push(copy.strengths.scope);
  if (ambiguityRiskLevel === "low") strengths.push(copy.strengths.ambiguity);

  const problems: string[] = [];
  if (clarityScore < 60) problems.push(copy.problems.clarity);
  if (problemContextScore < 60) problems.push(copy.problems.problemContext);
  if (acceptanceCriteriaScore < 60) problems.push(copy.problems.acceptanceCriteria);
  if (businessRulesScore < 60) problems.push(copy.problems.businessRules);
  if (technicalContextScore < 60) problems.push(copy.problems.technicalContext);
  if (testabilityScore < 60) problems.push(copy.problems.testability);
  if (scopeScore < 60) problems.push(copy.problems.scope);
  if (ambiguityRiskLevel === "high") problems.push(copy.problems.ambiguity);

  const suggestions: string[] = [];
  if (clarityScore < 75) suggestions.push(copy.suggestions.clarity);
  if (problemContextScore < 75) suggestions.push(copy.suggestions.problemContext);
  if (acceptanceCriteriaScore < 75) suggestions.push(copy.suggestions.acceptanceCriteria);
  if (businessRulesScore < 75) suggestions.push(copy.suggestions.businessRules);
  if (technicalContextScore < 75) suggestions.push(copy.suggestions.technicalContext);
  if (testabilityScore < 75) suggestions.push(copy.suggestions.testability);
  if (scopeScore < 75) suggestions.push(copy.suggestions.scope);
  if (ambiguityRiskLevel !== "low") suggestions.push(copy.suggestions.ambiguity);

  const missingFieldKeys = buildMissingFields(input, signals);
  const missingFields = dedupeLines(
    missingFieldKeys
      .map((key) => copy.missing[key])
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );

  return {
    id: `${input.issue.id}:${generatedAt.getTime()}`,
    issueId: input.issue.id,
    overallScore,
    rating,
    clarityScore,
    problemContextScore,
    acceptanceCriteriaScore,
    businessRulesScore,
    technicalContextScore,
    testabilityScore,
    scopeScore,
    ambiguityRiskScore,
    ambiguityRiskLevel,
    strengths: dedupeLines(strengths),
    problems: dedupeLines(problems),
    suggestions: dedupeLines(suggestions),
    missingFields,
    recommendation: copy.recommendation[rating],
    language: input.language,
    generatedBy: "agent",
    model: input.model,
    promptBlueprint: buildIssueQualityPromptBlueprint(input),
    analysisMode: "heuristic_v1",
    createdAt: generatedAtIso,
    updatedAt: generatedAtIso,
  };
}

export function buildIssueQualityScoreMarkdown(score: IssueQualityScore, issueRef: {
  id: string;
  identifier: string | null;
  title: string;
}): string {
  const copy = getCopy(score.language);
  const ratingLabel = copy.ratings[score.rating];
  const ambiguityLabel = score.ambiguityRiskLevel === "low"
    ? copy.labels.low
    : score.ambiguityRiskLevel === "medium"
      ? copy.labels.medium
      : copy.labels.high;

  const criteriaRows = [
    `${copy.criteria.clarity}: ${score.clarityScore}`,
    `${copy.criteria.problemContext}: ${score.problemContextScore}`,
    `${copy.criteria.acceptanceCriteria}: ${score.acceptanceCriteriaScore}`,
    `${copy.criteria.businessRules}: ${score.businessRulesScore}`,
    `${copy.criteria.technicalContext}: ${score.technicalContextScore}`,
    `${copy.criteria.testability}: ${score.testabilityScore}`,
    `${copy.criteria.scope}: ${score.scopeScore}`,
    `${copy.criteria.ambiguity}: ${score.ambiguityRiskScore}`,
  ];

  const bulletOrFallback = (items: string[]) => (items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- -");

  const serialized = stringifyJson(score);

  return [
    `# ${copy.sectionTitle}`,
    "",
    `- ${copy.labels.issue}: ${formatIssueReference(issueRef)}`,
    `- ${copy.labels.overall}: ${score.overallScore}/100`,
    `- ${copy.labels.rating}: ${ratingLabel}`,
    `- ${copy.labels.ambiguity}: ${ambiguityLabel} (${score.ambiguityRiskScore}/100)`,
    "",
    `## ${copy.labels.criteria}`,
    ...criteriaRows.map((row) => `- ${row}`),
    "",
    `## ${copy.labels.strengths}`,
    bulletOrFallback(score.strengths),
    "",
    `## ${copy.labels.problems}`,
    bulletOrFallback(score.problems),
    "",
    `## ${copy.labels.suggestions}`,
    bulletOrFallback(score.suggestions),
    "",
    `## ${copy.labels.missing}`,
    bulletOrFallback(score.missingFields),
    "",
    `## ${copy.labels.recommendation}`,
    score.recommendation,
    "",
    "<!-- issue-quality-score:v1 -->",
    "```json",
    serialized,
    "```",
  ].join("\n");
}
