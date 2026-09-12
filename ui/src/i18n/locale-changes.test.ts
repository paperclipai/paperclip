// @vitest-environment node
import { describe, expect, it } from "vitest";
import { collectLocaleChanges } from "../../../scripts/locale-changes.mjs";

describe("source-change review queue", () => {
  it("detects changed English under an existing key even when Russian is unchanged", () => {
    const report = collectLocaleChanges({
      previousSource: { save: "Save", remove: "Remove", stable: "API" },
      source: { save: "Save and restart", add: "Add", stable: "API" },
      previousTarget: { save: "Сохранить", remove: "Удалить", stable: "API" },
      target: { save: "Сохранить", add: "Добавить", stable: "API" }, locale: "ru",
    });
    expect(report.map((item: { key: string; kind: string }) => [item.key, item.kind])).toEqual([
      ["add", "added"], ["remove", "removed"], ["save", "changed"],
    ]);
    expect(report[2].translations[0]).toEqual({ key: "save", previous: "Сохранить", current: "Сохранить", status: "unchanged" });
  });

  it("includes every dependent Russian plural form in an English plural change", () => {
    const report = collectLocaleChanges({
      previousSource: { inbox: { item_one: "{{count}} item", item_other: "{{count}} items" } },
      source: { inbox: { item_one: "{{count}} task", item_other: "{{count}} tasks" } },
      previousTarget: {},
      target: { inbox: { item_one: "{{count}} задача", item_few: "{{count}} задачи", item_many: "{{count}} задач", item_other: "{{count}} задачи" } },
      locale: "ru",
    });
    expect(report.flatMap((item: { translations: { key: string }[] }) => item.translations.map((target) => target.key)).sort()).toEqual([
      "inbox.item_few", "inbox.item_many", "inbox.item_one", "inbox.item_other",
    ]);
  });

  it("reports source copies and missing targets without treating brands as translation failures", () => {
    const report = collectLocaleChanges({ previousSource: {}, source: { brand: "Paperclip", save: "Save" }, previousTarget: {}, target: { brand: "Paperclip" }, locale: "ru" });
    expect(report[0].translations[0].status).toBe("matches-source");
    expect(report[1].translations[0].status).toBe("missing");
  });

  it("never mutates catalogs and does not call an edited translation reviewed", () => {
    const source = Object.freeze({ notice: "New meaning" });
    const target = Object.freeze({ notice: "Новый смысл" });
    const report = collectLocaleChanges({ previousSource: { notice: "Old meaning" }, source, previousTarget: { notice: "Старый смысл" }, target, locale: "ru" });
    expect(report[0].translations[0].status).toBe("edited");
    expect(source).toEqual({ notice: "New meaning" });
    expect(target).toEqual({ notice: "Новый смысл" });
  });
});
