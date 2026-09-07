// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, useTranslation } from "@/i18n";
import { ThemeProvider } from "@/context/ThemeContext";
import { SystemNotice } from "../SystemNotice";
import { TaskChatStatusPill } from "./TaskChatStatusPill";
import { QuestionForm } from "./QuestionForm";
import { turnSummaryText } from "./TaskChatTurn";
import { taskChatDurationLabel, taskChatTokenLabel, taskChatToolActivityLabel } from "./task-chat-display";
import { humanizeSystemNotice, humanizeSystemNoticeDisplay } from "@/lib/system-notice-humanizer";
import { mapCommentMetadataToSystemNoticeSections } from "@/lib/system-notice-comment";
import { issueChatRunLabelDisplay, formatDurationWords } from "@/lib/issue-chat-messages";
import { nextWorkMode, workModeMetaList, titleForPendingWorkMode } from "@/lib/work-mode-meta";
import { issueReviewPolicyBadge, readIssueReviewPolicyMetadata } from "@/lib/review-policy";
import { fileKindForAttachment, fileKindForAttachmentDisplay, formatFileSize, formatFileSizeDisplay } from "./task-chat-attachments";
import { toolActivityPresentation } from "./tool-taxonomy";
import { TASK_PROTOCOL_EVENT_SURFACE_REGISTRY, taskProtocolRationaleDisplay } from "./task-protocol-surfaces";
import type { TaskChatStatusItem } from "./task-chat-model";
import type { IssueCommentMetadata } from "@paperclipai/shared";
import type { PaperclipQuestionSet } from "@paperclipai/adapter-utils";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("task runtime live localization", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    await i18n.changeLanguage("en");
  });
  async function render(node: ReactNode) {
    await act(async () => root.render(<ThemeProvider>{node}</ThemeProvider>));
  }
  async function locale(language: string) {
    await act(async () => { await i18n.changeLanguage(language); });
  }

  it("keeps expanded raw system metadata and links through ru → en → ru", async () => {
    const metadata: IssueCommentMetadata = { version: 1, sections: [{
      title: "Recovery", rows: [
        { type: "key_value", label: "Recovery action", value: "action-raw-123" },
        { type: "agent_link", label: "Recovery owner", agentId: "agent-raw", name: "Keep English Name" },
        { type: "run_link", label: "Source run", runId: "run-raw", agentId: "agent-raw", title: "succeeded" },
      ],
    }] };
    const sections = mapCommentMetadataToSystemNoticeSections(metadata);
    await render(<SystemNotice tone="danger" label="No live execution path" body="Keep stored English body." metadata={sections} />);
    const button = host.querySelector("button")!;
    await act(async () => button.click());
    const details = host.querySelector("#" + button.getAttribute("aria-controls"))!;
    const link = host.querySelector('a[href="/agents/agent-raw"]')!;
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      expect(host.querySelector("button")).toBe(button);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(host.contains(details)).toBe(true);
      expect(host.querySelector('a[href="/agents/agent-raw"]')).toBe(link);
      expect(host.textContent).toContain(language === "ru" ? "Нет активного пути выполнения" : "No live execution path");
      expect(host.textContent).toContain(language === "ru" ? "Ответственный за восстановление" : "Recovery owner");
      expect(host.textContent).toContain(language === "ru" ? "Скрыть подробности" : "Hide details");
      expect(host.textContent).toContain("Keep stored English body.");
      expect(host.textContent).toContain("Keep English Name");
      expect(host.textContent).toContain("action-raw-123");
      expect(mapCommentMetadataToSystemNoticeSections(metadata)).toEqual(sections);
      expect(sections[0]!.rows[0]!.label).toBe("Recovery action");
    }
  });

  it("retains choice filters and selections and submits only raw question IDs", async () => {
    const submit = vi.fn(async () => undefined);
    const questionSet: PaperclipQuestionSet = {
      schema: "paperclip.question_set.v1",
      questions: [{
        id: "region", prompt: "Keep English question?", answerMode: "multi_select", required: true,
        options: Array.from({ length: 9 }, (_, index) => ({ id: "region-" + index, label: index === 0 ? "West" : "Region " + index })),
      }],
    };
    await render(<QuestionForm id="request-raw" questionSet={questionSet} onSubmit={submit} />);
    const selected = host.querySelector<HTMLButtonElement>('button[role="checkbox"]')!;
    await act(async () => selected.click());
    const filter = host.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filter, "West");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      expect(host.querySelector("input")).toBe(filter);
      expect(filter.value).toBe("West");
      expect(filter.getAttribute("aria-label")).toBe(language === "ru" ? "Фильтр вариантов для вопроса «Keep English question?»" : "Filter choices for Keep English question?");
      expect(host.querySelector('button[role="checkbox"]')).toBe(selected);
      expect(selected.getAttribute("aria-checked")).toBe("true");
      expect(host.textContent).toContain("Keep English question?");
      expect(host.textContent).toContain(language === "ru" ? "Отправить ответы" : "Submit answers");
    }
    const button = [...host.querySelectorAll("button")].find(item => item.textContent?.trim() === "Отправить ответы")!;
    await act(async () => button.click());
    expect(submit).toHaveBeenCalledWith({ schema: "paperclip.question_response.v1", answers: { region: { selectedOptionIds: ["region-0"] } } });
  });

  it("updates approval text but leaves decision IDs and taxonomy icons untouched", async () => {
    const approve = vi.fn();
    const item: TaskChatStatusItem = {
      id: "permission-raw", kind: "status", status: "awaiting_approval", label: "Awaiting approval",
      approval: { toolName: "mcp__server__read_file", options: [{ id: "allow_once", label: "Allow once", kind: "allow_once" }] },
    };
    await render(<TaskChatStatusPill item={item} onApprovalDecision={approve} />);
    const button = host.querySelector("button")!;
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      expect(host.querySelector("button")).toBe(button);
      expect(host.textContent).toContain(language === "ru" ? "Ожидание согласования" : "Awaiting approval");
      expect(button.textContent).toBe(language === "ru" ? "Разрешить один раз" : "Allow once");
      expect(item.status).toBe("awaiting_approval");
    }
    await act(async () => button.click());
    expect(approve).toHaveBeenCalledWith("allow_once");
  });

  it("refreshes getters and display projections while preserving recognition and raw formatting", async () => {
    const notice = { body: "The task has no live execution path. Recovery owner: [Keep Name](/agents/a)" };
    const rawNotice = humanizeSystemNotice(notice);
    const attachment = { name: "unknown", url: "/api/attachments/raw/content", contentType: "text/plain" };
    const rawKind = fileKindForAttachment(attachment);
    const rawTool = toolActivityPresentation({ name: "Read" });
    const registry = TASK_PROTOCOL_EVENT_SURFACE_REGISTRY["workspace.change.updated"]!;
    function Labels() {
      useTranslation();
      return <div>
        {workModeMetaList().map(mode => <span key={mode.value} title={titleForPendingWorkMode(mode.value)}>{mode.label}</span>)}
        <p>{issueReviewPolicyBadge("human_only")?.label}</p>
        <p>{humanizeSystemNoticeDisplay(notice).title}</p>
        <p>{fileKindForAttachmentDisplay(attachment).label}</p>
        <p>{taskProtocolRationaleDisplay(registry)}</p>
      </div>;
    }
    await render(<Labels />);
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      expect(host.textContent).toContain(language === "ru" ? "Автоматический режим" : "Auto mode");
      expect(host.textContent).toContain(language === "ru" ? "Задача приостановлена: ожидается Keep Name" : "Task paused — waiting on Keep Name");
      expect(host.textContent).toContain(language === "ru" ? "Текст" : "Text");
      expect(nextWorkMode("ask")).toBe("standard");
      expect(workModeMetaList().map(mode => mode.value)).toEqual(["standard", "planning", "ask"]);
      expect(readIssueReviewPolicyMetadata({ reviewPolicy: "human_only" })).toBe("human_only");
      expect(humanizeSystemNotice(notice)).toEqual(rawNotice);
      expect(fileKindForAttachment(attachment)).toEqual(rawKind);
      expect(fileKindForAttachmentDisplay(attachment).icon).toBe(rawKind.icon);
      expect(toolActivityPresentation({ name: "Read" })).toEqual(rawTool);
      expect(taskChatToolActivityLabel(rawTool.runningLabel)).not.toContain("localization");
      expect(registry.rationale).toBe("In-progress workspace changes update one diff card.");
      expect(formatDurationWords(65000)).toBe("1 minute");
      expect(formatFileSize(1536)).toBe("1.5 KB");
      expect(formatFileSizeDisplay(1536)).toBe(language === "ru" ? "1,5 КБ" : "1.5 KB");
      expect(taskChatDurationLabel("1.5s")).toBe(language === "ru" ? "1,5 с" : "1.5s");
      expect(issueChatRunLabelDisplay("Interrupted by board after 1 minute", taskChatDurationLabel)).toBe(language === "ru" ? "Прервано советом через 1 мин" : "Interrupted by board after 1 minute");
      expect(taskChatTokenLabel("12.3k tokens")).toContain(language === "ru" ? "токенов" : "tokens");
      for (const count of [1, 2, 5, 21]) {
        const summary = turnSummaryText({ toolCount: count, added: 0, removed: 0 });
        expect(summary).toContain(language === "en" ? count + (count === 1 ? " tool" : " tools") : count + (count === 1 || count === 21 ? " инструмент" : count === 2 ? " инструмента" : " инструментов"));
      }
    }
  });
});
