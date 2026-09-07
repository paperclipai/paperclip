// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AttentionItem } from "@paperclipai/shared";
import type { Decision } from "../api/decisions";
import { i18n, useTranslation } from "@/i18n";
import { ThemeProvider } from "@/context/ThemeContext";
import { ToastProvider } from "@/context/ToastContext";
import { TooltipProvider } from "./ui/tooltip";
import { DecisionCard } from "./DecisionCard";
import { AttentionQueueRow } from "./AttentionQueueRow";
import { DecisionsToolbar } from "./DecisionsToolbar";
import { DecisionDateChips } from "./DecisionDateChips";
import { AgingItemRow } from "./DecisionShelf";
import { decisionQueuesApi } from "../api/decisionQueues";
import { decisionQueueTitleDisplay, decisionQueueDescriptionDisplay } from "../lib/attention";
import { approvalsApi } from "../api/approvals";
import { attentionDetailLine, attentionDetailLineDisplay, attentionGroupLabelDisplay, attentionKind, attentionStatus, buildDeskShelves, groupAttentionItems, resolveAttentionDateRange, defaultAttentionFilterState, buildAttentionFilterOptions } from "../lib/attention";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, disableIssueQuicklook: _quicklook, ...props }: { to: string; children: ReactNode; disableIssueQuicklook?: boolean }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("../api/decisionQueues", () => ({ decisionQueuesApi: { setKeep: vi.fn(async () => ({})), list: vi.fn(async () => []) } }));
vi.mock("../api/approvals", () => ({
  approvalsApi: { approve: vi.fn(async () => ({})), reject: vi.fn(async () => ({})), requestRevision: vi.fn(async () => ({})) },
}));

function mkDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "decision-1",
    companyId: "c1",
    bundleId: null,
    originAgentId: "agent-gardener",
    originIssueId: "issue-origin",
    originRunId: "run-1",
    ruleKey: "stale-epic",
    title: "Stale epic PAP-456",
    body: "No activity for three weeks.",
    options: [
      { id: "comment", label: "Comment and snooze", effects: [{ type: "comment_on_issue", targetIssueId: "issue-target", staleness: "lenient", bodyMarkdown: "nudge" }] },
    ],
    inputs: null,
    status: "open",
    executionStatus: null,
    chosenOptionId: null,
    inputValues: null,
    decidedByUserId: null,
    decidedAt: null,
    expiresAt: "2026-07-29T12:00:00Z",
    idempotencyKey: null,
    targetSnapshots: { "issue-target": { status: "backlog", assigneeAgentId: null, assigneeUserId: null, updatedAt: "2026-07-01T09:00:00Z", childCount: 2 } },
    continuationPolicy: "none",
    metadata: {},
    createdAt: "2026-07-22T09:00:00Z",
    updatedAt: "2026-07-22T09:00:00Z",
    ...overrides,
  };
}


function buildItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "a1",
    companyId: "c1",
    sourceKind: "approval",
    subject: {
      kind: "approval",
      id: "approval-1",
      companyId: "c1",
      title: "Hire agent: Research Analyst",
      identifier: null,
      status: "pending",
      href: "/PAP/approvals/approval-1",
      metadata: {},
    },
    whyNow: "Approval is pending a board decision.",
    decisionVerbs: [],
    inlineResolvable: true,
    entryRule: "",
    exitRule: "",
    dedupKey: "approval:approval-1",
    dismissalKey: "attention:approval:approval-1",
    severity: "high",
    rank: 0,
    activityAt: "2026-07-09T12:00:00Z",
    createdAt: "2026-07-09T12:00:00Z",
    updatedAt: "2026-07-09T12:00:00Z",
    relatedIssue: null,
    project: null,
    workspace: null,
    detail: null,
    dismissal: null,
    ...overrides,
    expiresAt: overrides.expiresAt ?? null,
    ruleKey: overrides.ruleKey ?? null,
    originAgentName: overrides.originAgentName ?? null,
    queues: overrides.queues ?? [],
    shelf: overrides.shelf ?? false,
    retentionDays: overrides.retentionDays ?? 30,
    keep: overrides.keep ?? false,
    archivedAt: overrides.archivedAt ?? null,
    retentionVersion: overrides.retentionVersion ?? 1,
    decideBy: overrides.decideBy ?? null,
    decideByAttribution: overrides.decideByAttribution ?? null,
    snoozedUntil: overrides.snoozedUntil ?? null,
    trainingExampleId: overrides.trainingExampleId ?? null,
  };
}



describe("attention live localization", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
  });
  async function render(node: ReactNode) {
    await act(async () => root.render(<QueryClientProvider client={client}><ThemeProvider><ToastProvider><TooltipProvider>{node}</TooltipProvider></ToastProvider></ThemeProvider></QueryClientProvider>));
  }
  async function locale(language: string) { await act(async () => { await i18n.changeLanguage(language); }); }
  async function input(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    await act(async () => {
      const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("keeps destructive confirmation and note drafts while preserving raw decision and state IDs", async () => {
    const submit = vi.fn();
    const decision = mkDecision({
      title: "Keep English decision", inputs: [{ id: "reason", label: "Keep English reason" }],
      options: [{ id: "cancel-tree-raw", label: "Keep custom option", style: "destructive", effects: [{ type: "cancel_issue_tree", targetIssueId: "issue-target", staleness: "strict", reasonComment: "Keep raw cancellation reason" }] }],
    });
    const target = { id: "issue-target", identifier: "PAP-456", title: "Keep task title", href: "/issues/PAP-456" };
    const rows = Array.from({ length: 21 }, (_, index) => ({ ...target, id: "issue-" + index }));
    await render(<DecisionCard decision={decision} resolveIssue={() => target} cancelTreePreview={() => rows} onDecide={submit} />);
    const note = host.querySelector("textarea")!;
    await input(note, "Keep English draft");
    const option = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Keep custom option"))!;
    await act(async () => option.click());
    const confirm = host.querySelector<HTMLInputElement>('input[placeholder="PAP-456"]')!;
    await input(confirm, "PAP-456");
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      expect(host.querySelector('[data-decision-state="pending"]')).not.toBeNull();
      expect(host.querySelector("textarea")).toBe(note);
      expect(note.value).toBe("Keep English draft");
      expect(host.querySelector('input[placeholder="PAP-456"]')).toBe(confirm);
      expect(confirm.value).toBe("PAP-456");
      expect(confirm.getAttribute("aria-label")).toBe(language === "ru" ? "Введите идентификатор задачи для подтверждения" : "Type the issue identifier to confirm");
      expect(host.textContent).toContain(language === "ru" ? "Отменить 21 задачу" : "Cancel 21 issues");
      expect(host.textContent).toContain("Keep English decision");
      expect(host.textContent).toContain("Keep task title");
      expect(host.textContent).toContain("Keep custom option");
    }
    const commit = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "Отменить 21 задачу")!;
    await act(async () => commit.click());
    expect(submit).toHaveBeenCalledWith("cancel-tree-raw", { reason: "Keep English draft" });
    expect(decision.options[0]!.effects[0]!.type).toBe("cancel_issue_tree");
  });

  it("updates a memoized row and keeps approval notes and destructive verb styling", async () => {
    const item = buildItem({ decisionVerbs: [{ id: "reject", label: "Reject", description: "Reject request" }, { id: "approve", label: "Approve", description: "Approve request" }] });
    function Row() {
      const [expanded, setExpanded] = useState(false);
      return <AttentionQueueRow item={item} companyId="c1" expanded={expanded} onToggleExpand={() => setExpanded(value => !value)} onDismiss={() => undefined} />;
    }
    await render(<Row />);
    const initialReject = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "Отклонить")!;
    expect(initialReject.className).toContain("destructive");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Развернуть решение"]')!.click());
    const note = host.querySelector("textarea")!;
    await input(note, "Keep approval note");
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      expect(host.querySelector("textarea")).toBe(note);
      expect(note.value).toBe("Keep approval note");
      expect(host.querySelector('[data-attention-source="approval"]')).not.toBeNull();
      expect(host.textContent).toContain(language === "ru" ? "Согласование" : "Approval");
      expect(host.querySelector("textarea")?.placeholder).toBe(language === "ru" ? "Примечание к решению (необязательно)…" : "Optional decision note…");
      const reject = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === (language === "ru" ? "Отклонить" : "Reject"))!;
      expect(reject.className).toContain("destructive");
    }
    const approve = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "Одобрить")!;
    await act(async () => approve.click());
    expect(approvalsApi.approve).toHaveBeenCalledWith("approval-1", "Keep approval note");
  });

  it("updates toolbar counts and date labels without changing selected date-range IDs", async () => {
    const change = vi.fn();
    function Controls() {
      const [range, setRange] = useState<"all" | "today">("today");
      return <>
        <DecisionsToolbar visibleCount={21} filterOptions={buildAttentionFilterOptions([buildItem()])} filters={defaultAttentionFilterState} onFiltersChange={() => undefined} groupBy="none" onGroupByChange={() => undefined} sortOrder="newest" onSortOrderChange={() => undefined} />
        <DecisionDateChips value={range} custom={{ from: null, to: null }} onChange={(value, custom) => { change(value, custom); if (value === "all" || value === "today") setRange(value); }} />
      </>;
    }
    await render(<Controls />);
    const today = [...host.querySelectorAll("button")].find(button => button.textContent === "Сегодня")!;
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      expect(host.contains(today)).toBe(true);
      expect(today.getAttribute("aria-pressed")).toBe("true");
      expect(today.textContent).toBe(language === "ru" ? "Сегодня" : "Today");
      expect(host.textContent).toContain(language === "ru" ? "21 решение" : "21 decisions");
      expect(host.querySelector('button[aria-label="' + (language === "ru" ? "Фильтр" : "Filter") + '"]')).not.toBeNull();
    }
    const all = [...host.querySelectorAll("button")].find(button => button.textContent === "Все")!;
    await act(async () => all.click());
    expect(change).toHaveBeenCalledWith("all", { from: null, to: null });
  });

  it("updates aging labels without altering the keep command", async () => {
    const item = buildItem({ shelf: true, inlineResolvable: false, activityAt: "2026-09-01T12:00:00Z" });
    await render(<AgingItemRow item={item} companyId="c1" now={Date.parse("2026-09-03T12:00:00Z")} agentMap={new Map()} agents={[]} currentUserId={null} expanded={false} onToggleExpand={() => undefined} onDismiss={() => undefined} onSnooze={() => undefined} />);
    const keep = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "Оставить в списке решений")!;
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      expect(host.contains(keep)).toBe(true);
      expect(host.textContent).toContain(language === "ru" ? "Нет активности 2 дня" : "Idle 2 days");
      expect(keep.textContent).toBe(language === "ru" ? "Оставить в списке решений" : "Keep on desk");
    }
    await act(async () => keep.click());
    expect(decisionQueuesApi.setKeep).toHaveBeenCalledWith("c1", "approval", "approval-1", true);
  });

  it("keeps bucket keys, classification, raw helpers and date bounds unchanged for 1/2/5/21", async () => {
    const now = Date.parse("2026-09-07T12:00:00Z");
    const item = buildItem({ decideBy: "today", sourceKind: "failed_run" });
    const rawGroups = groupAttentionItems([item], "type", { now });
    const bounds = resolveAttentionDateRange("today", now);
    function Groups() { useTranslation(); return <div>{rawGroups.map(group => <span key={group.key}>{attentionGroupLabelDisplay(group)}</span>)}</div>; }
    await render(<Groups />);
    const span = host.querySelector("span");
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      expect(host.querySelector("span")).toBe(span);
      expect(host.textContent).toBe(language === "ru" ? "Запуск с ошибкой" : "Failed run");
      expect(decisionQueueTitleDisplay({ key: "plans", title: "Plans", createdByType: "system" })).toBe(language === "ru" ? "Планы" : "Plans");
      expect(decisionQueueTitleDisplay({ key: "plans", title: "Plans", createdByType: "user" })).toBe("Plans");
      expect(decisionQueueTitleDisplay({ key: "plans", title: "Keep custom queue", createdByType: "system" })).toBe("Keep custom queue");
      expect(decisionQueueDescriptionDisplay({ key: "plans", description: "Keep description", createdByType: "system" })).toBe("Keep description");
      expect(attentionKind(item)).toBe("blocking");
      expect(attentionStatus(item)).toBe("blocked");
      expect(groupAttentionItems([item], "type", { now })).toEqual(rawGroups);
      expect(buildDeskShelves([item], now)[0]!.key).toBe("desk:decide-now");
      expect(resolveAttentionDateRange("today", now)).toEqual(bounds);
      expect(attentionGroupLabelDisplay({ key: "project:user", label: "Today", items: [] })).toBe("Today");
      for (const count of [1, 2, 5, 21]) {
        const counted = buildItem({ detail: { kind: "questions", questionCount: count, firstQuestionText: "Keep English question?", images: [] } });
        expect(attentionDetailLine(counted)).toContain(count + (count === 1 ? " question" : " questions"));
        expect(attentionDetailLineDisplay(counted)).toContain(language === "en" ? count + (count === 1 ? " question" : " questions") : count + (count === 1 || count === 21 ? " вопрос" : count === 2 ? " вопроса" : " вопросов"));
        expect(attentionDetailLineDisplay(counted)).toContain("Keep English question?");
      }
    }
  });
});
