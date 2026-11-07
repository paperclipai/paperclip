import { describe, expect, it } from "vitest";
import { createInstance } from "i18next";
import { buildCatalogResources } from "./catalog-resources";

const base = {
  en: { app: { title: "Paperclip" } },
  "zh-CN": { app: { title: "Paperclip" } },
  fr: { app: { title: "Paperclip" } },
};

describe("product translation namespaces", () => {
  it("adds validated namespaces without rewriting unrelated locale messages", () => {
    const resources = buildCatalogResources(base, {
      "./catalogs/en/navigation.json": { dashboard: "Dashboard" },
      "./catalogs/zh-CN/navigation.json": { dashboard: "仪表盘" },
    });
    expect(resources.en.translation).toEqual(base.en);
    expect(resources["zh-CN"].navigation).toEqual({ dashboard: "仪表盘" });
    expect(resources.fr).toEqual({ translation: base.fr });
    expect(base).not.toHaveProperty("en.navigation");
  });

  it("falls back to English for languages that do not yet translate a namespace", async () => {
    const instance = createInstance();
    const resources = buildCatalogResources(base, {
      "./catalogs/en/navigation.json": { dashboard: "Dashboard" },
      "./catalogs/zh-CN/navigation.json": { dashboard: "仪表盘" },
    });
    await instance.init({ resources, lng: "fr", fallbackLng: "en", initAsync: false });
    expect(instance.t("dashboard", { ns: "navigation" })).toBe("Dashboard");
    await instance.changeLanguage("zh-CN");
    expect(instance.t("dashboard", { ns: "navigation" })).toBe("仪表盘");
  });

  it("rejects a translation namespace without its English source", () => {
    expect(() => buildCatalogResources(base, {
      "./catalogs/zh-CN/navigation.json": { dashboard: "仪表盘" },
    })).toThrow(/English/);
  });

  it("rejects missing keys and changed interpolation parameters", () => {
    expect(() => buildCatalogResources(base, {
      "./catalogs/en/navigation.json": { count: "{{count}} tasks", dashboard: "Dashboard" },
      "./catalogs/zh-CN/navigation.json": { count: "{{数量}} 个任务" },
    })).toThrow(/missing|placeholders/);
  });

  it("rejects unsafe or duplicate namespace paths", () => {
    expect(() => buildCatalogResources(base, {
      "./catalogs/en/translation.json": { title: "Override" },
    })).toThrow(/namespace/);
    expect(() => buildCatalogResources(base, {
      "./catalogs/en/../../navigation.json": { title: "Override" },
    })).toThrow(/path/);
  });

  it("rejects unexpected links introduced by translations", () => {
    expect(() => buildCatalogResources(base, {
      "./catalogs/en/navigation.json": { help: "Help" },
      "./catalogs/zh-CN/navigation.json": { help: "https://unexpected.example" },
    })).toThrow(/unexpected URL/);
  });
});
