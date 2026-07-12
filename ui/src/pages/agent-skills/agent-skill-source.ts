import { Boxes, Folder, Github, Link2, Paperclip, type LucideIcon } from "lucide-react";
import type { CompanySkillListItem } from "@paperclipai/shared";

export interface AgentSkillSourceMeta {
  icon: LucideIcon;
  label: string;
}

type SourceSkill = Pick<
  CompanySkillListItem,
  "sourceBadge" | "sourceLabel" | "sourceLocator" | "sourceType"
>;

function cleanRepoName(repo: string) {
  return repo.replace(/\.git$/i, "");
}

function githubRepoLabel(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  const parsePath = (path: string) => {
    const [owner, repo] = path.split("/").filter(Boolean);
    if (!owner || !repo) return null;
    return `${owner}/${cleanRepoName(repo)}`;
  };

  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    if (url.hostname.toLowerCase().includes("github")) {
      return parsePath(url.pathname);
    }
  } catch {
    // Fall back to the looser parsing below for owner/repo and git@github forms.
  }

  const sshMatch = raw.match(/^git@[^:]+:([^/]+)\/([^/#?]+)(?:[/?#]|$)/i);
  if (sshMatch?.[1] && sshMatch[2]) return `${sshMatch[1]}/${cleanRepoName(sshMatch[2])}`;

  const githubPathMatch = raw.match(/github\.com[:/]([^/]+)\/([^/#?]+)(?:[/?#]|$)/i);
  if (githubPathMatch?.[1] && githubPathMatch[2]) {
    return `${githubPathMatch[1]}/${cleanRepoName(githubPathMatch[2])}`;
  }

  if (!isFilesystemLikeLabel(raw)) {
    const ownerRepoMatch = raw.match(/^([^/\s]+)\/([^/\s]+)(?:[/?#]|$)/);
    if (ownerRepoMatch?.[1] && ownerRepoMatch[2]) {
      return `${ownerRepoMatch[1]}/${cleanRepoName(ownerRepoMatch[2])}`;
    }
  }

  return null;
}

function hostLabel(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    return url.hostname;
  } catch {
    return null;
  }
}

function isFilesystemLikeLabel(value: string) {
  return (
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.includes("\\") ||
    (value.includes("/") && !value.includes(" / "))
  );
}

function displayLocalSourceLabel(label: string | null | undefined) {
  const trimmed = label?.trim();
  if (!trimmed || isFilesystemLikeLabel(trimmed)) return "Local folder";
  return trimmed;
}

function displayCatalogSourceLabel(label: string | null | undefined) {
  const trimmed = label?.trim();
  if (!trimmed || isFilesystemLikeLabel(trimmed)) return "Catalog";
  return trimmed;
}

export function buildAgentSkillSourceMeta(skill: SourceSkill): AgentSkillSourceMeta {
  if (skill.sourceBadge === "github" || skill.sourceType === "github") {
    const repo = githubRepoLabel(skill.sourceLabel) ?? githubRepoLabel(skill.sourceLocator);
    return { icon: Github, label: repo ? `GitHub · ${repo}` : "GitHub" };
  }

  if (skill.sourceBadge === "skills_sh" || skill.sourceType === "skills_sh") {
    const repo = githubRepoLabel(skill.sourceLabel) ?? githubRepoLabel(skill.sourceLocator);
    return { icon: Github, label: repo ? `skills.sh · ${repo}` : "skills.sh" };
  }

  if (skill.sourceBadge === "url" || skill.sourceType === "url") {
    return { icon: Link2, label: hostLabel(skill.sourceLabel) ?? hostLabel(skill.sourceLocator) ?? "URL" };
  }

  if (skill.sourceBadge === "paperclip") {
    return { icon: Paperclip, label: skill.sourceLabel?.trim() || "Paperclip managed" };
  }

  if (skill.sourceBadge === "catalog" || skill.sourceType === "catalog") {
    return { icon: Boxes, label: displayCatalogSourceLabel(skill.sourceLabel) };
  }

  if (skill.sourceBadge === "local" || skill.sourceType === "local_path") {
    return { icon: Folder, label: displayLocalSourceLabel(skill.sourceLabel) };
  }

  return { icon: Boxes, label: displayCatalogSourceLabel(skill.sourceLabel) };
}
