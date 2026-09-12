// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { queuedMessageWaitMessage } from "./queued-message-display";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("queuedMessageWaitMessage", () => {
  it("distinguishes manual cleanup from automatic recovery for the same reason through language changes", async () => {
    const manual = {
      reason: "controller_settling",
      message: "The cancelled run still needs verified cleanup. Your message is saved. Inspect the run and its environment for details.",
    };
    const automatic = {
      reason: "controller_settling",
      message: "Waiting for the previous run to finish recovery. Your message will start automatically.",
    };
    const original = JSON.stringify([manual, automatic]);
    for (const locale of ["en", "ru", "en"]) {
      await i18n.changeLanguage(locale);
      expect(queuedMessageWaitMessage(manual.message)).toBe(locale === "en" ? manual.message
        : "Очистка после отменённого запуска ещё не подтверждена. Сообщение сохранено. Подробности доступны в сведениях о запуске и его среде.");
      expect(queuedMessageWaitMessage(automatic.message)).toBe(locale === "en" ? automatic.message
        : "Ожидание завершения восстановления предыдущего запуска. Обработка сообщения начнётся автоматически.");
      expect(JSON.stringify([manual, automatic])).toBe(original);
    }
  });

  it("covers the admission gate's built-in wait sentences while retaining their exact English source", async () => {
    const source = readFileSync(new URL("../../../server/src/services/explicit-native-continuation.ts", import.meta.url), "utf8");
    const messages = [...source.matchAll(/blocked\("[^"]+",\s*"([^"]+)"/g)].map(match => match[1]!);
    expect(messages.length).toBeGreaterThanOrEqual(10);
    await i18n.changeLanguage("en");
    for (const message of messages) expect(queuedMessageWaitMessage(message)).toBe(message);
    await i18n.changeLanguage("ru");
    for (const message of messages) {
      const display = queuedMessageWaitMessage(message);
      expect(display, message).toMatch(/[А-Яа-яЁё]/);
      expect(display, message).not.toContain("sep13QueueMetadata.");
    }
  });

  it("shows pause, daily-limit, budget and agent-state holds in Russian", async () => {
    await i18n.changeLanguage("ru");
    expect(queuedMessageWaitMessage("This task is paused. Resume it to send your saved message.")).toBe("Задача приостановлена. Возобновите её, чтобы отправить сохранённое сообщение.");
    expect(queuedMessageWaitMessage("The agent has reached its daily limit. Your message is saved until work can resume.")).toBe("Агент достиг суточного лимита. Сообщение сохранено до возобновления работы.");
    expect(queuedMessageWaitMessage("Agent is paused because its budget hard-stop was reached.")).toBe("Агент приостановлен: достигнут лимит бюджета для автоматической остановки.");
    expect(queuedMessageWaitMessage("Agent is not invokable because its reporting chain is invalid")).toBe("Агента нельзя запустить: нарушена цепочка подчинения");
  });

  it("preserves unknown messages, provider detail and near-matches verbatim", async () => {
    await i18n.changeLanguage("ru");
    for (const message of [
      "Provider unavailable: Keep English Name",
      "Waiting for execution recovery. Your message is saved. Additional provider detail.",
      " Waiting for execution recovery. Your message is saved.",
      "constructor", "toString", "__proto__", "",
    ]) expect(queuedMessageWaitMessage(message)).toBe(message);
  });
});
