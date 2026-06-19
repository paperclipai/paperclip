import { describe, expect, it } from "vitest";
import {
  canonicalSkillRouteToken,
  parseSkillRoute,
  resolveSkillRouteToken,
  skillRoute,
  type CompanySkillRouteSubject,
} from "./company-skill-routes";

function skill(id: string, slug: string, key = slug): CompanySkillRouteSubject {
  return { id, slug, key };
}

const deepResearch = skill("11111111-1111-4111-8111-111111111111", "deep-research", "paperclip/deep-research");
const scopedDeepResearch = skill("22222222-2222-4222-8222-222222222222", "deep-research", "community/deep-research");
const browser = skill("33333333-3333-4333-8333-333333333333", "browser", "paperclip/browser");

describe("company skill routes", () => {
  it("builds unique slug detail and file routes", () => {
    expect(canonicalSkillRouteToken(browser, [deepResearch, scopedDeepResearch, browser])).toBe("browser");
    expect(skillRoute(browser, [deepResearch, scopedDeepResearch, browser])).toBe("/skills/browser");
    expect(skillRoute(browser, [browser], "references/setup guide.md")).toBe(
      "/skills/browser/files/references/setup%20guide.md",
    );
  });

  it("uses a unique key to disambiguate colliding slugs", () => {
    const skills = [deepResearch, scopedDeepResearch, browser];

    expect(canonicalSkillRouteToken(deepResearch, skills)).toBe("paperclip/deep-research");
    expect(canonicalSkillRouteToken(scopedDeepResearch, skills)).toBe("community/deep-research");
    expect(skillRoute(deepResearch, skills)).toBe("/skills/paperclip/deep-research");
  });

  it("falls back to a slug plus short id when the key is not route-safe", () => {
    const unsafe = skill("44444444-4444-4444-8444-444444444444", "deep-research", "paperclip/files/deep-research");
    const skills = [deepResearch, unsafe];

    expect(canonicalSkillRouteToken(unsafe, skills)).toBe("deep-research-44444444");
    expect(skillRoute(unsafe, skills)).toBe("/skills/deep-research-44444444");
  });

  it("resolves legacy UUID URLs and asks callers to redirect to the canonical token", () => {
    const resolution = resolveSkillRouteToken(browser.id, [browser]);

    expect(resolution.skill?.id).toBe(browser.id);
    expect(resolution.canonicalToken).toBe("browser");
    expect(resolution.shouldRedirect).toBe(true);
  });

  it("resolves canonical key URLs for colliding slugs", () => {
    const skills = [deepResearch, scopedDeepResearch];
    const resolution = resolveSkillRouteToken("community/deep-research", skills);

    expect(resolution.skill?.id).toBe(scopedDeepResearch.id);
    expect(resolution.shouldRedirect).toBe(false);
    expect(resolution.ambiguous).toBe(false);
  });

  it("leaves ambiguous bare slug URLs unresolved", () => {
    const resolution = resolveSkillRouteToken("deep-research", [deepResearch, scopedDeepResearch]);

    expect(resolution.skill).toBeNull();
    expect(resolution.ambiguous).toBe(true);
  });

  it("parses token paths and encoded file paths", () => {
    expect(parseSkillRoute("paperclip/deep-research/files/references/setup%20guide.md")).toEqual({
      skillToken: "paperclip/deep-research",
      filePath: "references/setup guide.md",
    });
    expect(parseSkillRoute(undefined)).toEqual({ skillToken: null, filePath: "SKILL.md" });
  });
});
