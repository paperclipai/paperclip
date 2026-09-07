import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { bundledSkillDescriptionDisplay, bundledSkillSourceDisplay, bundledSkillSummaryDisplay } from "./bundled-skill-display";
import { resolveSkillSummaryText } from "./company-skill-summary";

const catalog = JSON.parse(readFileSync(new URL("../../../packages/skills-catalog/generated/catalog.json", import.meta.url), "utf8")) as {
  skills: { key: string; name: string; description: string; kind: string }[];
};
const coreSource = readFileSync(new URL("../../../server/src/services/company-skills.ts", import.meta.url), "utf8");
const coreKeys = [...coreSource.match(/export const PAPERCLIP_CORE_SKILL_KEYS = \[([\s\S]*?)\] as const/)![1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
const core = coreKeys.map(key => {
  const name = key.split("/").at(-1)!;
  const source = readFileSync(new URL(`../../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
  const description = source.split("---")[1].match(/description: >\s*\n([\s\S]*)/)![1].trim().replace(/\s+/g, " ");
  return { key, name, description, sourceBadge: "paperclip" };
});

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("bundled skill display metadata", () => {
  it.each([...catalog.skills, ...core])("localizes the current bundled description for $key only at display time", async skill => {
    const snapshot = JSON.stringify(skill);
    expect(bundledSkillSummaryDisplay(skill)).toBe(skill.description);
    await i18n.changeLanguage("ru");
    const translated = bundledSkillSummaryDisplay(skill);
    expect(translated).toMatch(/[А-Яа-яЁё]/);
    expect(translated).not.toContain("localizationBundledSkillDescriptions.");
    expect(resolveSkillSummaryText(skill)).toBe(skill.description);
    expect(JSON.stringify(skill)).toBe(snapshot);
    await i18n.changeLanguage("en");
    expect(bundledSkillSummaryDisplay(skill)).toBe(skill.description);
  });

  it("preserves edited descriptions, custom taglines, and unrelated sources even with a matching key", async () => {
    const skill = core[0];
    await i18n.changeLanguage("ru");
    expect(bundledSkillSummaryDisplay({ ...skill, tagline: "My exact custom summary" })).toBe("My exact custom summary");
    expect(bundledSkillSummaryDisplay({ ...skill, description: `${skill.description} Custom addition.` })).toBe(`${skill.description} Custom addition.`);
    expect(bundledSkillSummaryDisplay({ ...skill, sourceBadge: "github" })).toBe(skill.description);
    expect(bundledSkillSummaryDisplay({ ...skill, key: "third-party/paperclip" })).toBe(skill.description);
    expect(bundledSkillDescriptionDisplay(skill, "" )).toBe("");
    expect(bundledSkillSummaryDisplay({ key: "raw/key" }, { fallbackKey: true })).toBe("raw/key");
  });

  it("translates only the built-in source attribution", async () => {
    await i18n.changeLanguage("ru");
    expect(bundledSkillSourceDisplay("paperclip", "Paperclip bundled")).toBe("Встроенные навыки Paperclip");
    expect(bundledSkillSourceDisplay("github", "Paperclip bundled")).toBe("Paperclip bundled");
    expect(bundledSkillSourceDisplay("paperclip", "Raw publisher")).toBe("Raw publisher");
  });
});
