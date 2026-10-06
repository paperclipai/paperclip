// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TaskBrowser } from "@paperclipai/shared";
import { i18n, t, useTranslation } from "@/i18n";
import { agentsApi } from "@/api/agents";
import { InstructionHistory } from "./InstructionHistory";
import { ToastProvider, useToastActions, useToastState } from "@/context/ToastContext";
import { AgentSetupPrompt } from "./AgentSetupPrompt";
import { TaskViewsMenu } from "./TaskViewsMenu";
import { TaskBrowserActivity } from "./task-side-panel/TaskBrowserActivity";
import { SkillImportProgress } from "@/pages/skills/SkillImportProgress";
import { artifactFileSize, parseArtifactCsv } from "@/lib/artifact-card-data";
import { taskView, taskViewPath } from "@/lib/task-views";
import { executionRecoveryText } from "@/lib/recovery-display";
import { EFFORT_LABELS, mergeComposerRunSettings } from "./task-chat/composer-run-settings";
import { taskChatDisplayLabel } from "./task-chat/task-chat-display";
import { copyTextToClipboard } from "@/lib/clipboard";

vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

describe("October 5 core presentation", () => {
  it("updates saved toast getters in place without changing their identity or replaying the action", async () => {
    let actions!: ReturnType<typeof useToastActions>;
    function ToastHarness() {
      useTranslation();
      actions = useToastActions();
      const toasts = useToastState();
      return <>{toasts.map(toast => <p key={toast.id} data-id={toast.id}>{toast.title} {toast.body}</p>)}</>;
    }
    await act(async () => root.render(<ToastProvider><ToastHarness /></ToastProvider>));
    await act(async () => { actions.pushToast({
      id: "archived-RAW",
      get title() { return t("oct5Core.companyArchived", { name: "RAW company" }); },
      get body() { return t("oct5Core.switchedCompany", { name: "Next RAW" }); },
      ttlMs: 15000,
    }); });
    const toast = host.querySelector("p");
    for (const language of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      expect(host.querySelector("p")).toBe(toast);
      expect(host.querySelectorAll("p")).toHaveLength(1);
      expect(toast?.getAttribute("data-id")).toBe("archived-RAW");
      expect(toast?.textContent).toContain(language === "ru" ? "Компания «RAW company» в архиве" : "RAW company is archived");
      expect(toast?.textContent).toContain(language === "ru" ? "Вы перешли в компанию «Next RAW»." : "Switched to Next RAW.");
    }
  });

  it("keeps instruction revision and diff text intact while translating the open history", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const revision = { id: "revision_current", source: "board", createdAt: "2026-10-01T12:00:00Z" };
    client.setQueryData(["instruction-history", "agent_RAW", "RAW/SKILL.md", "revision_current"], {
      pages: [{ revisions: [revision], nextCursor: null }], pageParams: [undefined],
    });
    client.setQueryData(["instruction-diff", "agent_RAW", "RAW/SKILL.md", "revision_current", "revision_current"], {
      from: { content: "Original {{RAW_instruction}}" }, removed: "Removed user data", added: "Added user data",
    });
    const history = vi.spyOn(agentsApi, "instructionHistory");
    const diff = vi.spyOn(agentsApi, "instructionDiff");
    const restore = vi.spyOn(agentsApi, "restoreInstructions");
    const onRestored = vi.fn();
    await act(async () => root.render(<QueryClientProvider client={client}><InstructionHistory agentId="agent_RAW" path="RAW/SKILL.md" currentRevisionId="revision_current" disabled={false} onRestored={onRestored} /></QueryClientProvider>));
    await act(async () => host.querySelector("button")!.click());
    await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "revision")!.click());
    const original = host.querySelector("pre");
    for (const language of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      expect(host.querySelector("pre")).toBe(original);
      expect(original?.textContent).toBe("Original {{RAW_instruction}}");
      expect(host.textContent).toContain(language === "ru" ? "Текущая версия" : "Current");
      expect(host.textContent).toContain(language === "ru" ? "Удалено:\nRemoved user data" : "Removed:\nRemoved user data");
      expect(host.textContent).toContain(language === "ru" ? "Добавлено:\nAdded user data" : "Added:\nAdded user data");
      expect(revision.source).toBe("board");
      expect(history).not.toHaveBeenCalled();
      expect(diff).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
      expect(onRestored).not.toHaveBeenCalled();
    }
    await act(async () => root.render(null));
    client.clear();
  });

  it("translates a mounted browser without changing its identity, callback or model label", async () => {
    const browser: TaskBrowser = Object.freeze({ id: "browser_RAW", sessionId: "session_RAW", issueId: "task_RAW", status: "idle", runStatus: "completed", progress: null, error: null, costCents: 0, idleDeadline: null, expiresAt: null, createdAt: "2026-09-29T00:00:00Z" });
    const onOpen = vi.fn();
    await act(async () => root.render(<TaskBrowserActivity browser={browser} label="Browser 2" onOpen={onOpen} />));
    const button = host.querySelector("button");
    for (const language of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      expect(host.textContent).toContain(language === "ru" ? "Браузер 2" : "Browser 2");
      expect(button?.textContent).toBe(language === "ru" ? "Открыть браузер" : "Open browser");
      expect(host.querySelector("button")).toBe(button);
      expect(browser.id).toBe("browser_RAW");
      expect(browser.status).toBe("idle");
      expect(onOpen).not.toHaveBeenCalled();
    }
    await act(async () => button!.click());
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("browser_RAW");
  });

  it("keeps the task-view selection and persisted route stable on language changes", async () => {
    const onChange = vi.fn();
    const view = taskView("unread");
    await act(async () => root.render(<TaskViewsMenu value="unread" onChange={onChange} />));
    const trigger = host.querySelector("button");
    for (const language of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      expect(trigger?.textContent).toContain(language === "ru" ? "Непрочитанные" : "Unread");
      expect(taskView("unread")).toBe(view);
      expect(taskViewPath("unread")).toBe("/issues?view=unread");
      expect(host.querySelector("button")).toBe(trigger);
      expect(onChange).not.toHaveBeenCalled();
    }
  });

  it("keeps the setup preview open and the raw clipboard prompt unchanged", async () => {
    vi.mocked(copyTextToClipboard).mockRejectedValue(new Error("clipboard denied"));
    const prompt = "User text {{do_not_translate}}\nhttps://example.test/api\nSKILL.md";
    await act(async () => root.render(<AgentSetupPrompt prompt={prompt} />));
    await act(async () => host.querySelector("button")!.click());
    const dialog = document.querySelector('[role="dialog"]');
    const input = dialog?.querySelector("textarea");
    expect(input?.value).toBe(prompt);
    for (const language of ["ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      expect(host.querySelector("button")?.getAttribute("aria-label")).toBe(language === "ru" ? "Настроить с помощью агента" : "Set up with an agent");
      expect(document.querySelector('[role="dialog"]')).toBe(dialog);
      expect(dialog?.querySelector("textarea")).toBe(input);
      expect(input?.value).toBe(prompt);
      expect(copyTextToClipboard).toHaveBeenCalledExactlyOnceWith(prompt);
    }
  });

  it.each([[1, "1 файл"], [2, "2 файла"], [5, "5 файлов"], [21, "21 файл"]] as const)("uses Russian file plurals for %s without translating repository content", async (count, label) => {
    await act(async () => root.render(<SkillImportProgress repository="owner/RAW-repository" importing count={count} found={[{ path: "tools/SKILL.md", name: "Raw skill title", description: null, fileCount: count, error: null }]} />));
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(host.textContent).toContain(label);
    expect(host.textContent).toContain("owner/RAW-repository");
    expect(host.textContent).toContain("Raw skill title");
    expect(host.textContent).toContain("tools/SKILL.md");
  });

  it("retranslates cached CSV failures and numbers without refetching or changing parsed cells", async () => {
    let error: Error | undefined;
    try { parseArtifactCsv('header\n"unterminated'); } catch (caught) { error = caught as Error; }
    const cells = parseArtifactCsv("RAW_header\nRAW_cell");
    for (const language of ["ru", "en", "ru"]) {
      await i18n.changeLanguage(language);
      expect(error?.message).toBe(language === "ru" ? "Не удалось открыть предпросмотр CSV. Скачайте файл, чтобы просмотреть его." : "CSV could not be previewed. Download the file to view it.");
      expect(artifactFileSize(1536)).toBe(language === "ru" ? "1,5 КБ" : "1.5 KB");
      expect(cells).toEqual({ columns: ["RAW_header"], rows: [["RAW_cell"]], truncated: false });
    }
  });

  it("projects built-in effort and tool labels but keeps protocol keys and custom text raw", async () => {
    const settings = { model: "model/RAW", effort: "high", fast: false };
    const before = mergeComposerRunSettings(null, "codex_local", settings);
    for (const language of ["ru", "en"]) {
      await i18n.changeLanguage(language);
      expect(EFFORT_LABELS.high).toBe(language === "ru" ? "Высокая" : "High");
      expect(taskChatDisplayLabel("Naming the task")).toBe(language === "ru" ? "Задаём название задачи…" : "Naming the task");
      expect(taskChatDisplayLabel("Custom: Naming the task")).toBe("Custom: Naming the task");
      expect(mergeComposerRunSettings(null, "codex_local", settings)).toEqual(before);
      expect(before?.adapterConfig).toMatchObject({ model: "model/RAW", modelReasoningEffort: "high" });
    }
  });

  it("only projects complete known recovery notices, retaining unknown diagnostics", async () => {
    const base = "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.";
    const suffix = "Try again or send a new message to continue once the previous execution has stopped.";
    await i18n.changeLanguage("ru");
    expect(executionRecoveryText(base + " " + suffix)).toContain("действия с неподтверждённым результатом");
    expect(executionRecoveryText(base + " " + suffix)).toContain("после остановки предыдущего выполнения");
    expect(executionRecoveryText("Custom: " + base + " " + suffix)).toBe("Custom: " + base + " " + suffix);
    expect(executionRecoveryText("Provider RAW_error /private/path")).toBe("Provider RAW_error /private/path");
  });
});
