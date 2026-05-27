import type { GoalStatus, IssuePriority, IssueStatus, ProjectStatus } from "@paperclipai/shared";
import type {
  BrabrixBacklogItem,
  BrabrixFeature,
  BrabrixPrd,
  BrabrixProject,
  BrabrixSkillReference,
  BrabrixSpec,
  ProjectContext,
} from "./brabrix-types.js";

export type BrabrixImportMetadata = {
  brabrixProjectId: string;
  brabrixImportedAt: string;
  brabrixLastSyncedAt: string;
  brabrixSourceUrl: string | null;
  brabrixEntityType: "project" | "feature" | "backlog_item" | "prd" | "spec" | "skill";
};

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function mapBrabrixProjectToProjectInput(input: {
  project: BrabrixProject;
  fallbackDescription?: string | null;
}): {
  name: string;
  description: string | null;
  status: ProjectStatus;
} {
  const status = (input.project.status ?? "").toLowerCase();
  const projectStatus: ProjectStatus =
    status === "active" || status === "in_progress"
      ? "in_progress"
      : status === "completed" || status === "done"
        ? "completed"
        : status === "cancelled" || status === "canceled"
          ? "cancelled"
          : status === "planned"
            ? "planned"
            : "backlog";

  return {
    name: input.project.name,
    description: input.project.description ?? input.fallbackDescription ?? null,
    status: projectStatus,
  };
}

export function mapBrabrixFeatureToGoal(input: {
  feature: BrabrixFeature;
}): {
  title: string;
  description: string | null;
  level: "team";
  status: GoalStatus;
} {
  const normalized = (input.feature.status ?? "").toLowerCase();
  const status: GoalStatus =
    normalized === "done" || normalized === "completed"
      ? "achieved"
      : normalized === "in_progress" || normalized === "active"
        ? "active"
        : normalized === "cancelled" || normalized === "canceled"
          ? "cancelled"
          : "planned";

  return {
    title: input.feature.title,
    description: input.feature.description ?? null,
    level: "team",
    status,
  };
}

export function mapBrabrixBacklogItemToIssue(input: {
  backlogItem: BrabrixBacklogItem;
}): {
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
} {
  const rawStatus = (input.backlogItem.status ?? "").toUpperCase();
  const rawPriority = (input.backlogItem.priority ?? "").toUpperCase();
  const status: IssueStatus =
    rawStatus === "DONE"
      ? "done"
      : rawStatus === "IN_PROGRESS"
        ? "in_progress"
        : rawStatus === "IN_REVIEW"
          ? "in_review"
          : rawStatus === "CANCELED" || rawStatus === "CANCELLED"
            ? "cancelled"
            : rawStatus === "TODO" || rawStatus === "READY"
              ? "todo"
              : "backlog";
  const priority: IssuePriority =
    rawPriority === "URGENT"
      ? "critical"
      : rawPriority === "HIGH"
        ? "high"
        : rawPriority === "LOW"
          ? "low"
          : "medium";

  const acceptanceCriteria = input.backlogItem.acceptanceCriteria;
  const descriptionWithCriteria = (() => {
    if (!acceptanceCriteria || acceptanceCriteria.length === 0) return input.backlogItem.description ?? null;
    const criteria = acceptanceCriteria.map((entry) => `- ${entry}`).join("\n");
    const existing = normalizeString(input.backlogItem.description);
    if (!existing) return `Acceptance criteria:\n${criteria}`;
    return `${existing}\n\nAcceptance criteria:\n${criteria}`;
  })();

  return {
    title: input.backlogItem.title,
    description: descriptionWithCriteria,
    status,
    priority,
  };
}

export function mapBrabrixPrdToProjectContext(input: {
  projectId: string;
  projectName: string;
  prd: BrabrixPrd | null;
  projectContext: ProjectContext | null;
}): ProjectContext | null {
  if (!input.prd && !input.projectContext) return null;
  const existing = input.projectContext;
  const prdContent = input.prd?.content ?? null;

  return {
    projectId: existing?.projectId ?? input.projectId,
    name: existing?.name ?? input.projectName,
    description: prdContent ?? existing?.description ?? null,
    skills: existing?.skills ?? [],
    providers: existing?.providers,
    defaultProvider: existing?.defaultProvider ?? null,
    metadata: {
      ...(existing?.metadata ?? {}),
      brabrixPrdTitle: input.prd?.title ?? null,
      brabrixPrdStatus: input.prd?.status ?? null,
    },
  };
}

export function mapBrabrixSpecToTechnicalContext(input: {
  specs: BrabrixSpec[];
}): {
  combinedMarkdown: string;
  specCount: number;
} {
  const sections = input.specs
    .filter((spec) => normalizeString(spec.content))
    .map((spec) => {
      const heading = spec.title || spec.type || "Specification";
      return `## ${heading}\n\n${spec.content?.trim() ?? ""}`;
    });

  return {
    combinedMarkdown: sections.join("\n\n"),
    specCount: input.specs.length,
  };
}

export function mapBrabrixSkillReferenceToSkill(input: {
  projectId: string;
  skill: BrabrixSkillReference;
}): {
  name: string;
  slug: string;
  description: string | null;
  markdown: string | null;
  sourceUrl: string | null;
} {
  const baseName = normalizeString(input.skill.name) ?? normalizeString(input.skill.key) ?? "Brabrix Skill";
  const slugSource = `${input.projectId}-${input.skill.skillId ?? input.skill.key ?? baseName}`;
  const slug = slugSource
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "brabrix-skill";
  const description = normalizeString(input.skill.description);
  const markdown = normalizeString(input.skill.markdown);

  return {
    name: baseName,
    slug,
    description: description ?? null,
    markdown: markdown ?? null,
    sourceUrl: normalizeString(input.skill.sourceUrl),
  };
}

