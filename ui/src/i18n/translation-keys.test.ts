import { afterEach, describe, expect, it } from "vitest";
import { i18n, t } from ".";
import en from "./locales/en.json";

const sources = import.meta.glob<string>(["../**/*.tsx", "../**/*.ts", "!../**/*.test.ts", "!../**/*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"];

function hasMessage(key: string) {
  const path = key.split(".");
  const leaf = path.pop() as string;
  let node: unknown = en;
  for (const segment of path) {
    if (!node || typeof node !== "object") return false;
    node = (node as Record<string, unknown>)[segment];
  }
  if (!node || typeof node !== "object") return false;
  const messages = node as Record<string, unknown>;
  if (typeof messages[leaf] === "string") return true;
  return PLURAL_SUFFIXES.some((suffix) => typeof messages[`${leaf}_${suffix}`] === "string");
}

describe("translation keys", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("defines every literal t() key in the English catalog", () => {
    const missing: string[] = [];
    for (const [file, source] of Object.entries(sources)) {
      for (const match of source.matchAll(/\bt\(\s*"([A-Za-z0-9_.-]+)"/g)) {
        if (!hasMessage(match[1])) missing.push(`${file}: ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("renders navigation and dashboard copy in Brazilian Portuguese", async () => {
    await i18n.changeLanguage("pt-BR");
    expect(t("nav.tasks")).toBe("Tarefas");
    expect(t("nav.section.collapse", { label: "Tarefas" })).toBe("Recolher Tarefas");
    expect(t("dashboard.budget.activeIncidents", { count: 1 })).toBe("1 incidente de orçamento ativo");
    expect(t("dashboard.budget.activeIncidents", { count: 3 })).toBe("3 incidentes de orçamento ativos");
  });

  it("keeps the English copy for plural messages", () => {
    expect(t("dashboard.pausedImported.title", { count: 1 })).toBe("1 imported agent is paused and will not run.");
    expect(t("dashboard.pausedImported.title", { count: 2 })).toBe("2 imported agents are paused and will not run.");
  });
});
