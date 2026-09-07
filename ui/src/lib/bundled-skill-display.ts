import { i18n, t } from "@/i18n";
import { resolveSkillSummaryText } from "./company-skill-summary";

// Display-only metadata. Never replace the source used to install or run a skill.
const descriptionKeys: Record<string, string> = {
  "paperclipai/bundled/docs/doc-maintenance": "localizationBundledSkillDescriptions.doc_maintenance",
  "paperclipai/bundled/paperclip-operations/issue-triage": "localizationBundledSkillDescriptions.issue_triage",
  "paperclipai/bundled/paperclip-operations/reflection-coach": "localizationBundledSkillDescriptions.reflection_coach",
  "paperclipai/bundled/paperclip-operations/status-card-query": "localizationBundledSkillDescriptions.status_card_query",
  "paperclipai/bundled/paperclip-operations/summarize-status": "localizationBundledSkillDescriptions.summarize_status",
  "paperclipai/bundled/paperclip-operations/task-planning": "localizationBundledSkillDescriptions.task_planning",
  "paperclipai/bundled/product/paperclip-capsules": "localizationBundledSkillDescriptions.paperclip_capsules",
  "paperclipai/bundled/product/wireframe": "localizationBundledSkillDescriptions.wireframe",
  "paperclipai/bundled/quality/qa-acceptance": "localizationBundledSkillDescriptions.qa_acceptance",
  "paperclipai/bundled/software-development/github-pr-workflow": "localizationBundledSkillDescriptions.github_pr_workflow",
  "paperclipai/optional/browser/agent-browser": "localizationBundledSkillDescriptions.agent_browser",
  "paperclipai/optional/content/release-announcement": "localizationBundledSkillDescriptions.release_announcement",
  "paperclipai/optional/content/simplified-english": "localizationBundledSkillDescriptions.simplified_english",
  "paperclipai/optional/finance/ramp": "localizationBundledSkillDescriptions.ramp",
  "paperclipai/optional/product/design-critique": "localizationBundledSkillDescriptions.design_critique",
  "paperclipai/optional/research/last30days": "localizationBundledSkillDescriptions.last30days",
  "paperclipai/optional/software-development/prepare-mcp-integration": "localizationBundledSkillDescriptions.prepare_mcp_integration",
  "paperclipai/paperclip/paperclip": "localizationBundledSkillDescriptions.paperclip",
  "paperclipai/paperclip/paperclip-board": "localizationBundledSkillDescriptions.paperclip_board",
  "paperclipai/paperclip/paperclip-converting-plans-to-tasks": "localizationBundledSkillDescriptions.paperclip_converting_plans_to_tasks",
  "paperclipai/paperclip/paperclip-create-agent": "localizationBundledSkillDescriptions.paperclip_create_agent",
  "paperclipai/paperclip/para-memory-files": "localizationBundledSkillDescriptions.para_memory_files",
};

type SkillDisplayInput = Parameters<typeof resolveSkillSummaryText>[0] & {
  sourceBadge?: string | null;
  sourceKind?: string | null;
  catalogKind?: string | null;
  kind?: string | null;
};

export function bundledSkillDescriptionDisplay(skill: SkillDisplayInput, raw: string | null | undefined): string | null {
  if (!raw) return raw ?? null;
  const kind = skill.sourceKind ?? skill.catalogKind ?? skill.kind;
  const recognizedSource = skill.sourceBadge === "paperclip" || kind === "bundled" || kind === "optional";
  const key = skill.key ? descriptionKeys[skill.key] : undefined;
  // A modified description/tagline is user content, even for a recognized key.
  if (!recognizedSource || !key || raw !== i18n.getResource("en", "translation", key)) return raw;
  return t(key, { defaultValue: raw });
}

export function bundledSkillSummaryDisplay(skill: SkillDisplayInput, options: { fallbackKey?: boolean } = {}): string | null {
  return bundledSkillDescriptionDisplay(skill, resolveSkillSummaryText(skill, options));
}

export function bundledSkillSourceDisplay(sourceBadge: string | null | undefined, label: string, surface: "source" | "author" = "source"): string {
  return sourceBadge === "paperclip" && label === "Paperclip bundled"
    ? t(surface === "author" ? "localizationBundledSkillDescriptions.bundledAuthor" : "localizationBundledSkillDescriptions.bundledSource")
    : label;
}
