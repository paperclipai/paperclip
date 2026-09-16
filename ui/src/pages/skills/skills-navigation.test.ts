import { describe, expect, it } from "vitest";
import {
  resolveSkillsDiscoveryView,
  resolveSkillsNavigationView,
  SKILLS_NAVIGATION_HREFS,
  withSkillsDiscoveryView,
} from "./skills-navigation";

describe("skills navigation", () => {
  it("defaults to Installed and exposes stable canonical hrefs", () => {
    expect(resolveSkillsDiscoveryView(null)).toBe("installed");
    expect(resolveSkillsNavigationView("/PAP/skills", "")).toBe("installed");
    expect(SKILLS_NAVIGATION_HREFS).toEqual({
      installed: "/skills",
      discover: "/skills?tab=discover",
      authored: "/skills/studio",
    });
  });

  it.each(["discover", "all", "catalog", "bundled"])(
    "maps the legacy %s tab to Discover",
    (tab) => {
      expect(resolveSkillsDiscoveryView(tab)).toBe("discover");
      expect(resolveSkillsNavigationView("/PAP/skills", `?tab=${tab}`)).toBe("discover");
    },
  );

  it("treats catalog detail links as Discover and Studio routes as My Skills", () => {
    expect(resolveSkillsNavigationView("/PAP/skills", "?catalog=skill-1")).toBe("discover");
    expect(resolveSkillsNavigationView("/PAP/skills", "?view=catalog")).toBe("discover");
    expect(resolveSkillsNavigationView("/PAP/skills/studio/skill-1", "?tab=files")).toBe("authored");
  });

  it("canonicalizes view changes without carrying incompatible filters", () => {
    expect(withSkillsDiscoveryView(
      new URLSearchParams("tab=catalog&folder=my&category=writing&source=bundled"),
      "discover",
    ).toString()).toBe("tab=discover&source=bundled");

    expect(withSkillsDiscoveryView(
      new URLSearchParams("tab=discover&folder=my&source=external"),
      "installed",
    ).toString()).toBe("folder=my&source=external");
  });
});
