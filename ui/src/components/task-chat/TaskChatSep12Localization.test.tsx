// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { TaskChatExpansionState } from "./expansion-state";
import { TaskChatRunnerActivityGroup } from "./TaskChatRunnerActivityGroup";
import { TaskChatPausedTakeover } from "./TaskChatPausedTakeover";
import { TaskChatProjectCreatedCard } from "./TaskChatProjectCreatedCard";
import { TaskChatMarker } from "./TaskChatMarker";
import { TaskChatBubble } from "./TaskChatBubble";
import { TaskChatDescriptionBubble } from "./TaskChatDescriptionBubble";
import { TaskChatRunnerTurn } from "./TaskChatRunnerTurn";
import { TaskChatThreadView } from "./TaskChatThreadView";
import { TaskChatToolCard } from "./TaskChatToolCard";
import { commentsToTaskChatItems, formatTaskChatTimestamp } from "./task-chat-adapter";
import type { IssueChatComment } from "@/lib/issue-chat-messages";
import { completedActivitySummary } from "./completed-activity-summary";
import type { TaskChatActivityPhaseItem, TaskChatProviderActivityItem } from "./task-chat-model";

vi.mock("@/lib/router", async () => import("react-router-dom"));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("September chat localization", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    await i18n.changeLanguage("en");
  });
  const render = (node: ReactNode) => act(async () => {
    root.render(<MemoryRouter><ThemeProvider>{node}</ThemeProvider></MemoryRouter>);
  });
  const locale = (language: string) => act(async () => { await i18n.changeLanguage(language); });

  it("formats footer times at the rendering boundary while keeping canonical comments and mounted turns unchanged", async () => {
    const date = new Date(2026, 8, 12, 14, 34);
    const comments = [{ id: "time-comment", body: "Original message", authorType: "user", createdAt: date } as unknown as IssueChatComment];
    const [message] = commentsToTaskChatItems(comments);
    if (message.kind !== "message") throw new Error("Expected message");
    const rawBefore = JSON.stringify(message);
    const englishTime = formatTaskChatTimestamp(date)!;
    const attachedMessage = { ...message, id: "attached-message", author: "agent" as const,
      attachedTurn: { id: "attached-turn", kind: "turn" as const, settled: true,
        summary: { toolCount: 1, added: 0, removed: 0 },
        items: [{ id: "attached-tool", kind: "tool" as const, name: "read", status: "completed" as const, target: "README.md" }],
      },
    };
    const onSave = vi.fn();
    await render(<>
      <div data-time-case="plain"><TaskChatBubble item={message} /></div>
      <div data-time-case="attached"><TaskChatThreadView items={[attachedMessage]} scroll={false} /></div>
      <div data-time-case="description"><TaskChatDescriptionBubble brief={{ description: "Original description", author: "human", createdAt: date, onSave }} /></div>
      <div data-time-case="runner"><TaskChatRunnerTurn status="succeeded" startedAtMs={date.getTime() - 1000} finishedAtMs={date.getTime()} items={[
        { id: "streamed-final", kind: "message", author: "agent", text: "Original final answer", channel: "final", atMs: date.getTime() },
      ]} /></div>
      <div data-time-case="opaque"><TaskChatBubble item={{ id: "opaque", kind: "message", author: "agent", text: "Opaque source", timestamp: "Provider timestamp stays raw" }} /></div>
    </>);
    const summary = host.querySelector<HTMLButtonElement>('[data-testid="task-chat-turn-summary"]')!;
    await act(async () => summary.click());
    const bubble = host.querySelector('[data-time-case="plain"] [data-testid="task-chat-human-bubble"]');
    const final = host.querySelector('[data-testid="task-chat-final-response"]');
    for (const language of ["en", "ru", "en"]) {
      await locale(language);
      const expected = language === "ru" ? "14:34" : englishTime;
      for (const surface of ["plain", "attached", "description", "runner"]) {
        expect(host.querySelector(`[data-time-case="${surface}"]`)?.textContent).toContain(expected);
      }
      expect(host.querySelector('[data-time-case="plain"] [data-testid="task-chat-human-bubble"]')).toBe(bubble);
      expect(host.querySelector('[data-testid="task-chat-final-response"]')).toBe(final);
      expect(host.querySelector('[data-testid="task-chat-turn-summary"]')).toBe(summary);
      expect(summary.getAttribute("aria-expanded")).toBe("true");
      expect(host.querySelector('[data-time-case="opaque"]')?.textContent).toContain("Provider timestamp stays raw");
      expect(JSON.stringify(message)).toBe(rawBefore);
      expect(commentsToTaskChatItems(comments)[0]).toEqual(message);
      expect(onSave).not.toHaveBeenCalled();
    }
  });

  it("renders the declared rejected permission without changing its icon, detail or protocol value", async () => {
    const item = { id: "rejected-tool", kind: "tool" as const, name: "exec_command", status: "failed" as const,
      decision: "rejected" as const, detail: "Provider declined the request", target: "raw-command" };
    await render(<TaskChatToolCard item={item} />);
    const button = host.querySelector<HTMLButtonElement>("button")!;
    await act(async () => button.click());
    const shield = host.querySelector(".lucide-shield-x");
    for (const language of ["en", "ru", "en"]) {
      await locale(language);
      expect(host.querySelector("button")).toBe(button);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(button.textContent).toContain(language === "ru" ? "отклонено" : "rejected");
      expect(host.querySelector(".lucide-shield-x")).toBe(shield);
      expect(host.textContent).toContain("Provider declined the request");
      expect(host.textContent).toContain("raw-command");
      expect(item.decision).toBe("rejected");
    }
  });

  it("preserves canonical category identity, expanded history and raw provider details through EN–RU–EN", async () => {
    const native: TaskChatProviderActivityItem = {
      id: "native", kind: "protocol", surface: "provider_activity", family: "tool_execution",
      title: "Provider title", status: "completed", eventType: "tool.finished",
      details: [{ label: "Name", value: "tool" }, { label: "Operation", value: "execute" }, { label: "Target", value: "do-not-translate" }],
      steps: [], links: [], children: [],
    };
    const items: TaskChatActivityPhaseItem["items"] = [
      { id: "read-failed", kind: "tool", name: "read", status: "failed", detail: "Read failed: provider response" },
      { id: "read", kind: "tool", name: "read", status: "completed", target: "README.md", detail: "Read files" },
      { id: "command", kind: "tool", name: "exec_command", status: "failed", decision: "rejected", detail: "Permission denied by provider" },
      native,
      { ...native, id: "research", family: "research", details: [{ label: "Query", value: "Search query" }] },
    ];
    const rawBefore = JSON.stringify(items);
    const memory = new Map<string, boolean>();
    await render(<TaskChatExpansionState.Provider value={memory}>
      <TaskChatRunnerActivityGroup item={{ id: "stable-group", kind: "activity_phase", active: false, summary: "", items }} />
    </TaskChatExpansionState.Provider>);
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="task-chat-activity-phase-toggle"]')!;
    await act(async () => toggle.click());
    const providerButton = host.querySelector<HTMLButtonElement>('[data-activity-item-id="native"] button')!;
    const commandButton = host.querySelector<HTMLButtonElement>('[data-activity-item-id="command"] button')!;
    await act(async () => { providerButton.click(); commandButton.click(); });
    const detail = host.querySelector('[data-activity-item-id="native"] [data-testid="task-chat-runner-activity-detail"]');
    for (const language of ["en", "ru", "en"]) {
      await locale(language);
      expect(host.querySelector('[data-testid="task-chat-activity-phase-toggle"]')).toBe(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(host.querySelector('[data-activity-item-id="native"] [data-testid="task-chat-runner-activity-detail"]')).toBe(detail);
      expect(providerButton.getAttribute("aria-expanded")).toBe("true");
      expect(toggle.textContent).toContain(language === "ru" ? "Прочитаны файлы, запущены команды, выполнен поиск в интернете" : "Read files, ran commands, searched the web");
      expect(toggle.textContent).toContain(language === "ru" ? "5 действий" : "5 activities");
      expect(host.textContent).toContain("Permission denied by provider");
      expect(host.querySelector('[data-activity-item-id="command"] [data-testid="task-chat-runner-activity-detail"]')?.textContent).toContain(language === "ru" ? "В разрешении отказано" : "Permission rejected");
      expect(detail?.textContent).toContain("do-not-translate");
      expect(detail?.textContent).toContain("execute");
      expect(detail?.querySelector("dt")?.textContent).toBe(language === "ru" ? "Название" : "Name");
      expect(JSON.stringify(items)).toBe(rawBefore);
      expect(completedActivitySummary(items).label).toBe("Read files, ran commands, searched the web");
    }
    expect(memory.get("stable-group")).toBe(true);
    expect(memory.get("runner-detail:native")).toBe(true);
  });

  it("keeps the active reasoning row mounted when the language changes", async () => {
    await render(<TaskChatRunnerActivityGroup item={{
      id: "thinking-group", kind: "activity_phase", active: true, summary: "",
      items: [{ id: "thought", kind: "thinking", streaming: true, lines: ["Provider reasoning stays English"] }],
    }} />);
    const row = host.querySelector('[data-activity-row="thought"]');
    await locale("ru");
    expect(host.querySelector('[data-activity-row="thought"]')).toBe(row);
    expect(row?.textContent).toContain("Provider reasoning stays English");
    expect(row?.textContent).not.toContain("Thinking");
    expect(host.querySelector(".runner-activity-roll-in,.runner-activity-roll-out")).toBeNull();
    await locale("en");
    expect(host.querySelector('[data-activity-row="thought"]')).toBe(row);
    expect(row?.textContent).toContain("Thinking");
  });

  it.each([[1, "1 действие"], [2, "2 действия"], [5, "5 действий"], [21, "21 действие"], [1.5, "1.5 действия"]])(
    "selects Russian activity forms with numeric count %s", async (count, expected) => {
      await locale("ru");
      expect(i18n.t("sep12Chat.activity.count", { count: Number(count) })).toBe(expected);
    },
  );

  it("retranslates pause, project and session surfaces without changing names, URLs, errors or callbacks", async () => {
    const resume = vi.fn();
    await render(<>
      <TaskChatPausedTakeover scope="leaf" hasDraft error="Raw provider error" onResume={resume} />
      <TaskChatPausedTakeover scope="subtree" resumeHref="/issues/parent-raw" />
      <TaskChatProjectCreatedCard item={{ id: "project-event", kind: "project_created", projectId: "project-raw", name: "Project created", description: "Task is paused.", repositories: [{ id: "repo", name: "Raw repository", url: "https://example.com/repo" }], timestamp: "2026-09-12T00:00:00Z" }} />
      <TaskChatMarker item={{ id: "new-session", kind: "marker", variant: "session_start", label: "New session", detail: "Earlier messages and files are still available." }} />
      <TaskChatMarker item={{ id: "execution-wait", kind: "marker", variant: "interrupted", tone: "neutral", label: "Waiting to resume", detail: "The previous execution needs to be checked before work can continue. See the task’s execution hold for the next action. Individual checks remain in the run history." }} />
    </>);
    const resumeButton = host.querySelector<HTMLButtonElement>("button")!;
    const projectLink = host.querySelector('a[href="/projects/project-raw"]');
    for (const language of ["en", "ru", "en"]) {
      await locale(language);
      expect(host.querySelector("button")).toBe(resumeButton);
      expect(resumeButton.textContent).toBe(language === "ru" ? "Возобновить задачу" : "Resume task");
      expect(host.textContent).toContain(language === "ru" ? "Черновик сохранён." : "Your draft is saved.");
      expect(host.textContent).toContain(language === "ru" ? "Новый сеанс" : "New session");
      expect(host.textContent).toContain(language === "ru" ? "Предыдущие сообщения и файлы по-прежнему доступны." : "Earlier messages and files are still available.");
      expect(host.textContent).toContain(language === "ru" ? "Ожидание возобновления" : "Waiting to resume");
      expect(host.querySelector("article")?.getAttribute("aria-label")).toBe(language === "ru" ? "Создан проект: Project created" : "Project created: Project created");
      expect(host.querySelector('a[href="/projects/project-raw"]')).toBe(projectLink);
      expect(projectLink?.textContent).toBe("Project created");
      expect(host.querySelector("article p.line-clamp-3")?.textContent).toBe("Task is paused.");
      expect(host.querySelector('a[href="/issues/parent-raw"]')).not.toBeNull();
      expect(host.querySelector('a[href="https://example.com/repo"]')?.textContent).toBe("Raw repository");
      expect(host.querySelector('[role="alert"]')?.textContent).toBe("Raw provider error");
      expect(resume).not.toHaveBeenCalled();
    }
    await act(async () => resumeButton.click());
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
