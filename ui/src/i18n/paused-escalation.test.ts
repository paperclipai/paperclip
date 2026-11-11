import { describe, expect, it } from "vitest";

import { pausedEscalationCopy } from "./paused-escalation";
import { effectiveUiLanguage } from "./tx";

const english =
  "Escalations from Переводчик route to paused agent Chief. " +
  "Work assigned to a paused agent never runs; unpause Chief or change who this agent reports to.";

describe("pausedEscalationCopy", () => {
  it("keeps the English warning", () => {
    expect(pausedEscalationCopy("en", english, "Переводчик", "Chief")).toEqual({
      title: "Escalation path is paused",
      body: english,
    });
  });

  it("translates the title and the sentence with the agent names", () => {
    expect(pausedEscalationCopy("ru", english, "Переводчик", "Chief")).toEqual({
      title: "Цепочка эскалации на паузе",
      body:
        "Эскалации от агента Переводчик идут агенту Chief на паузе. " +
        "Работа, назначенная агенту на паузе, не запускается. " +
        "Снимите Chief с паузы или измените, кому подчиняется этот агент.",
    });
  });

  it("accepts a regional Russian code", () => {
    expect(pausedEscalationCopy("ru-RU", english, "Переводчик", "Chief").title).toBe(
      "Цепочка эскалации на паузе",
    );
  });

  it("follows a stored ru locale when i18next resolved English", () => {
    const language = effectiveUiLanguage("en", "ru");
    expect(pausedEscalationCopy(language, english, "Переводчик", "Chief")).toEqual({
      title: "Цепочка эскалации на паузе",
      body:
        "Эскалации от агента Переводчик идут агенту Chief на паузе. " +
        "Работа, назначенная агенту на паузе, не запускается. " +
        "Снимите Chief с паузы или измените, кому подчиняется этот агент.",
    });
  });

  it("reads the names from the English sentence when the chain has no ancestor field", () => {
    const copy = pausedEscalationCopy("ru", english, "", null);
    expect(copy.body).toContain("агента Переводчик");
    expect(copy.body).toContain("агенту Chief");
  });
});
