// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import en from "@/i18n/locales/en.json";
import ru from "@/i18n/locales/ru.json";
import { queuedMessageWaitMessage } from "./queued-message-display";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("queuedMessageWaitMessage", () => {
  it.each([
    ["workspace_repair_required", "Verify safe workspace staging or repair before continuing. Your message is saved.", "workspaceRepairRequired"],
    ["cleanup_quarantined", "Send a new message after the previous provider has stopped.", "cleanupQuarantined"],
    ["local_cleanup", "Waiting for the previous provider and its tools to stop. Your message is saved.", "providerStopping"],
    ["local_cleanup", "The previous provider cleanup changed. Your message is saved.", "providerCleanupChanged"],
  ] as const)("projects the exact %s message RU → EN → RU while preserving the saved queue", async (reason, message, key) => {
    const wait = Object.freeze({ reason, message });
    const queue = Object.freeze({ executionWait: wait, body: "RAW saved user message", provider: "OpenAI" });
    const original = JSON.stringify(queue);
    expect(en.sep28TailRuntime.queue[key]).toBe(message);
    for (const locale of ["ru", "en", "ru"]) {
      await i18n.changeLanguage(locale);
      const expected = locale === "ru" ? ru.sep28TailRuntime.queue[key] : message;
      expect(queuedMessageWaitMessage(wait.message)).toBe(expected);
      if (locale === "ru") expect(expected).toMatch(/[А-Яа-яЁё]/);
      for (const unknown of [` ${message}`, `${message} Additional provider detail.`, message.toLowerCase()]) {
        expect(queuedMessageWaitMessage(unknown)).toBe(unknown);
      }
      expect(JSON.stringify(queue)).toBe(original);
    }
  });

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
        : "Ждём, пока завершится восстановление предыдущего запуска. Обработка сообщения начнётся автоматически.");
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
      expect(display, message).not.toContain("sep28TailRuntime.");
    }
  });

  it("shows pause, daily-limit, budget and agent-state holds in Russian", async () => {
    await i18n.changeLanguage("ru");
    expect(queuedMessageWaitMessage("This task is paused. Resume it to send your saved message.")).toBe("Задача приостановлена. Возобновите её, чтобы отправить сохранённое сообщение.");
    expect(queuedMessageWaitMessage("The agent has reached its daily limit. Your message is saved until work can resume.")).toBe("Агент достиг суточного лимита. Сообщение сохранено до возобновления работы.");
    expect(queuedMessageWaitMessage("Agent is paused because its budget hard-stop was reached.")).toBe("Работа агента приостановлена: расходы достигли порога автоматической остановки.");
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
