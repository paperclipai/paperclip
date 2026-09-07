// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { parseSearchQuery, searchOperatorSuggestions } from "@/lib/search-query-parser";
import { SearchFilterBar } from "./SearchFilterBar";
import { SearchFilterChips } from "./SearchFilterChips";
import { SearchFilterSheet } from "./SearchFilterSheet";
import { ZeroResultsRecovery } from "./ZeroResultsRecovery";
import { MatchSourceChip } from "./MatchSourceChip";
import { SearchResultRow } from "./SearchResultRow";
import { IssueRow } from "../IssueRow";
import { BLOCKED_GROUP_OPTIONS, blockedReasonLabel, formatStoppedAge } from "@/lib/blockedInbox";
import { readRecoveryRetryLineage, formatRecoveryLineageSummary } from "@/lib/recovery-lineage";
import { AgentStatusBadge, IssueStatusBadge, StatusBadge } from "../StatusBadge";
import { InboxIssueMetaLeading, IssueColumnPicker } from "../IssueColumns";
import type { CompanySearchResult, Issue } from "@paperclipai/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/sheet", () => {
  const Panel = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { Sheet: Panel, SheetContent: Panel, SheetClose: Panel, SheetFooter: Panel, SheetHeader: Panel, SheetTitle: Panel };
});

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const lookups = {
  agentName: () => undefined, userName: () => undefined,
  projectName: () => undefined, labelName: () => undefined, currentUserId: "user-1",
};
const data = { agents: [], projects: [], labels: [], currentUserId: "user-1" };

describe("localized filter surfaces", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    await i18n.changeLanguage("ru");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    act(() => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
    vi.restoreAllMocks();
  });

  it("updates mounted search filters, chips, statuses and column controls without changing wire values", async () => {
    const onChange = vi.fn();
    const onSortChange = vi.fn();
    const filters = { status: ["in_progress"] as const, priority: ["high"] as const, updatedWithin: "7d" };
    const mutableFilters = { ...filters, status: [...filters.status], priority: [...filters.priority] };
    act(() => root.render(
      <>
        <SearchFilterBar filters={mutableFilters} onChange={onChange} sort="updated" onSortChange={onSortChange} data={data} />
        <SearchFilterChips filters={mutableFilters} lookups={lookups} onChange={onChange} onClearAll={vi.fn()} />
        <MatchSourceChip kind="comment" count={2} />
        <StatusBadge status="failed" />
        <AgentStatusBadge status="active" />
        <IssueStatusBadge status="in_review" />
        <IssueColumnPicker availableColumns={["status", "id", "updated"]} visibleColumnSet={new Set(["status"])} onToggleColumn={vi.fn()} onResetColumns={vi.fn()} title="Columns fixture" />
      </>,
    ));
    const statusButton = container.querySelector<HTMLButtonElement>('button[aria-label="Фильтр: Статус"]')!;
    expect(statusButton).not.toBeNull();
    for (const locale of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(statusButton.getAttribute("aria-label")).toBe(locale === "ru" ? "Фильтр: Статус" : "Filter by Status");
      expect(container.textContent).toContain(locale === "ru" ? "За последние 7 дней" : "Last 7 days");
      expect(container.textContent).toContain(locale === "ru" ? "Приоритет: Высокий" : "Priority: High");
      expect(container.textContent).toContain(locale === "ru" ? "Комментарий" : "Comment");
      expect(container.textContent).toContain(locale === "ru" ? "На проверке" : "In review");
      expect(container.querySelector('button[title]')?.getAttribute("title")).toBe(locale === "ru" ? "Столбцы" : "Columns");
      const suggestion = searchOperatorSuggestions("assignee:", 1)[0]!;
      expect(suggestion.label).toBe(locale === "ru" ? "Назначенные мне" : "Assigned to me");
      expect(suggestion.token).toBe("assignee:me");
      expect(parseSearchQuery("priority:high updated:>7d").filters).toEqual({ priority: ["high"], updatedWithin: "7d" });
    }
    const removePriority = container.querySelector<HTMLButtonElement>('button[aria-label="Убрать фильтр Приоритет: Высокий"]');
    act(() => removePriority?.click());
    expect(onChange).toHaveBeenLastCalledWith({ status: ["in_progress"], updatedWithin: "7d" });
  });

  it("updates memoized result snippets and relative dates without translating user content", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-09-07T10:00:00Z").getTime());
    const result: CompanySearchResult = {
      id: "issue-1", type: "issue", score: 1, title: "English user title", href: "/issues/PAP-1",
      matchedFields: ["identifier", "comment"], sourceLabel: "Comment", snippet: "English user comment",
      snippets: [
        { field: "identifier", label: "Identifier", text: "PAP-1", highlights: [] },
        { field: "comment", label: "Comment", text: "English user comment", highlights: [] },
      ],
      updatedAt: "2026-09-07T08:00:00Z", previewImageUrl: null,
      issue: {
        id: "issue-1", identifier: "PAP-1", title: "English user title", status: "todo", priority: "medium",
        assigneeAgentId: null, assigneeUserId: null, projectId: null, updatedAt: "2026-09-07T08:00:00Z",
      },
    };
    act(() => root.render(<SearchResultRow result={result} />));
    for (const locale of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(container.textContent).toContain(locale === "ru" ? "Идентификатор" : "Identifier");
      expect(container.textContent).toContain(locale === "ru" ? "Комментарий" : "Comment");
      expect(container.textContent).toContain(locale === "ru" ? "2 ч" : "2h");
      expect(container.textContent).toContain("English user title");
      expect(container.textContent).toContain("English user comment");
      expect(container.querySelector("a")?.getAttribute("href")).toBe("/issues/PAP-1");
    }
    vi.restoreAllMocks();
  });

  it("refreshes task-row actions and recovery labels while preserving retry state", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-09-07T10:00:00Z").getTime());
    const onMarkRead = vi.fn();
    const issue = {
      id: "issue-1", identifier: "PAP-1", title: "User task title", status: "todo",
      updatedAt: "2026-09-07T08:00:00Z", blockedBy: [],
    } as unknown as Issue;
    const lineage = readRecoveryRetryLineage({
      wakePolicy: {
        type: "bounded_owner_disposition_repair", retryAgentId: "agent-1",
        attempt: 2, maxAttempts: 5, retryAt: "2026-09-07T11:30:00Z",
      },
    })!;
    act(() => root.render(<IssueRow issue={issue} presentation="task" unreadState="visible" onMarkRead={onMarkRead} />));
    for (const locale of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(container.textContent).toContain(locale === "ru" ? "Открыть PAP-1: User task title" : "Open PAP-1: User task title");
      expect(container.querySelector('button[aria-label]')?.getAttribute("aria-label")).toBe(locale === "ru" ? "Отметить прочитанным" : "Mark as read");
      expect(BLOCKED_GROUP_OPTIONS[0]![1]).toBe(locale === "ru" ? "Тип блокировки" : "Blocker type");
      expect(blockedReasonLabel("blocked_by_unassigned_issue")).toBe(locale === "ru" ? "Блокирующая задача без исполнителя" : "Unassigned blocker");
      expect(formatStoppedAge("2026-09-07T08:00:00Z")).toBe(locale === "ru" ? "остановлено 2 ч назад" : "stopped 2h");
      expect(formatRecoveryLineageSummary(lineage)).toBe(locale === "ru"
        ? "Попытка 2 из 5 · следующая попытка через 1 ч 30 мин"
        : "Attempt 2 of 5 · next try in 1h 30m");
      expect(lineage.hasDurablePath).toBe(true);
      expect(lineage.retryExpired).toBe(false);
    }
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label]')?.click());
    expect(onMarkRead).toHaveBeenCalledTimes(1);
  });

  it.each([
    [1, "результат", "подзадача"],
    [2, "результата", "подзадачи"],
    [5, "результатов", "подзадач"],
    [21, "результат", "подзадача"],
  ])("uses Russian plural forms for %i results and running subtasks", async (count, results, subtasks) => {
    const onDraftChange = vi.fn();
    act(() => root.render(
      <>
        <SearchFilterSheet open onOpenChange={vi.fn()} filters={{}} onApply={vi.fn()} onDraftChange={onDraftChange} previewTotal={count} data={data} sort="relevance" onSortChange={vi.fn()} />
        <ZeroResultsRecovery query="report" filters={{ status: ["blocked"] }} zeroResults={{ unfilteredTotal: count, loosenSuggestions: [{ filter: "status", values: ["blocked"], additionalCount: count, resultCount: count }] }} lookups={lookups} onChange={vi.fn()} onClearAll={vi.fn()} />
        <InboxIssueMetaLeading issue={{ id: "issue-1", status: "done" } as Issue} isLive={false} showStatus={false} subtreeLiveCount={count} />
      </>,
    ));
    for (const locale of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      if (locale === "ru") {
        expect(container.textContent).toContain(`Показать ${count} ${results}`);
        expect(container.textContent).toContain(`+${count} ${results}`);
        expect(container.querySelector('[title]')?.getAttribute("title")).toContain(`${count} ${subtasks}`);
      } else {
        expect(container.textContent).toContain(`Show ${count} ${count === 1 ? "result" : "results"}`);
        expect(container.querySelector('[title]')?.getAttribute("title")).toContain(`${count} ${count === 1 ? "sub-task" : "sub-tasks"}`);
      }
    }
    expect(onDraftChange).toHaveBeenCalledTimes(1);
  });
});
