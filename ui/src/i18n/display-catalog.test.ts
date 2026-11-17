import { describe, expect, it } from "vitest";

const catalogs = import.meta.glob<Record<string, unknown>>("./display/*.json", { eager: true, import: "default" });

function placeholders(text: string) {
  return Array.from(text.matchAll(/\{\{[^{}]+\}\}/g), (match) => match[0]).sort();
}

function urls(text: string) {
  return Array.from(text.matchAll(/\bhttps?:\/\/[^\s<>"')]+/gi), (match) => match[0]).sort();
}

function hasHtmlTag(text: string) {
  return /<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^>]*)?>/.test(text);
}

describe("display catalogs", () => {
  it("ships at least one catalog", () => {
    expect(Object.keys(catalogs).length).toBeGreaterThan(0);
  });

  for (const [path, catalog] of Object.entries(catalogs)) {
    it(`${path} only holds safe string translations keyed by normalized source text`, () => {
      const errors: string[] = [];
      for (const [source, translated] of Object.entries(catalog)) {
        if (typeof translated !== "string" || translated.trim() === "") {
          errors.push(`${source}: translation must be a non-empty string`);
          continue;
        }
        if (source !== source.replace(/\s+/g, " ").trim()) errors.push(`${source}: key is not normalized`);
        if (placeholders(source).join("|") !== placeholders(translated).join("|")) errors.push(`${source}: placeholders differ`);
        if (hasHtmlTag(translated) && !hasHtmlTag(source)) errors.push(`${source}: adds an HTML tag`);
        const sourceUrls = new Set(urls(source));
        if (urls(translated).some((url) => !sourceUrls.has(url))) errors.push(`${source}: adds a URL`);
        if (/javascript\s*:/i.test(translated) && !/javascript\s*:/i.test(source)) errors.push(`${source}: adds javascript:`);
        const limit = Math.min(2_000, Math.max(source.length * 4 + 64, source.length + 128));
        if (translated.length > limit) errors.push(`${source}: translation is too long`);
      }
      expect(errors).toEqual([]);
    });
  }
});
