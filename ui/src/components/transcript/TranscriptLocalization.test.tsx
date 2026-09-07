// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { i18n, t } from "@/i18n";
import { ThemeProvider } from "@/context/ThemeContext";
import type { TranscriptEntry } from "@/adapters";
import { RunTranscriptView } from "./RunTranscriptView";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  await i18n.changeLanguage("en");
});
function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}
describe("Inspector and transcript localization", () => {
  it.each([
    [1, "1 кадр", "Выполнена 1 команда", "1 системное сообщение"],
    [2, "2 кадра", "Выполнено 2 команды", "2 системных сообщения"],
    [5, "5 кадров", "Выполнено 5 команд", "5 системных сообщений"],
    [21, "21 кадр", "Выполнена 21 команда", "21 системное сообщение"],
    [22, "22 кадра", "Выполнено 22 команды", "22 системных сообщения"],
    [25, "25 кадров", "Выполнено 25 команд", "25 системных сообщений"],
  ])("uses Russian count forms for %i", async (count, frames, commands, messages) => {
    await i18n.changeLanguage("ru");
    expect(t("localizationInspector.framesCount", { count })).toBe(frames);
    expect(t("localizationInspector.executedCommands", { count })).toBe(commands);
    expect(t("localizationInspector.systemMessages", { count })).toBe(messages);
  });

  it("updates the default empty message without replacing a caller-supplied message", async () => {
    mount();
    await act(async () => root?.render(<RunTranscriptView entries={[]} />));
    expect(container?.textContent).toBe("No transcript yet.");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container?.textContent).toBe("Расшифровки пока нет.");
    await act(async () => root?.render(<RunTranscriptView entries={[]} emptyMessage="User authored explanation" />));
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container?.textContent).toBe("User authored explanation");
  });

  it("updates mounted transcript chrome and preserves command payloads, raw mode, and result markdown", async () => {
    mount();
    const entries: TranscriptEntry[] = [
      { kind: "tool_call", ts: "2026-08-21T00:00:00.000Z", name: "command_execution", toolUseId: "raw-call-id", input: { command: "echo RAW_PAYLOAD", vendor_field: "untranslated" } },
      { kind: "tool_result", ts: "2026-08-21T00:00:01.000Z", toolUseId: "raw-call-id", toolName: "command_execution", content: "RAW_STDOUT", isError: false },
      { kind: "result", ts: "2026-08-21T00:00:02.000Z", text: "## User result", inputTokens: 10, outputTokens: 20, cachedTokens: 0, costUsd: 0, subtype: "success", isError: false, errors: [] },
    ];
    const snapshot = JSON.stringify(entries);
    const render = (mode: "nice" | "raw") => <ThemeProvider><RunTranscriptView entries={entries} mode={mode} /></ThemeProvider>;
    await act(async () => root?.render(render("nice")));
    expect(container?.textContent).toContain("Executed command");
    expect(container?.querySelector("h2")?.textContent).toBe("User result");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container?.textContent).toContain("Команда выполнена");
    expect(container?.querySelector("h2")?.textContent).toBe("User result");
    expect(container?.querySelector('button[aria-label="Развернуть сведения о командах"]')).not.toBeNull();
    await act(async () => container?.querySelector<HTMLButtonElement>('button[aria-label="Развернуть сведения о командах"]')?.click());
    expect(container?.textContent).toContain("echo RAW_PAYLOAD");
    expect(container?.textContent).toContain("RAW_STDOUT");
    await act(async () => root?.render(render("raw")));
    expect(container?.textContent).toContain("command_execution");
    expect(container?.textContent).toContain("vendor_field");
    expect(container?.textContent).toContain("untranslated");
    expect(container?.textContent).toContain("RAW_STDOUT");
    expect(JSON.stringify(entries)).toBe(snapshot);
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container?.textContent).toContain("command_execution");
    expect(JSON.stringify(entries)).toBe(snapshot);
  });
});
