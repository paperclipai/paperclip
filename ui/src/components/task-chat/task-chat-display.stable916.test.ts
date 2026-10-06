import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { taskChatDisplayLabel, taskThreadBuiltinLabel, taskThreadErrorDisplay, taskThreadMarkerDetailDisplay } from "./task-chat-display";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("stable task runtime display boundaries", () => {
  it.each(["constructor", "toString", "__proto__"])("does not recognize inherited object properties as messages: %s", async (raw) => {
    await i18n.changeLanguage("ru");
    for (const display of [taskChatDisplayLabel, taskThreadBuiltinLabel, taskThreadErrorDisplay, taskThreadMarkerDetailDisplay]) expect(display(raw)).toBe(raw);
  });
  it.each([
    ["Workspace setup failed before the agent started. Retry scheduled automatically.", "Не удалось подготовить рабочую область до запуска агента. Повторная попытка запланирована автоматически."],
    ["Workspace setup failed before the agent started. You can retry this message now.", "Не удалось подготовить рабочую область до запуска агента. Можно повторить отправку сообщения."],
    ["Workspace setup failed before the agent started. Your message is preserved.", "Не удалось подготовить рабочую область до запуска агента. Сообщение сохранено."],
    ["Provider output exceeded the safe limit. Your message is preserved.", "Объём ответа провайдера превысил допустимый предел. Сообщение сохранено."],
    ["The runner stopped before returning an answer (RAW_error/code). Your message is preserved.", "Среда запуска остановилась до получения ответа (RAW_error/code). Сообщение сохранено."],
    ["Execution was stopped before returning an answer.", "Выполнение остановлено до получения ответа."],
    ["The previous execution must be checked before this task can continue. Your message is preserved. View the stopped run for details.", "Прежде чем продолжить задачу, нужно проверить предыдущее выполнение. Сообщение сохранено. Подробности — в остановленном запуске."],
  ])("projects only the known generated notice: %s", async (raw, russian) => {
    const source = Object.freeze({ label: "Run failed", detail: raw, errorCode: "RAW_error/code" });
    for (const language of ["ru", "en", "ru"]) {
      await i18n.changeLanguage(language);
      expect(taskThreadMarkerDetailDisplay(source.detail)).toBe(language === "ru" ? russian : raw);
      expect(source).toEqual({ label: "Run failed", detail: raw, errorCode: "RAW_error/code" });
    }
  });

  it("keeps unknown provider copy and user-like diagnostic content verbatim", async () => {
    await i18n.changeLanguage("ru");
    const raw = "CUSTOM: The runner stopped before returning an answer (RAW). Your message is preserved.";
    expect(taskThreadMarkerDetailDisplay(raw)).toBe(raw);
    expect(taskThreadErrorDisplay(raw)).toBe(raw);
    expect(taskChatDisplayLabel("User-defined Approval required title")).toBe("User-defined Approval required title");
    expect(taskChatDisplayLabel("Approval required")).toBe("Требуется разрешение");
    expect(taskChatDisplayLabel("Couldn't start")).toBe("Не удалось запустить");
  });

  it.each([
    ["The stop was requested, but stopping could not be verified. Refresh and try Stop again if work is still running.", "Запрос на остановку отправлен, но подтвердить остановку не удалось. Обновите страницу и повторите остановку, если работа продолжается."],
    ["The stop was requested, but work is still stopping. Try Stop again if it continues.", "Запрос на остановку отправлен, но остановка ещё не завершена. Если работа продолжится, повторите остановку."],
    ["Unable to stop. Try again.", "Не удалось остановить. Повторите попытку."],
  ])("projects finite stop failures without changing the Error: %s", async (raw, russian) => {
    const error = new Error(raw);
    for (const language of ["ru", "en", "ru"]) {
      await i18n.changeLanguage(language);
      expect(taskThreadErrorDisplay(error.message)).toBe(language === "ru" ? russian : raw);
      expect(error.message).toBe(raw);
    }
  });
});
