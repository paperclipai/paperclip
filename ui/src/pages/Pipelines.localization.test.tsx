// @vitest-environment jsdom

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import pipelineSource from "./Pipelines.tsx?raw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Learnings, PipelinesIndexTable } from "./Pipelines";
import { i18n } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";
import { pipelinesApi, type PipelineListItem } from "@/api/pipelines";

vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "raw-company" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div data-testid="sort-options">{children}</div>,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => { vi.restoreAllMocks(); await i18n.changeLanguage("en"); });

describe("pipeline locale switching", () => {
  it("updates every sort option on the mounted table and keeps the selected direction", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        await i18n.changeLanguage("en");
        root.render(<PipelinesIndexTable pipelines={[]} viewMode="flat" onViewModeChange={() => {}} connectionsAvailable={false} search="" onSearchChange={() => {}} />);
      });
      const keys = ["sortName", "sortLastActivity", "sortMostToReview", "sortMostInMotion", "sortMostOpenItems"];
      const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="sort-options"] button')];
      expect(buttons()).toHaveLength(5);
      expect(buttons().map((button) => button.firstElementChild?.textContent)).toEqual(keys.map((key) => i18n.t(`pages.pipelines.${key}`)));
      await act(async () => { buttons()[0].click(); });
      expect(buttons()[0].textContent).toContain("↓");
      await act(async () => { await i18n.changeLanguage("ru"); });
      expect(buttons().map((button) => button.firstElementChild?.textContent)).toEqual(keys.map((key) => i18n.t(`pages.pipelines.${key}`)));
      expect(buttons()[0].textContent).toContain("↓");
      expect(container.querySelector("input")?.placeholder).toBe(i18n.t("pages.pipelines.searchPipelines"));
      await act(async () => { await i18n.changeLanguage("en"); });
      expect(buttons()[0].textContent).toContain("↓");
      expect(buttons()[0].firstElementChild?.textContent).toBe(i18n.t("pages.pipelines.sortName"));
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("formats old activity dates using the current locale without changing names, IDs, search or sort state", async () => {
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
    const date = "2025-08-17T13:24:00.000Z";
    const pipelines: PipelineListItem[] = [{ id: "raw-pipeline", companyId: "raw-company", key: "raw_key", name: "Custom English pipeline",
      description: "Original English description", projectId: null, enforceTransitions: false, archivedAt: null, stageCount: 1,
      openCaseCount: 0, lastActivityAt: date, createdAt: date, updatedAt: date }];
    const before = JSON.stringify(pipelines); const onSearch = vi.fn(); const onView = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-09-07T12:00:00.000Z").getTime());
    try {
      await act(async () => { await i18n.changeLanguage("en"); root.render(<PipelinesIndexTable pipelines={pipelines} viewMode="flat" onViewModeChange={onView} connectionsAvailable={false} search="Custom" onSearchChange={onSearch} />); });
      const dateCell = container.querySelector("tbody td:last-child")!;
      const link = container.querySelector('a[href="/pipelines/raw-pipeline"]')!;
      const input = container.querySelector("input")!;
      const sort = container.querySelector<HTMLButtonElement>('[data-testid="sort-options"] button')!;
      await act(async () => sort.click());
      for (const locale of ["en", "ru", "en"] as const) {
        await act(async () => { await i18n.changeLanguage(locale); });
        expect(dateCell.textContent).toBe(new Date(date).toLocaleDateString(locale, { month: "short", day: "numeric" }));
        expect(container.querySelector('a[href="/pipelines/raw-pipeline"]')).toBe(link);
        expect(link.textContent).toBe("Custom English pipeline");
        expect(container.textContent).toContain("Original English description");
        expect(input.value).toBe("Custom"); expect(sort.textContent).toContain("↓");
        expect(JSON.stringify(pipelines)).toBe(before); expect(onSearch).not.toHaveBeenCalled(); expect(onView).not.toHaveBeenCalled();
      }
    } finally { await act(async () => root.unmount()); container.remove(); }
  });

  it("updates learning-event date tooltips without fetching again or rewriting the event and destination", async () => {
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const read = vi.spyOn(pipelinesApi, "listCompanyCaseEvents");
    const date = "2026-08-17T13:24:00.000Z";
    const data = { items: [{ id: "raw-event", companyId: "raw-company", caseId: "raw-case", type: "review_decided", actorType: "agent", actorAgent: { id: "raw-agent", name: "Board" },
      case: { id: "raw-case", caseKey: "RAW-1", title: "Customer-owned English item" }, pipeline: { id: "raw-pipeline", key: "raw_key", name: "Original pipeline" },
      payload: { decision: "approve", note: "Original English review note" }, createdAt: date, updatedAt: date }], pagination: { limit: 100, offset: 0, nextOffset: null, hasMore: false } };
    client.setQueryData(queryKeys.pipelines.learnings("raw-company", 0), data);
    const before = JSON.stringify(data);
    try {
      await act(async () => { await i18n.changeLanguage("en"); root.render(<QueryClientProvider client={client}><Learnings /></QueryClientProvider>); });
      const link = container.querySelector('a[href="/pipelines/raw-pipeline/items/raw-case"]')!;
      const dateSpan = link.parentElement!.previousElementSibling!;
      for (const locale of ["en", "ru", "en"] as const) {
        await act(async () => { await i18n.changeLanguage(locale); });
        expect(dateSpan.getAttribute("title")).toBe(new Date(date).toLocaleString(locale));
        expect(container.querySelector('a[href="/pipelines/raw-pipeline/items/raw-case"]')).toBe(link);
        expect(link.textContent).toContain("Board"); expect(link.textContent).toContain("Customer-owned English item");
        expect(link.textContent).toContain("Original English review note"); expect(container.textContent).toContain("Original pipeline");
        expect(JSON.stringify(client.getQueryData(queryKeys.pipelines.learnings("raw-company", 0)))).toBe(before);
        expect(read).not.toHaveBeenCalled();
      }
    } finally { await act(async () => root.unmount()); container.remove(); client.clear(); }
  });

  it("keeps the private item-history formatter wired to the current i18n locale", () => {
    // The two mounted consumers above cover runtime switching. The full item
    // detail has independent execution queries, so this remaining wiring check
    // deliberately does not pretend to be an end-to-end detail-page test.
    expect(pipelineSource).toMatch(/function formatShortDate\(value: Date \| string\)\s*\{\s*return new Intl\.DateTimeFormat\(i18n\.resolvedLanguage \?\? i18n\.language,/);
    expect(pipelineSource).toContain("{formatShortDate(event.createdAt)}");
  });
});
