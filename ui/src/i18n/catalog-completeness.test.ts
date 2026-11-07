import { describe, expect, it } from "vitest";
import { buildCatalogResources } from "./catalog-resources";
import { checkCatalogCompleteness } from "./catalog-completeness";

const reference = {
  "./catalogs/en/menu.json": { save: "Save" },
  "./catalogs/zh-CN/menu.json": { save: "保存" },
};

describe("Simplified Chinese completion gate", () => {
  it("rejects a missing whole Chinese namespace even though runtime fallback is valid", () => {
    const modules = { "./catalogs/en/menu.json": { save: "Save" } };
    expect(() => buildCatalogResources({ en: {}, "zh-CN": {} }, modules)).not.toThrow();
    expect(checkCatalogCompleteness(modules)).toEqual([
      "Missing zh-CN catalog for menu",
    ]);
  });

  it("accepts matching complete catalog namespaces", () => {
    expect(checkCatalogCompleteness(reference)).toEqual([]);
  });

  it("reports missing translation keys and altered placeholders", () => {
    expect(checkCatalogCompleteness({
      "./catalogs/en/menu.json": { save: "Save", count: "{{count}} tasks" },
      "./catalogs/zh-CN/menu.json": { count: "{{数量}} 个任务" },
    })).toEqual(expect.arrayContaining([
      expect.stringMatching(/menu.*save.*missing/),
      expect.stringMatching(/menu.*placeholders/),
    ]));
  });

  it("rejects orphan Chinese catalogs", () => {
    expect(checkCatalogCompleteness({
      "./catalogs/zh-CN/menu.json": { save: "保存" },
    })).toEqual(["Missing en catalog for menu"]);
  });

  it("validates all current product catalog namespaces", () => {
    const modules = import.meta.glob("./catalogs/*/*.json", {
      eager: true,
      import: "default",
    });
    expect(checkCatalogCompleteness(modules)).toEqual([]);
  });
});
