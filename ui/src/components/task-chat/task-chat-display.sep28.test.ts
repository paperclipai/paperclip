import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { workspaceRestoreMarkerDetail } from "@/lib/workspace-restore-marker";
import { taskChatDisplayLabel, taskThreadErrorDisplay, taskThreadMarkerDetailDisplay } from "./task-chat-display";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("September 28 built-in task marker presentation", () => {
  it.each([
    ["The run was cancelled.", "Запуск отменён."],
    ["The run was interrupted.", "Запуск прерван."],
    ["Execution was stopped.", "Выполнение остановлено."],
    ["The runner timed out (RAW_error/code).", "Истекло время ожидания среды запуска (RAW_error/code)."],
    ["The runner stopped (RAW_error/code).", "Среда запуска остановилась (RAW_error/code)."],
    ["The run failed (RAW_error/code). Retry scheduled automatically.", "Запуск завершился с ошибкой (RAW_error/code). Повторная попытка запланирована автоматически."],
    ["The run failed (RAW_error/code). You can retry this message now.", "Запуск завершился с ошибкой (RAW_error/code). Можно повторить отправку сообщения."],
    ["The run failed (RAW_error/code). Your message is preserved.", "Запуск завершился с ошибкой (RAW_error/code). Сообщение сохранено."],
  ])("localizes %s without inventing a response boundary", async (raw, russian) => {
    const source = Object.freeze({ label: "Run failed", detail: raw, errorCode: "RAW_error/code" });
    for (const language of ["ru", "en", "ru"]) {
      await i18n.changeLanguage(language);
      const display = taskThreadMarkerDetailDisplay(source.detail);
      expect(display).toBe(language === "ru" ? russian : raw);
      expect(display).not.toMatch(/before returning|до получения ответа/);
      expect(source).toEqual({ label: "Run failed", detail: raw, errorCode: "RAW_error/code" });
    }
  });

  it.each([false, true])("preserves restore evidence, paths and raw metadata (savedPlan: %s)", async (savedPlan) => {
    for (const hasResponse of [false, true]) {
      const result = Object.freeze({ workspaceRestorePath: ".claude/skills/paperclip", finalResponseRecorded: false, errorCode: "restore_RAW_code", response: "Original model response" });
      const original = JSON.stringify(result);
      const raw = workspaceRestoreMarkerDetail({ result, savedPlan, hasResponse });
      for (const language of ["ru", "en", "ru"]) {
        await i18n.changeLanguage(language);
        const display = taskThreadMarkerDetailDisplay(raw);
        expect(display).toBe(language === "en" ? raw : [
          savedPlan
            ? "Не удалось восстановить рабочую область после сохранения плана. Сохранённый план доступен. Файлы рабочей области нужно восстановить."
            : "Не удалось восстановить рабочую область. Файлы рабочей области нужно восстановить.",
          ...(!hasResponse ? ["Итоговый ответ не записан."] : []),
          "Затронутый путь: .claude/skills/paperclip.",
        ].join(" "));
        expect(taskChatDisplayLabel("Workspace restore failed")).toBe(language === "ru" ? "Не удалось восстановить рабочую область" : "Workspace restore failed");
        expect(JSON.stringify(result)).toBe(original);
        expect(workspaceRestoreMarkerDetail({ result, savedPlan, hasResponse })).toBe(raw);
      }
    }
  });

  it.each([
    ["This question has already been answered or closed.", "На вопрос уже ответили или он закрыт."],
    ["Cancelling this question is unavailable.", "Отменить этот вопрос нельзя."],
    ["Submit the answer through the saved question card.", "Отправьте ответ через сохранённую карточку вопроса."],
  ])("localizes only presentation of the durable question error: %s", async (raw, russian) => {
    const error = new Error(raw);
    for (const language of ["ru", "en", "ru"]) {
      await i18n.changeLanguage(language);
      expect(taskThreadErrorDisplay(error.message)).toBe(language === "ru" ? russian : raw);
      expect(error.message).toBe(raw);
    }
  });

  it.each([
    "Custom: The run was cancelled.",
    "Custom: The runner stopped (RAW_error/code).",
    "The runner stopped (RAW_error/code).\n",
    "The run failed (RAW_error/code). Your message is preserved.\n",
    "The run failed (RAW_error/code). Provider-specific advice.",
    "The run failed (RAW_error/code). Your message is preserved. Extra diagnostic.",
    "Workspace restore failed. Workspace files need recovery. Affected path: /host/private.",
    "Workspace restore failed. Workspace files need recovery. Extra diagnostic.",
    "Workspace restore failed. Workspace files need recovery.\n",
    "Custom: This question has already been answered or closed.",
    "constructor", "toString", "__proto__",
  ])("keeps non-built-in content verbatim: %s", async (raw) => {
    for (const language of ["ru", "en"]) {
      await i18n.changeLanguage(language);
      expect(taskThreadMarkerDetailDisplay(raw)).toBe(raw);
      expect(taskThreadErrorDisplay(raw)).toBe(raw);
      expect(taskChatDisplayLabel(raw)).toBe(raw);
    }
  });
});
