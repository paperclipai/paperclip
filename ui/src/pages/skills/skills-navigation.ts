export type SkillsNavigationView = "installed" | "discover" | "authored";

export const SKILLS_NAVIGATION_HREFS: Record<SkillsNavigationView, string> = {
  installed: "/skills",
  discover: "/skills?tab=discover",
  authored: "/skills/studio",
};

export function resolveSkillsDiscoveryView(tabParam: string | null): Exclude<SkillsNavigationView, "authored"> {
  // Preserve old discovery links while presenting one canonical Discover view.
  return ["discover", "all", "catalog", "bundled"].includes(tabParam ?? "")
    ? "discover"
    : "installed";
}

export function withSkillsDiscoveryView(
  current: URLSearchParams,
  view: Exclude<SkillsNavigationView, "authored">,
): URLSearchParams {
  const params = new URLSearchParams(current);
  if (view === "installed") params.delete("tab");
  else params.set("tab", "discover");
  params.delete("view");
  params.delete("category");
  if (view !== "installed") params.delete("folder");
  return params;
}

export function resolveSkillsNavigationView(
  pathname: string,
  search: string | URLSearchParams = "",
): SkillsNavigationView {
  const segments = pathname.split("/").filter(Boolean);
  const skillsIndex = segments.findIndex((segment) => segment.toLowerCase() === "skills");
  const skillsRoute = skillsIndex >= 0 ? segments.slice(skillsIndex + 1) : [];
  if (skillsRoute[0]?.toLowerCase() === "studio") return "authored";

  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  if (params.has("catalog") || params.get("view") === "catalog") return "discover";
  return resolveSkillsDiscoveryView(params.get("tab"));
}
