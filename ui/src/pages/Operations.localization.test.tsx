// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { i18n, t } from "@/i18n";
import { environmentDisplayLabel } from "../lib/managed-sandbox-environment";

afterEach(() => { void i18n.changeLanguage("en"); });

describe("Team and environment localization", () => {
  it.each([[1, "источник", "песочницу"], [2, "источника", "песочницы"], [5, "источников", "песочниц"], [21, "источник", "песочницу"], [22, "источника", "песочницы"], [25, "источников", "песочниц"]])(
    "keeps Russian count forms and deletion meaning for %i",
    (count, source, sandbox) => {
      void i18n.changeLanguage("ru");
      expect(t("localizationOperations.externalSourceCount", { count })).toContain(`${count} внешн`);
      expect(t("localizationOperations.externalSourceCount", { count })).toMatch(new RegExp(source + "$"));
      expect(t("localizationOperations.destroyAndDelete", { count })).toBe(`Уничтожить ${count} ${sandbox} и удалить`);
      expect(t("localizationOperations.destroyReusableSandboxes", { count })).toContain("Рабочие области останутся открытыми");
    },
  );

  it("preserves the environment name and machine driver across locale changes", () => {
    const environment = { name: "Raw environment", driver: "ssh" as const, metadata: {} };
    expect(environmentDisplayLabel(environment)).toBe("Raw environment · ssh");
    void i18n.changeLanguage("ru");
    expect(environmentDisplayLabel(environment)).toBe("Raw environment · SSH");
    expect(environment).toEqual({ name: "Raw environment", driver: "ssh", metadata: {} });
    void i18n.changeLanguage("en");
    expect(environmentDisplayLabel(environment)).toBe("Raw environment · ssh");
  });
});
