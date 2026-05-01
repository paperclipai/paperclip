import type { CompanySkillListItem } from "@paperclipai/shared";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstString(source: Record<string, unknown> | null, ...keys: string[]) {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function normalizeGroupId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "uncategorized";
}

function humanize(value: string) {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export type CompanySkillGroup = {
  id: string;
  label: string;
  sortOrder: number;
  skills: CompanySkillListItem[];
};

export type ResolvedCompanySkillGroup = Omit<CompanySkillGroup, "skills">;

export function resolveCompanySkillGroup(skill: Pick<CompanySkillListItem, "key" | "sourceBadge" | "metadata">): ResolvedCompanySkillGroup {
  const metadata = asRecord(skill.metadata);
  const paperclipMeta = asRecord(metadata?.paperclip);
  const explicitCategory = firstString(
    metadata,
    "category",
    "group",
    "folder",
  ) ?? firstString(paperclipMeta, "category", "group");

  if (explicitCategory) {
    return {
      id: `category:${normalizeGroupId(explicitCategory)}`,
      label: humanize(explicitCategory),
      sortOrder: 0,
    };
  }

  const keySegments = skill.key.split("/").filter(Boolean);
  if (keySegments.length > 1) {
    const namespace = humanize(keySegments[0] ?? "");
    return {
      id: `namespace:${normalizeGroupId(keySegments[0] ?? "")}`,
      label: `${namespace} skills`,
      sortOrder: 1,
    };
  }

  switch (skill.sourceBadge) {
    case "paperclip":
      return { id: "source:paperclip", label: "Paperclip skills", sortOrder: 2 };
    case "skills_sh":
      return { id: "source:skills-sh", label: "skills.sh imports", sortOrder: 2 };
    case "github":
      return { id: "source:github", label: "GitHub imports", sortOrder: 2 };
    case "local":
      return { id: "source:local", label: "Local skills", sortOrder: 2 };
    case "url":
      return { id: "source:url", label: "URL imports", sortOrder: 2 };
    default:
      return { id: "source:other", label: "Other skills", sortOrder: 3 };
  }
}

export function groupResolvedCompanySkills(
  skills: readonly { skill: CompanySkillListItem; group: ResolvedCompanySkillGroup }[],
) {
  const groups = new Map<string, CompanySkillGroup>();

  for (const entry of skills) {
    const { skill, group } = entry;
    const existing = groups.get(group.id);
    if (existing) {
      existing.skills.push(skill);
      continue;
    }
    groups.set(group.id, {
      ...group,
      skills: [skill],
    });
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      skills: [...group.skills].sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
      return left.label.localeCompare(right.label);
    });
}

export function groupCompanySkills(skills: readonly CompanySkillListItem[]) {
  return groupResolvedCompanySkills(
    skills.map((skill) => ({
      skill,
      group: resolveCompanySkillGroup(skill),
    })),
  );
}
