import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { labels, projects } from "@paperclipai/db";import {
  projectAutomationPolicySchema,
  type IssueAutoLabelRule,
  type ProjectAutomationPolicy,
} from "@paperclipai/shared";

// Project automation rules, borrowed from Plane's per-project automations
// (auto-archive / auto-close): small declarative rules stored on the project
// that fire without operator input. This module covers the first rule kind —
// auto-label on issue creation. Matching is a case-insensitive substring
// over title plus description; stale label ids are skipped, never an error.

export function normalizeAutomationPolicy(value: unknown): ProjectAutomationPolicy | null {
  if (value === null || value === undefined) return null;
  const parsed = projectAutomationPolicySchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.autoLabelRules.length === 0) return null;
  return parsed.data;
}

/** Rules whose match text appears in the issue text, in rule order. */
export function matchAutoLabelRules(
  title: string,
  description: string | null | undefined,
  rules: ReadonlyArray<IssueAutoLabelRule>,
): IssueAutoLabelRule[] {
  const haystack = `${title}\n${description ?? ""}`.toLowerCase();
  return rules.filter((rule) => {
    const needle = rule.match.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

/**
 * Resolve the label ids a new issue earns from its project's automation
 * policy. Returns [] when the project has no usable rules. Stale label ids
 * (labels deleted since the rule was saved) are skipped silently so a
 * deleted label can never break issue creation.
 */
export async function resolveProjectAutoLabels(
  db: Pick<Db, "select">,
  input: { companyId: string; projectId: string | null; title: string; description?: string | null },
): Promise<string[]> {
  if (!input.projectId) return [];
  const rows = await db
    .select({ automationPolicy: projects.automationPolicy })
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.companyId, input.companyId)))
    .limit(1);
  const policy = normalizeAutomationPolicy(rows[0]?.automationPolicy ?? null);
  if (!policy) return [];
  const matched = matchAutoLabelRules(input.title, input.description, policy.autoLabelRules);
  if (matched.length === 0) return [];
  const labelRows = await db
    .select({ id: labels.id })
    .from(labels)
    .where(eq(labels.companyId, input.companyId));
  const valid = new Set(labelRows.map((row) => row.id));
  const resolved: string[] = [];
  for (const rule of matched) {
    if (valid.has(rule.labelId) && !resolved.includes(rule.labelId)) {
      resolved.push(rule.labelId);
    }
  }
  return resolved;
}
