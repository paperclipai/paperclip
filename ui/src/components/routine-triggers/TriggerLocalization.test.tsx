// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { validateLocaleMessages } from "@/i18n/locale-validation";
import { RoutineActivityRow } from "../RoutineActivityRow";
import { defaultTriggerDraft, RoutineTriggerWizard, webhookAgentInstructions } from "./TriggerWizard";
import { CopyField } from "./WebhookFields";
import { WebhookUrlWarning } from "./WebhookUrlWarning";

const { setBreadcrumbs, copyTextToClipboard } = vi.hoisted(() => ({ setBreadcrumbs: vi.fn(), copyTextToClipboard: vi.fn() }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false, setSidebarOpen: () => {} }) }));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard }));

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.clearAllMocks();
  copyTextToClipboard.mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await i18n.changeLanguage("en");
});

it("keeps the routine catalog structurally compatible with English", () => {
  const english = i18n.getResourceBundle("en", "translation").sep28Routines;
  const russian = i18n.getResourceBundle("ru", "translation").sep28Routines;
  expect(english).toBeDefined();
  expect(russian).toBeDefined();
  expect(validateLocaleMessages(russian, english)).toEqual([]);
});

it("switches weekly labels and breadcrumbs while preserving stored weekday and time zone", async () => {
  const onSaveExit = vi.fn();
  await act(async () => root.render(<RoutineTriggerWizard
    initialDraft={{ ...defaultTriggerDraft, kind: "schedule", frequency: "weekly", step: 1, availableStep: 1, timezone: "Europe/Moscow" }}
    routineTitle="Release review" routineId="routine-1" onSaveExit={onSaveExit} onFinish={() => {}} />));
  const day = container.querySelector<HTMLSelectElement>("#run-day")!;
  expect(day.selectedOptions[0].textContent).toBe("Monday");
  await act(async () => { await i18n.changeLanguage("ru"); });
  expect(day.value).toBe("Monday");
  expect(day.selectedOptions[0].textContent).toBe("Понедельник");
  expect(setBreadcrumbs).toHaveBeenLastCalledWith(expect.arrayContaining([{ label: "Добавить триггер" }]));
  await act(async () => { day.value = "Friday"; day.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(day.selectedOptions[0].textContent).toBe("Пятница");
  const save = [...container.querySelectorAll("button")].find(button => /Сохранить/.test(button.textContent ?? ""))!;
  expect(save, "The shared wizard footer must switch its save label to Russian").toBeDefined();
  await act(async () => save.click());
  expect(onSaveExit).toHaveBeenCalledWith(expect.objectContaining({ weekday: "Friday", timezone: "Europe/Moscow", time: "09:00", frequency: "weekly" }));
});

it("keeps agent instructions and authentication protocols unchanged in Russian", async () => {
  await i18n.changeLanguage("ru");
  const url = "https://example.org/hook?id=123";
  const secret = "test-secret/+=";
  const generic = webhookAgentInstructions("custom", "Meeting digest", url, secret);
  expect(generic).toContain(url);
  expect(generic).toContain(`Authorization: Bearer ${secret}`);
  expect(generic).toContain("X-Hub-Signature or X-Hub-Signature-256");
  expect(generic).toContain("Idempotency-Key");
  expect(generic).toContain('{"event":"deployment.completed","environment":"production"}');
  expect(generic).toContain("They do not start the routine or create a task.");
  const bearer = webhookAgentInstructions("custom", "Meeting digest", url, secret, true, "bearer");
  expect(bearer).toContain(`Authorization: Bearer ${secret}`);
  expect(bearer).not.toContain("HMAC-SHA256");
  const legacy = webhookAgentInstructions("custom", "Meeting digest", url, secret, true, "fireflies_hmac");
  expect(legacy).toContain("X-Hub-Signature");
  expect(legacy).not.toContain("X-Hub-Signature-256");
  expect(legacy).not.toContain("Authorization: Bearer");
  const github = webhookAgentInstructions("github", "Meeting digest", url, secret, false);
  expect(github).toContain("X-Hub-Signature-256");
  expect(github).toContain("This webhook is enabled.");
  expect(github).not.toContain("They do not start the routine");
  await i18n.changeLanguage("en");
  expect(webhookAgentInstructions("custom", "Meeting digest", url, secret)).toBe(generic);
  expect(webhookAgentInstructions("github", "Meeting digest", url, secret, false)).toBe(github);
});

it("keeps a paused routine distinct from an activated webhook at the final step", async () => {
  await i18n.changeLanguage("ru");
  await act(async () => root.render(<RoutineTriggerWizard
    initialDraft={{ ...defaultTriggerDraft, kind: "webhook", step: 2, availableStep: 2, created: true }}
    routineTitle="Digest" routineId="routine-1" routineActive={false} checkResult="received"
    onSaveExit={() => {}} onFinish={() => {}} />));
  expect(container.textContent).toContain("Сценарий приостановлен");
  expect(container.textContent).toContain("Сценарий не запускался, задача не создавалась.");
  expect(container.textContent).not.toContain("Последующие события будут запускать регламент");
});

describe("localized webhook address warnings", () => {
  it.each([
    ["http://localhost:3100/hook", "Адрес localhost недоступен другим приложениям"],
    ["https://10.0.0.4/hook", "Похоже, этот URL вебхука доступен только в частной сети"],
    ["https://paperclip.example.ts.net/hook", "Этот URL Tailscale может быть недоступен из интернета"],
    ["http://example.org/hook", "Используйте HTTPS для вебхуков от других приложений"],
    ["not-a-url", "Проверьте URL вебхука"],
  ])("translates %s without changing its warning category", async (url, expected) => {
    await act(async () => root.render(<WebhookUrlWarning url={url} />));
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain(expected);
    expect(container.querySelector("a")?.href).toBe("https://docs.paperclip.ing/reference/deploy/https/");
  });
});

it("copies the exact secret and updates copy-failure guidance on language change", async () => {
  const value = "secret/+==";
  copyTextToClipboard.mockRejectedValueOnce(new Error("clipboard unavailable"));
  await act(async () => root.render(<CopyField label="Key" value={value} />));
  await act(async () => container.querySelector("button")!.click());
  expect(copyTextToClipboard).toHaveBeenCalledWith(value);
  expect(container.querySelector("textarea")?.value).toBe(value);
  await act(async () => { await i18n.changeLanguage("ru"); });
  expect(container.textContent).toContain("Не удалось скопировать. Выделите и скопируйте текст ниже.");
  expect(container.querySelector("textarea")?.value).toBe(value);
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain("Скопировано");
  expect(copyTextToClipboard).toHaveBeenLastCalledWith(value);
});

it("translates the event presentation and leaves expanded audit data unchanged", async () => {
  const details = { source: "webhook", status: "issue_created", customLabel: "Customer supplied title" };
  await act(async () => root.render(<RoutineActivityRow event={{ id: "event-1", action: "routine.run_triggered", details, createdAt: new Date("2026-09-28T07:00:00Z") }} />));
  await act(async () => { await i18n.changeLanguage("ru"); });
  expect(container.textContent).toContain("Сценарий запущен");
  expect(container.textContent).toContain("Вебхук · Задача создана");
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector("pre")?.textContent).toBe(JSON.stringify(details, null, 2));
});
