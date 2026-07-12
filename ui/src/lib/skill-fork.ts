import type {
  CompanySkillForkSummary,
  CompanySkillOriginalSummary,
  CompanySkillSourceType,
  CompanySkillUsageAgent,
} from "@paperclipai/shared";

/**
 * Pure logic for the Skill Studio "Edit a copy" fork flow (PAP-13112). Kept
 * free of React so the dialog's decision logic — lineage labelling, existing-
 * copy detection, agent-reassignment targeting — is unit-testable in isolation
 * (plan §3 / §4.2 of PAP-13070).
 */

/**
 * Shorten a git commit SHA to 7 characters for display. Branch/tag names and
 * anything that is not a hex object id are returned unchanged so a pinned
 * `main`/`v1.2.0` ref still reads sensibly in the lineage chip.
 */
export function shortSha(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const trimmed = ref.trim();
  if (!trimmed) return null;
  return /^[0-9a-f]{8,40}$/i.test(trimmed) ? trimmed.slice(0, 7) : trimmed;
}

function sourceTypeFallbackLabel(sourceType: CompanySkillSourceType): string {
  switch (sourceType) {
    case "github":
      return "GitHub";
    case "skills_sh":
      return "skills.sh";
    case "url":
      return "a URL";
    case "catalog":
      return "the catalog";
    case "local_path":
      return "a local path";
    default:
      return "its source";
  }
}

/** Extract `owner/repo` from a GitHub URL or `owner/repo[/subpath][#ref]` shorthand. */
function githubOwnerRepo(locator: string): string | null {
  let value = locator
    .replace(/^git@github\.com:/i, "")
    .replace(/^https?:\/\/github\.com\//i, "");
  value = value.split("#")[0].split("?")[0].replace(/\.git$/i, "");
  const segments = value.split("/").filter(Boolean);
  return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
}

function prettyUrl(locator: string): string {
  return locator.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/**
 * Human-readable source name for a fork's origin — `owner/repo` for GitHub,
 * a cleaned host/path for URLs, otherwise the raw locator or a source-type
 * fallback when no locator is recorded.
 */
export function formatForkSourceName(source: {
  sourceType: CompanySkillSourceType;
  sourceLocator: string | null;
}): string {
  const locator = source.sourceLocator?.trim() ?? "";
  if (!locator) return sourceTypeFallbackLabel(source.sourceType);
  if (source.sourceType === "github") return githubOwnerRepo(locator) ?? locator;
  if (source.sourceType === "url") return prettyUrl(locator);
  return locator;
}

/**
 * The lineage chip label: `owner/repo @ <short-sha>` (the `@ sha` clause is
 * dropped when the source has no pinned ref, e.g. skills.sh / URL sources).
 */
export function formatLineageLabel(original: CompanySkillOriginalSummary): string {
  const name = formatForkSourceName(original);
  const sha = shortSha(original.sourceRef);
  return sha ? `${name} @ ${sha}` : name;
}

/**
 * Fork-sprawl guard (plan §5): the first existing fork of this skill that the
 * current actor created and has not yet diverged, so the dialog can offer
 * "Open your existing copy" instead of minting `-fork-2`, `-fork-3`, … .
 */
export function pickReusableFork(
  existingForks: CompanySkillForkSummary[],
): CompanySkillForkSummary | null {
  return (
    existingForks.find((fork) => fork.createdByCurrentActor && !fork.diverged) ?? null
  );
}

/** Unmissable agent-usage sentence for the dialog body (P3 hard requirement). */
export function agentUsageSentence(count: number): string {
  if (count <= 0) return "No agents currently use this skill";
  return `${count} ${count === 1 ? "agent" : "agents"} currently use${count === 1 ? "s" : ""} this skill`;
}

/** Agent ids to reassign when the "Switch these agents to the copy" toggle is on. */
export function reassignTargetIds(usedByAgents: CompanySkillUsageAgent[]): string[] {
  return usedByAgents.map((agent) => agent.id);
}

/**
 * Whether a skill is repo-synced (`project_scan`) — editable, but its saves
 * write directly into the user's project working tree (plan §3.3). Detected via
 * the skill's `metadata.sourceKind`.
 */
export function isProjectScanSkill(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const raw = (metadata as Record<string, unknown>).sourceKind;
  return typeof raw === "string" && raw.trim() === "project_scan";
}
