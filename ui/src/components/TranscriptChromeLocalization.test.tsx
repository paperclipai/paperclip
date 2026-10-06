// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, t, useTranslation } from "@/i18n";
import {
  describeToolInput, displayToolName, formatToolPayload, parseSystemActivity,
  parseToolPayload, summarizeNotice, summarizeToolInput, summarizeToolResult,
  toolInputDetailDisplay,
} from "@/lib/transcriptPresentation";
import { HoneycombRunLink } from "./HoneycombRunLink";

const mocks = vi.hoisted(() => ({ buildUrl: vi.fn(async () => "https://example.invalid/?query=task.run&run=RAW_ID") }));
vi.mock("@/lib/honeycomb-run-link", () => ({ buildHoneycombRunUrl: mocks.buildUrl }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  mocks.buildUrl.mockClear();
  await i18n.changeLanguage("en");
});
async function locale(language: "en" | "ru") { await act(async () => { await i18n.changeLanguage(language); }); }
async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
}

describe("Transcript display localization", () => {
  it.each([
    [undefined, "Просмотреть входные данные RAW_TOOL"],
    [{}, "Нет входных данных RAW_TOOL"],
    [{ raw_field: { a: 1 } }, "Данные поля raw_field"],
    [{ a: 1, b: true }, "2 поля: a, b"],
    [{ paths: ["/RAW_1", "/RAW_2"] }, "2 пути, первый: /RAW_1"],
  ])("translates own input summaries for %j", async (input, expected) => {
    const before = JSON.stringify(input);
    await locale("ru");
    expect(summarizeToolInput("RAW_TOOL", input)).toBe(expected);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([
    [1, "1 путь", "1 поле"],
    [2, "2 пути", "2 поля"],
    [5, "5 путей", "5 полей"],
    [21, "21 путь", "21 поле"],
    [22, "22 пути", "22 поля"],
    [25, "25 путей", "25 полей"],
    [1.5, "1,5 пути", "1,5 поля"],
  ])("uses Russian plural and number forms for %s", async (count, paths, fields) => {
    await locale("ru");
    const value = new Intl.NumberFormat(i18n.resolvedLanguage).format(count);
    expect(t("localizationTranscriptChrome.pathsSummary", { count, value, first: "/RAW" })).toBe(`${paths}, первый: /RAW`);
    expect(t("localizationTranscriptChrome.fieldsSummary", { count, value, fields: "raw_key" })).toBe(`${fields}: raw_key`);
    expect(t("localizationTranscriptChrome.morePaths", { count, value, paths: "/RAW" })).toBe(`/RAW, ещё ${paths}`);
  });

  it.each([
    [undefined, true, "Сбой инструмента"],
    [undefined, false, "Ожидание результата"],
    ["status: completed", false, "Завершено"],
    ["status: failed\nexit_code: 137", true, "Ошибка, код выхода: 137"],
    ["status: error", true, "Ошибка"],
    ["status: failed\nexit_code: RAW_CODE", true, "Ошибка, код выхода: RAW_CODE"],
  ])("translates known structured result chrome for %s", async (result, error, expected) => {
    await locale("ru");
    expect(summarizeToolResult(result, error)).toBe(expected);
  });

  it("preserves raw output, intent, custom tool names and canonical payload helpers", async () => {
    const data = { description: "Waiting for result", command: "zsh -lc 'echo RAW'", cwd: "/RAW_DIR" };
    const details = describeToolInput("shell", data);
    const text = '{"raw_key":"Tool failed","number":1.5}';
    const before = JSON.stringify(data);
    await locale("ru");
    expect(summarizeToolInput("shell", data)).toBe("Waiting for result");
    expect(summarizeToolResult("status: failed\nexit_code: 1\n\nRAW_PROVIDER_OUTPUT\nNEXT", true)).toBe("RAW_PROVIDER_OUTPUT");
    expect(summarizeToolResult("Tool failed", true)).toBe("Tool failed");
    expect(displayToolName("RAW_CUSTOM_TOOL", {})).toBe("RAW CUSTOM TOOL");
    expect(displayToolName("shell", data)).toBe("Выполнение команды");
    expect(describeToolInput("shell", data)).toEqual(details);
    expect(details[0]?.label).toBe("Intent");
    expect(parseToolPayload(text)).toEqual({ raw_key: "Tool failed", number: 1.5 });
    expect(JSON.parse(formatToolPayload(text))).toEqual({ raw_key: "Tool failed", number: 1.5 });
    expect(parseSystemActivity("item started: raw_activity (id=RAW_ID)")).toEqual({ status: "running", name: "Raw Activity", activityId: "RAW_ID" });
    expect(summarizeNotice(" RAW_NOTICE ")).toBe("RAW_NOTICE");
    expect(JSON.stringify(data)).toBe(before);
  });

  it("localizes detail display without changing canonical labels or Intent selection", async () => {
    const input = { description: "RAW_INTENT", command: "echo RAW", cwd: "/RAW_DIR", prompt: "RAW_PROMPT", pattern: "RAW.*", paths: ["/A", "/B", "/C", "/D", "/E"] };
    const details = describeToolInput("shell", input);
    const before = JSON.stringify(details);
    await locale("ru");
    const display = details.map((detail) => toolInputDetailDisplay(detail, input));
    expect(display.map((detail) => detail.label)).toEqual(["Назначение", "Каталог", "Промпт", "Шаблон", "Пути"]);
    expect(display.find((detail) => detail.label === "Пути")?.value).toBe("/A, /B, /C, ещё 2 пути");
    expect(display.find((detail) => detail.label === "Промпт")?.value).toBe("RAW_PROMPT");
    expect(details.find((detail) => detail.label === "Intent")?.value).toBe("RAW_INTENT");
    expect(JSON.stringify(details)).toBe(before);
    expect(toolInputDetailDisplay({ label: "Paths", value: "/A, /B, /C, +999 more" }, input).value).toBe("/A, /B, /C, +999 more");
    expect(toolInputDetailDisplay({ label: "RAW_LABEL", value: "RAW_VALUE" }, input)).toEqual({ label: "RAW_LABEL", value: "RAW_VALUE" });
  });

  it("updates a mounted transcript summary and open detail display without rewriting drafts", async () => {
    const input = { paths: ["/A", "/B", "/C", "/D"] };
    function Surface() {
      useTranslation();
      const [open, setOpen] = useState(false);
      const [draft, setDraft] = useState("RAW_DRAFT");
      const details = describeToolInput("RAW_TOOL", input);
      return <div>
        <button onClick={() => setOpen(!open)}>{summarizeToolInput("RAW_TOOL", input)}</button>
        <input aria-label="raw draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
        {open && details.map((detail) => {
          const display = toolInputDetailDisplay(detail, input);
          return <p key={detail.label}>{display.label}: {display.value}</p>;
        })}
      </div>;
    }
    await mount(<Surface />);
    await act(async () => container!.querySelector("button")!.click());
    const inputElement = container!.querySelector("input")!;
    await locale("ru");
    expect(container!.textContent).toContain("4 пути, первый: /A");
    expect(container!.textContent).toContain("Пути: /A, /B, /C, ещё 1 путь");
    expect(container!.querySelector("input")).toBe(inputElement);
    expect(inputElement.value).toBe("RAW_DRAFT");
    await locale("en");
    expect(container!.textContent).toContain("/A, /B, /C, +1 more");
  });

  it("updates Honeycomb labels without rebuilding or changing the trace URL", async () => {
    await mount(<HoneycombRunLink runId="RAW_ID" enabled />);
    const link = container!.querySelector("a")!;
    const href = link.href;
    expect(link.textContent).toContain("View in Honeycomb");
    await locale("ru");
    expect(link.textContent).toContain("Открыть в Honeycomb");
    expect(link.title).toBe("Открыть запрос трассировки task.run этого запуска в Honeycomb");
    expect(link.href).toBe(href);
    expect(mocks.buildUrl).toHaveBeenCalledExactlyOnceWith("RAW_ID");
    await locale("en");
    expect(link.textContent).toContain("View in Honeycomb");
    expect(link.href).toBe(href);
  });
});
