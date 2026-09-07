// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";

const state = vi.hoisted(() => ({
  issueStatus: "todo",
  queriedIssueIds: [] as string[],
  detailState: "loaded" as "loaded" | "loading" | "missing" | "error",
  queryCalls: [] as Array<{ queryKey: readonly unknown[]; enabled: boolean }>,
  mutate: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
  useMutation: () => ({ isPending: false, error: null, mutate: state.mutate }),
  useQuery: ({ queryKey, enabled }: { queryKey: readonly string[]; enabled: boolean }) => {
    state.queryCalls.push({ queryKey, enabled });
    if (queryKey[1] === "detail" && state.detailState !== "loaded") {
      return { data: undefined, isLoading: state.detailState === "loading", error: state.detailState === "error" ? new Error("Raw decision failure") : null };
    }
    return queryKey[1] === "detail"
    ? {
        data: {
          id: "decision-1",
          companyId: "company-1",
          originAgentId: "agent-1",
          originIssueId: "origin-1",
          status: "open",
          targetSnapshots: { "target-1": { updatedAt: "2026-07-31T00:00:00.000Z" } },
          options: [{ id: "yes", label: "Yes", effects: [
            {
              type: "create_issue",
              targetIssueId: "target-1",
              staleness: "strict",
              draft: { title: "Follow-up", parentId: "parent-1", blockedByIssueIds: ["blocker-1"] },
            },
            {
              type: "resolve_blocker",
              targetIssueId: "target-1",
              staleness: "strict",
              removeBlockedByIssueIds: ["removed-blocker-1"],
            },
          ] }],
          executions: [],
        },
        isLoading: false,
        error: null,
      }
    : { data: [], isLoading: false, error: null };
  },
  useQueries: ({
    queries,
    combine,
  }: {
    queries: Array<{ queryKey: readonly string[] }>;
    combine?: (results: Array<{ data: { id: string; identifier: string; title: string; status: string } }>) => unknown;
  }) => {
    state.queriedIssueIds = queries.map((query) => String(query.queryKey[2]));
    const results = queries.map((query) => ({
      data: { id: String(query.queryKey[2]), identifier: "PAP-1", title: "Target", status: state.issueStatus },
    }));
    return combine ? combine(results) : results;
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "PAP" } }),
}));

vi.mock("./DecisionCard", () => ({
  DecisionCard: ({ resolveIssue }: { resolveIssue: (id: string) => { status: string | null } | null }) => (
    <div data-testid="resolved-status">{resolveIssue("target-1")?.status}</div>
  ),
}));

import { DecisionResolver, signedCancelTreePreviewIds } from "./DecisionResolver";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DecisionResolver", () => {
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    state.issueStatus = "todo";
    state.queriedIssueIds = [];
    state.detailState = "loaded";
    state.queryCalls = [];
    state.mutate.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("derives cancel-tree previews from the signed descendant scope", () => {
    expect(signedCancelTreePreviewIds("root", { descendantIds: ["signed-child", "signed-grandchild"] }))
      .toEqual(["root", "signed-child", "signed-grandchild"]);
    expect(signedCancelTreePreviewIds("root", undefined)).toBeNull();
  });

  afterEach(async () => {
    container.remove();
    await i18n.changeLanguage("en");
  });

  it("refreshes resolved target status when an issue query changes", () => {
    const root = createRoot(container);
    flushSync(() => root.render(<DecisionResolver companyId="company-1" decisionId="decision-1" />));
    expect(container.querySelector('[data-testid="resolved-status"]')?.textContent).toBe("todo");

    state.issueStatus = "done";
    flushSync(() => root.render(<DecisionResolver companyId="company-1" decisionId="decision-1" />));
    expect(container.querySelector('[data-testid="resolved-status"]')?.textContent).toBe("done");

    flushSync(() => root.unmount());
  });

  it("loads every primary and secondary effect target", () => {
    const root = createRoot(container);
    flushSync(() => root.render(<DecisionResolver companyId="company-1" decisionId="decision-1" />));

    expect(state.queriedIssueIds).toEqual(expect.arrayContaining([
      "target-1",
      "parent-1",
      "blocker-1",
      "removed-blocker-1",
    ]));

    flushSync(() => root.unmount());
  });

  it.each(["loading", "missing", "error"] as const)("translates the %s state live without changing decision query contracts", async (detailState) => {
    state.detailState = detailState;
    const onResolved = vi.fn();
    const root = createRoot(container);
    try {
      await act(async () => root.render(<DecisionResolver companyId="raw-company-1" decisionId="raw-decision-2" onResolved={onResolved} />));
      const message = container.firstElementChild;
      for (const [locale, loading, unavailable] of [
        ["en", "Loading decision…", "This decision is no longer available — it may have been resolved elsewhere."],
        ["ru", "Загружаем запрос, по которому нужно принять решение…", "Запрос больше недоступен. Возможно, решение по нему уже приняли в другом месте."],
        ["en", "Loading decision…", "This decision is no longer available — it may have been resolved elsewhere."],
      ] as const) {
        await act(async () => { await i18n.changeLanguage(locale); });
        expect(container.firstElementChild).toBe(message);
        expect(message?.textContent?.trim()).toBe(detailState === "loading" ? loading : unavailable);
        expect(state.queryCalls.slice(-2)).toEqual([
          { queryKey: queryKeys.decisions.detail("raw-decision-2"), enabled: true },
          { queryKey: queryKeys.decisions.list("raw-company-1", "open"), enabled: false },
        ]);
        expect(state.queriedIssueIds).toEqual([]);
        expect(state.mutate).not.toHaveBeenCalled();
        expect(onResolved).not.toHaveBeenCalled();
      }
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps resolved status tokens and target IDs canonical during language changes", async () => {
    const root = createRoot(container);
    try {
      await act(async () => root.render(<DecisionResolver companyId="company-1" decisionId="decision-1" />));
      const status = container.querySelector('[data-testid="resolved-status"]');
      const originalIds = [...state.queriedIssueIds];
      for (const locale of ["en", "ru", "en"] as const) {
        await act(async () => { await i18n.changeLanguage(locale); });
        expect(container.querySelector('[data-testid="resolved-status"]')).toBe(status);
        expect(status?.textContent).toBe("todo");
        expect(state.queriedIssueIds).toEqual(originalIds);
        expect(state.queryCalls.slice(-2)).toEqual([
          { queryKey: queryKeys.decisions.detail("decision-1"), enabled: true },
          { queryKey: queryKeys.decisions.list("company-1", "open"), enabled: true },
        ]);
        expect(state.mutate).not.toHaveBeenCalled();
      }
    } finally {
      await act(async () => root.unmount());
    }
  });
});
