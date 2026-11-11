import { describe, expect, it } from "vitest";

import { composerPlaceholder, turnOutcomeLabel } from "./task-chat-copy";

const english = "Message Переводчик — describe what you want done…";
const russian = "Сообщение для Переводчик — опишите, что нужно сделать…";

describe("composerPlaceholder", () => {
  it("keeps the English composer hint", () => {
    expect(composerPlaceholder("en", "standard", "Переводчик", false)).toBe(english);
  });

  it("translates the hint and leaves the agent name unchanged", () => {
    expect(composerPlaceholder("ru", "standard", "Переводчик", false)).toBe(russian);
    expect(composerPlaceholder("ru-RU", "standard", "Переводчик", false)).toBe(russian);
  });

  it("translates the short mobile hint", () => {
    expect(composerPlaceholder("ru", "standard", "Переводчик", true)).toBe("Сообщение для Переводчик…");
  });
});

describe("turnOutcomeLabel", () => {
  it("keeps Stopped and Worked in English", () => {
    expect(turnOutcomeLabel("en", true)).toBe("Stopped");
    expect(turnOutcomeLabel("en", false, "38s")).toBe("Worked for 38s");
  });

  it("translates the settled turn status", () => {
    expect(turnOutcomeLabel("ru", true)).toBe("Остановлено");
    expect(turnOutcomeLabel("ru", false, "38s")).toBe("Готово за 38s");
  });
});
