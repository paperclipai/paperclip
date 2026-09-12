import { i18n } from "@/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentSkillSourceMeta } from "./agent-skill-source";

function source(overrides: Parameters<typeof buildAgentSkillSourceMeta>[0]) {
  return buildAgentSkillSourceMeta(overrides).label;
}

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("buildAgentSkillSourceMeta", () => {
  it("localizes fallback display only and preserves custom metadata", async () => {
    await i18n.changeLanguage("ru");
    const source = { sourceBadge: "local", sourceType: "local_path", sourceLabel: "/opt/my-skill", sourceLocator: "/opt/my-skill" } as const;
    const original = { ...source };
    expect(buildAgentSkillSourceMeta(source).label).toBe("Локальная папка");
    expect(buildAgentSkillSourceMeta({ ...source, sourceLabel: "My custom source" }).label).toBe("My custom source");
    expect(source).toEqual(original);
  });
  it("shows GitHub skills as owner/repo text", () => {
    expect(source({
      sourceBadge: "github",
      sourceLabel: "https://github.com/acme/review-skill/tree/main/skills/review",
      sourceLocator: null,
      sourceType: "github",
    })).toBe("GitHub · acme/review-skill");
  });

  it("does not surface long filesystem labels for local skills", () => {
    expect(source({
      sourceBadge: "local",
      sourceLabel: "/Users/dev/work/paperclip/skills/private-review",
      sourceLocator: null,
      sourceType: "local_path",
    })).toBe("Local folder");
  });

  it("keeps human-readable project scan labels for local skills", () => {
    expect(source({
      sourceBadge: "local",
      sourceLabel: "Paperclip App / Engineering workspace",
      sourceLocator: null,
      sourceType: "local_path",
    })).toBe("Paperclip App / Engineering workspace");
  });

  it("does not surface long filesystem labels for catalog skills", () => {
    expect(source({
      sourceBadge: "catalog",
      sourceLabel: "/srv/paperclip/home/.paperclip/instances/default/skills/company-id/__catalog__/briefs-discover-cards--68f7e3ad47",
      sourceLocator: null,
      sourceType: "catalog",
    })).toBe("Catalog");
  });

  it("keeps human-readable catalog labels", () => {
    expect(source({
      sourceBadge: "catalog",
      sourceLabel: "Bundled catalog",
      sourceLocator: null,
      sourceType: "catalog",
    })).toBe("Bundled catalog");
  });
});
