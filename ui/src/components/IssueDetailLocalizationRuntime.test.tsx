// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { i18n, useTranslation } from "@/i18n";
import { ThemeProvider } from "@/context/ThemeContext";
import { TooltipProvider } from "./ui/tooltip";
import { IssueThreadInteractionCard } from "./IssueThreadInteractionCard";
import { TaskChatCompactInteractionCard } from "./task-chat/TaskChatCompactInteractionCard";
import { ExternalObjectRows } from "./issue-properties/external-object-rows";
import type { IssueExternalObjectGroup } from "@/hooks/useIssueExternalObjects";
import { ISSUE_THINKING_EFFORT_OPTIONS } from "./issue-properties/helpers";
import { pendingRequestItemVerdictsInteraction, boundedRequestCheckboxConfirmationInteraction } from "@/fixtures/issueThreadInteractionFixtures";
import { deriveMonitorState, formatMonitorEta, formatMonitorEtaDisplay, formatMonitorOffset, formatMonitorOffsetDisplay } from "@/lib/issue-monitor";
import { buildIssueThreadInteractionSummary, buildAnsweredQuestionsDeliveryText } from "@/lib/issue-thread-interactions";
import { pendingAskUserQuestionsInteraction } from "@/fixtures/issueThreadInteractionFixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

// Exercise merged detection independently from the language used by the display helper.
vi.mock("@/lib/external-objects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/external-objects")>();
  return {
    ...actual,
    externalObjectDisplayStatusLabel: (input: Parameters<typeof actual.externalObjectDisplayStatusLabel>[0]) =>
      input.statusLabel === "Merged" && i18n.resolvedLanguage === "ru" ? "Слито" : actual.externalObjectDisplayStatusLabel(input),
  };
});

describe("task detail live localization", () => {
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
    vi.restoreAllMocks();
    await i18n.changeLanguage("en");
  });

  async function render(children: ReactNode) {
    await act(async () => root.render(<QueryClientProvider client={client}><ThemeProvider><TooltipProvider>{children}</TooltipProvider></ThemeProvider></QueryClientProvider>));
  }

  it("keeps verdict drafts and entered reasons across ru → en → ru, then submits protocol values", async () => {
    const submit = vi.fn(async () => undefined);
    const item = pendingRequestItemVerdictsInteraction.payload.items[0]!;
    const interaction = {
      ...pendingRequestItemVerdictsInteraction,
      payload: { ...pendingRequestItemVerdictsInteraction.payload, items: [item], reasonLabel: undefined, allowBulkApprove: false },
    };
    await render(<IssueThreadInteractionCard interaction={interaction} onSubmitInteractionVerdicts={submit} />);
    const reject = host.querySelector<HTMLButtonElement>('button[data-verdict="reject"]')!;
    await act(async () => reject.click());
    const reason = host.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(reason).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(reason, "Keep my English reason");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (const locale of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(host.querySelector("textarea")).toBe(reason);
      expect(reason.value).toBe("Keep my English reason");
      expect(reject.getAttribute("aria-pressed")).toBe("true");
      expect(reject.getAttribute("aria-label")).toBe(locale === "ru" ? "Отклонить элемент" : "Reject this item");
      expect(host.textContent).toContain(locale === "ru" ? "Применить 1 решение" : "Apply 1 decision");
      expect(host.textContent).toContain(item.label);
    }
    const apply = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "Применить 1 решение")!;
    await act(async () => apply.click());
    expect(submit).toHaveBeenCalledWith(interaction, [{ id: item.id, verdict: "reject", reason: "Keep my English reason" }]);
  });

  it("keeps compact checkbox selections and search text while translating count constraints", async () => {
    const accept = vi.fn(async () => undefined);
    const interaction = {
      ...boundedRequestCheckboxConfirmationInteraction,
      payload: {
        ...boundedRequestCheckboxConfirmationInteraction.payload,
        options: [...boundedRequestCheckboxConfirmationInteraction.payload.options, ...Array.from({ length: 8 }, (_, index) => ({ id: `extra-${index}`, label: `Extra region ${index}` }))],
      },
    };
    await render(<TaskChatCompactInteractionCard interaction={interaction} onAcceptInteraction={accept} />);
    const filter = host.querySelector<HTMLInputElement>('input[aria-label="Фильтровать варианты"]')!;
    expect(filter).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filter, "West");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (const locale of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(host.contains(filter)).toBe(true);
      expect(filter.value).toBe("West");
      expect(filter.getAttribute("aria-label")).toBe(locale === "ru" ? "Фильтровать варианты" : "Filter options");
      expect(host.textContent).toContain(locale === "ru" ? "Выбрано: 2 · выберите от 2 до 3" : "2 selected · choose 2–3");
      expect(host.textContent).toContain("US West (Oregon)");
    }
    const button = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "Confirm regions")!;
    await act(async () => button.click());
    expect(accept).toHaveBeenCalledWith(interaction, undefined, ["us-west", "us-east"]);
  });

  it("refreshes display-only monitor labels and options without changing scheduling or delivered content", async () => {
    const now = new Date("2026-09-07T10:00:00Z");
    const next = new Date("2026-09-07T12:12:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now.getTime());
    function Monitor() {
      useTranslation();
      return <div>{formatMonitorEtaDisplay(next, now)} · {formatMonitorOffsetDisplay(next)} · {ISSUE_THINKING_EFFORT_OPTIONS.claude_local[0].label}</div>;
    }
    await render(<Monitor />);
    const delivered = buildAnsweredQuestionsDeliveryText(pendingAskUserQuestionsInteraction);
    for (const locale of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(host.textContent).toContain(locale === "ru" ? "через 2 ч 12 мин" : "in 2h 12m");
      expect(host.textContent).toContain(locale === "ru" ? "По умолчанию" : "Default");
      expect(formatMonitorEta(next, now)).toBe("in 2h 12m");
      expect(formatMonitorOffset(next)).toBe("in 2h 12m");
      expect(deriveMonitorState({ monitorNextCheckAt: next }, now).state).toBe("scheduled");
      expect(buildAnsweredQuestionsDeliveryText(pendingAskUserQuestionsInteraction)).toBe(delivered);
      for (const count of [1, 2, 5, 21]) {
        const questions = Array.from({ length: count }, (_, index) => ({ ...pendingAskUserQuestionsInteraction.payload.questions[0]!, id: String(index) }));
        const label = buildIssueThreadInteractionSummary({ ...pendingAskUserQuestionsInteraction, payload: { ...pendingAskUserQuestionsInteraction.payload, questions } });
        expect(label).toBe(locale === "en" ? `Asked ${count} question${count === 1 ? "" : "s"}` : count === 1 || count === 21 ? `Задан ${count} вопрос` : count === 2 ? "Заданы 2 вопроса" : "Задано 5 вопросов");
      }
    }
  });

  it("preserves merged styling when the visible status becomes Russian", async () => {
    const externalObjects: IssueExternalObjectGroup[] = [{
      mentionCount: 1, sourceLabels: [],
      pill: { providerKey: "github", objectType: "pull_request", displayKey: null, iconKey: "github", statusCategory: "succeeded", statusIconKey: null, statusLabel: "Merged", liveness: "fresh", displayTitle: "User pull request", url: "https://github.com/acme/web/pull/241" },
      group: { object: null, mentions: [], mentionCount: 1, sourceLabels: [] },
    }];
    await render(<ExternalObjectRows externalObjects={externalObjects} />);
    const link = host.querySelector<HTMLAnchorElement>('a[href="https://github.com/acme/web/pull/241"]')!;
    for (const locale of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(host.querySelector('a[href="https://github.com/acme/web/pull/241"]')).toBe(link);
      expect(link.textContent).toBe(locale === "ru" ? "Пул-реквест 241 — Слито" : "PR 241 - Merged");
      expect(link.className).toContain("text-violet-600");
      expect(link.querySelector(".lucide-git-merge")).not.toBeNull();
    }
  });
});
