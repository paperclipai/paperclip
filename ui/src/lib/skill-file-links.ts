import type { CompanySkill } from "@paperclipai/shared";
import { skillRoute, type CompanySkillRouteSubject } from "./company-skill-routes";

type FileLinkSkill = Pick<CompanySkill, "id" | "slug" | "key" | "sourceType" | "metadata" | "fileInventory">;

/** Resolve authored links without rewriting instructions or leaving the saved inventory. */
export function skillFileLinkHref(skill: FileLinkSkill, selectedPath: string, href: string, routeSkills: CompanySkillRouteSubject[] = [skill]): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) return href;
  const originalPath = selectedPath === "SKILL.md" && skill.sourceType === "github"
    && skill.metadata?.packageMode === "repository" && typeof skill.metadata.skillSourcePath === "string"
    ? `.paperclip-repository/${skill.metadata.skillSourcePath}` : selectedPath;
  try {
    const url = new URL(href, `https://skill.invalid/${originalPath.split("/").map(encodeURIComponent).join("/")}`);
    const target = decodeURIComponent(url.pathname.slice(1));
    if (!skill.fileInventory.some(file => file.path === target)) return null;
    return `${skillRoute(skill, routeSkills, target)}${url.search}${url.hash}`;
  } catch { return null; }
}
