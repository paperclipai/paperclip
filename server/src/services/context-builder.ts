import type {
  BrabrixAgentProfile,
  BrabrixAgentProfileKey,
  BrabrixTask,
  ProjectContext,
  SkillContext,
} from "../integrations/brabrix/brabrix-types.js";

const FRONTEND_HINTS = [
  "frontend",
  "front-end",
  "ui",
  "ux",
  "react",
  "css",
  "html",
  "layout",
  "component",
  "web",
];

const QA_HINTS = [
  "qa",
  "quality",
  "teste",
  "test",
  "testing",
  "e2e",
  "regression",
  "bug",
  "validacao",
  "validação",
];

const CONTEXT_STRING_KEYS = {
  prd: ["prd", "productRequirementDocument", "productRequirements"],
  technicalSpec: ["technicalSpec", "techSpec", "spec", "technicalSpecification"],
} as const;

const CONTEXT_LIST_KEYS = {
  stack: ["stack", "techStack"],
  projectRules: ["projectRules", "rules"],
  acceptanceCriteria: ["acceptanceCriteria", "acceptance_criteria"],
} as const;

export interface BrabrixAgentContextSection {
  key:
    | "task"
    | "prd"
    | "technical_spec"
    | "skills"
    | "stack"
    | "project_rules"
    | "acceptance_criteria";
  title: string;
  content: string;
  estimatedChars: number;
}

export interface BrabrixAgentContextBundle {
  profile: BrabrixAgentProfile;
  sections: BrabrixAgentContextSection[];
  prompt: string;
  skillsApplied: string[];
  estimatedChars: number;
  estimatedTokens: number;
}

export interface BuildBrabrixAgentContextInput {
  task: BrabrixTask;
  projectContext?: ProjectContext | null;
  profileKey?: BrabrixAgentProfileKey | null;
}

export const BRABRIX_AGENT_PROFILES: Record<BrabrixAgentProfileKey, BrabrixAgentProfile> = {
  backend: {
    key: "backend",
    role: "Backend Agent",
    objective: "Implementar APIs, regras de negocio, persistencia e integracoes de forma segura e testavel.",
    allowedTools: ["read", "write", "edit", "search", "bash", "test", "http"],
    preferredModel: "gpt-5.4",
  },
  frontend: {
    key: "frontend",
    role: "Frontend Agent",
    objective: "Implementar experiencia de interface, componentes e fluxos de UI com foco em qualidade visual e acessibilidade.",
    allowedTools: ["read", "write", "edit", "search", "bash", "test", "browser"],
    preferredModel: "gpt-5.4",
  },
  qa: {
    key: "qa",
    role: "QA Agent",
    objective: "Validar comportamento funcional e regressao, com foco em criterios de aceite, riscos e confiabilidade.",
    allowedTools: ["read", "write", "edit", "search", "bash", "test"],
    preferredModel: "gpt-5.4-mini",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asNonEmptyString(entry))
    .filter((entry): entry is string => entry !== null);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function getFirstString(record: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = asNonEmptyString(record[key]);
    if (value) return value;
  }
  return null;
}

function getFirstStringList(record: Record<string, unknown> | null, keys: readonly string[]): string[] {
  if (!record) return [];
  for (const key of keys) {
    const values = toStringList(record[key]);
    if (values.length > 0) return values;
  }
  return [];
}

function normalizeProfileHint(value: string | null | undefined): BrabrixAgentProfileKey | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "backend") return "backend";
  if (normalized === "frontend" || normalized === "front-end" || normalized === "ui") return "frontend";
  if (normalized === "qa" || normalized === "quality" || normalized === "tester") return "qa";
  return null;
}

function collectTaskKeywordContext(task: BrabrixTask): string {
  const skillSummary = (task.skillContext ?? [])
    .flatMap((skill) => [skill.skillKey, skill.name, skill.provider])
    .filter((value): value is string => typeof value === "string");
  return [
    task.title,
    task.description ?? "",
    task.agentTypeHint ?? "",
    ...skillSummary,
  ]
    .join(" ")
    .toLowerCase();
}

function hasAnyKeyword(haystack: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => haystack.includes(keyword));
}

function mergeSkillContexts(
  taskSkills: SkillContext[] | undefined,
  projectSkills: SkillContext[] | undefined,
): SkillContext[] {
  const byKey = new Map<string, SkillContext>();
  for (const entry of [...(taskSkills ?? []), ...(projectSkills ?? [])]) {
    if (!entry?.skillKey) continue;
    if (!byKey.has(entry.skillKey)) byKey.set(entry.skillKey, entry);
  }
  return Array.from(byKey.values());
}

function formatList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function createSection(
  key: BrabrixAgentContextSection["key"],
  title: string,
  content: string | null | undefined,
): BrabrixAgentContextSection | null {
  const normalized = content?.trim();
  if (!normalized) return null;
  return {
    key,
    title,
    content: normalized,
    estimatedChars: normalized.length,
  };
}

export function resolveBrabrixAgentProfile(profileKey: BrabrixAgentProfileKey): BrabrixAgentProfile {
  return BRABRIX_AGENT_PROFILES[profileKey];
}

export function inferBrabrixAgentProfileKey(input: {
  task: BrabrixTask;
  profileKey?: BrabrixAgentProfileKey | null;
}): BrabrixAgentProfileKey {
  if (input.profileKey) return input.profileKey;
  const explicitHint = normalizeProfileHint(input.task.agentTypeHint);
  if (explicitHint) return explicitHint;

  const haystack = collectTaskKeywordContext(input.task);
  if (hasAnyKeyword(haystack, QA_HINTS)) return "qa";
  if (hasAnyKeyword(haystack, FRONTEND_HINTS)) return "frontend";
  return "backend";
}

function resolveContextString(
  projectMetadata: Record<string, unknown> | null,
  keys: readonly string[],
  directValue: string | null | undefined,
): string | null {
  return asNonEmptyString(directValue) ?? getFirstString(projectMetadata, keys);
}

function resolveContextList(
  taskValues: string[] | undefined,
  projectMetadata: Record<string, unknown> | null,
  keys: readonly string[],
): string[] {
  return uniqueStrings([...(taskValues ?? []), ...getFirstStringList(projectMetadata, keys)]);
}

export function buildBrabrixAgentContext(input: BuildBrabrixAgentContextInput): BrabrixAgentContextBundle {
  const profileKey = inferBrabrixAgentProfileKey({
    task: input.task,
    profileKey: input.profileKey ?? null,
  });
  const profile = resolveBrabrixAgentProfile(profileKey);

  const projectMetadata = isRecord(input.projectContext?.metadata) ? input.projectContext.metadata : null;
  const taskSkills = mergeSkillContexts(input.task.skillContext, input.projectContext?.skills);
  const skillsApplied = taskSkills.map((skill) => skill.skillKey);

  const prd = resolveContextString(
    projectMetadata,
    CONTEXT_STRING_KEYS.prd,
    input.task.prd,
  );
  const technicalSpec = resolveContextString(
    projectMetadata,
    CONTEXT_STRING_KEYS.technicalSpec,
    input.task.technicalSpec,
  );
  const stack = resolveContextList(input.task.stack, projectMetadata, CONTEXT_LIST_KEYS.stack);
  const projectRules = resolveContextList(input.task.projectRules, projectMetadata, CONTEXT_LIST_KEYS.projectRules);
  const acceptanceCriteria = resolveContextList(
    input.task.acceptanceCriteria,
    projectMetadata,
    CONTEXT_LIST_KEYS.acceptanceCriteria,
  );

  const sections = [
    createSection(
      "task",
      "Task Objective",
      [
        `Title: ${input.task.title}`,
        input.task.description ? `Description: ${input.task.description}` : null,
        `Agent Role: ${profile.role}`,
        `Agent Objective: ${profile.objective}`,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    ),
    createSection("prd", "PRD", prd),
    createSection("technical_spec", "Technical Spec", technicalSpec),
    createSection(
      "skills",
      "Skills",
      taskSkills.length > 0
        ? formatList(taskSkills.map((skill) => `${skill.name} (${skill.skillKey})`))
        : null,
    ),
    createSection("stack", "Stack", stack.length > 0 ? formatList(stack) : null),
    createSection("project_rules", "Project Rules", projectRules.length > 0 ? formatList(projectRules) : null),
    createSection(
      "acceptance_criteria",
      "Acceptance Criteria",
      acceptanceCriteria.length > 0 ? formatList(acceptanceCriteria) : null,
    ),
  ].filter((entry): entry is BrabrixAgentContextSection => entry !== null);

  const promptHeader = [
    `# Brabrix Task Context`,
    `Task ID: ${input.task.taskId}`,
    `Profile: ${profile.role}`,
    `Preferred Model: ${profile.preferredModel}`,
    `Allowed Tools: ${profile.allowedTools.join(", ")}`,
  ].join("\n");

  const promptBody = sections
    .map((section) => `## ${section.title}\n${section.content}`)
    .join("\n\n");
  const prompt = `${promptHeader}\n\n${promptBody}`.trim();
  const estimatedChars = prompt.length;
  const estimatedTokens = Math.max(1, Math.ceil(estimatedChars / 4));

  return {
    profile,
    sections,
    prompt,
    skillsApplied,
    estimatedChars,
    estimatedTokens,
  };
}
