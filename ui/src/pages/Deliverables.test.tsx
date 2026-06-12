// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Deliverables } from "./Deliverables";

const listMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/deliverables", () => ({
  deliverablesApi: {
    list: (companyId: string, filters?: unknown) => listMock(companyId, filters),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Bizbox", issuePrefix: "PAP" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    await Promise.resolve();
  });
}

function renderDeliverables(container: HTMLElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <Deliverables />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
}

function sampleItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "deliverable-1",
    companyId: "company-1",
    projectId: null,
    title: "Final report",
    summary: null,
    audience: "human",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    contentPath: "/api/attachments/abc/content",
    contentType: "application/pdf",
    byteSize: 2048,
    originalFilename: "report.pdf",
    sourceKind: "issue",
    childIssue: { id: "child-1", identifier: "PAP-12", title: "Write report", status: "done" },
    rootIssue: { id: "root-1", identifier: "PAP-1", title: "Quarterly review", status: "in_progress" },
    agent: { id: "agent-1", name: "Astro", urlKey: "astro", icon: null },
    runId: "run-1",
    workflow: null,
    ...overrides,
  };
}

describe("Deliverables page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders deliverables in a table with download links", async () => {
    listMock.mockResolvedValue({
      items: [sampleItem(), sampleItem({ id: "deliverable-2", title: "Draft", originalFilename: "draft.md", audience: "internal" })],
      limit: 50,
      offset: 0,
    });

    await renderDeliverables(container);
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Deliverables");
    expect(container.textContent).toContain("Final report");
    expect(container.textContent).toContain("report.pdf");
    expect(container.textContent).toContain("Draft");
    expect(container.textContent).toContain("PAP-1");
    expect(container.textContent).toContain("from");
    expect(container.textContent).toContain("PAP-12");
    expect(container.textContent).toContain("Astro");
    expect(container.textContent).toContain("Human");
    expect(container.textContent).toContain("Internal");

    const downloadLinks = Array.from(container.querySelectorAll("a")).filter(
      (a) => a.getAttribute("href") === "/api/deliverables/deliverable-1/content",
    );
    expect(downloadLinks.length).toBeGreaterThan(0);
    const firstDownload = downloadLinks[0]!;
    expect(firstDownload.getAttribute("download")).toBe("report.pdf");
  });

  it("renders workflow deliverables without issue lineage", async () => {
    listMock.mockResolvedValue({
      items: [
        sampleItem({
          id: "workflow-deliverable-1",
          sourceKind: "workflow",
          title: "Workflow brief",
          childIssue: null,
          rootIssue: null,
          agent: null,
          workflow: { id: "workflow-1", title: "Brief generator", runId: "run-2" },
        }),
      ],
      limit: 50,
      offset: 0,
    });

    await renderDeliverables(container);
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Brief generator");
    expect(container.textContent).toContain("Workflow");
    expect(container.textContent).toContain("Run run-2");
  });

  it("uses server-side search query parameter and audience filter", async () => {
    listMock.mockImplementation(async (_companyId: string, filters?: { q?: string; audience?: string }) => {
      if (filters?.q === "draft" || filters?.audience === "internal") {
        return {
          items: [sampleItem({ id: "deliverable-2", title: "Draft", audience: "internal" })],
          limit: 50,
          offset: 0,
        };
      }
      return {
        items: [sampleItem()],
        limit: 50,
        offset: 0,
      };
    });

    await renderDeliverables(container);
    await flushReact();
    await flushReact();

    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    expect(input).toBeTruthy();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(input, "draft");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    await flushReact();
    await flushReact();

    expect(listMock.mock.calls.some(([, filters]) => (filters as { q?: string } | undefined)?.q === "draft")).toBe(true);
    expect(container.textContent).toContain("Draft");

    const select = container.querySelector('select[aria-label="Filter by audience"]') as HTMLSelectElement;
    await act(async () => {
      select.selectedIndex = 2;
      select.value = "internal";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await flushReact();
    await flushReact();

    expect(listMock.mock.calls.some(([, filters]) => (filters as { audience?: string } | undefined)?.audience === "internal")).toBe(true);
  });

  it("keeps search input visible when search returns zero results", async () => {
    listMock.mockImplementation(async (_companyId: string, filters?: { q?: string }) => {
      if (filters?.q === "zzz") {
        return { items: [], limit: 50, offset: 0 };
      }
      return { items: [sampleItem()], limit: 50, offset: 0 };
    });

    await renderDeliverables(container);
    await flushReact();
    await flushReact();

    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    expect(input).toBeTruthy();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(input, "zzz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No deliverables match your search.");
    expect(container.querySelector('input[type="search"]')).toBeTruthy();
  });

  it("keeps the search input mounted while a search request is pending", async () => {
    let resolveSearch: ((value: { items: ReturnType<typeof sampleItem>[]; limit: number; offset: number }) => void) | null = null;
    listMock.mockImplementation((_companyId: string, filters?: { q?: string }) => {
      if (filters?.q === "r") {
        return new Promise((resolve) => {
          resolveSearch = resolve;
        });
      }
      return Promise.resolve({
        items: [sampleItem()],
        limit: 50,
        offset: 0,
      });
    });

    await renderDeliverables(container);
    await flushReact();
    await flushReact();

    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    expect(input).toBeTruthy();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(input, "r");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await flushReact();

    const pendingInput = container.querySelector('input[type="search"]');
    expect(pendingInput).toBeTruthy();
    expect(pendingInput?.isConnected).toBe(true);
    expect((pendingInput as HTMLInputElement).value).toBe("r");
    expect(container.querySelector("svg.animate-spin")).toBeTruthy();
    expect(container.querySelector(".opacity-70")).toBeTruthy();

    await act(async () => {
      resolveSearch?.({
        items: [sampleItem({ id: "deliverable-2", title: "Recycled draft" })],
        limit: 50,
        offset: 0,
      });
    });

    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Recycled draft");
    expect(container.querySelector("svg.animate-spin")).toBeNull();
  });

  it("keeps the audience filter visible when audience filtering returns zero results", async () => {
    listMock.mockImplementation(async (_companyId: string, filters?: { audience?: string }) => {
      if (filters?.audience === "internal") {
        return { items: [], limit: 50, offset: 0 };
      }
      return { items: [sampleItem()], limit: 50, offset: 0 };
    });

    await renderDeliverables(container);
    await flushReact();
    await flushReact();

    const select = container.querySelector('select[aria-label="Filter by audience"]') as HTMLSelectElement;
    expect(select).toBeTruthy();

    await act(async () => {
      select.selectedIndex = 2;
      select.value = "internal";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await flushReact();
    await flushReact();

    expect(container.querySelector('select[aria-label="Filter by audience"]')).toBeTruthy();
    expect((container.querySelector('select[aria-label="Filter by audience"]') as HTMLSelectElement).value).toBe("internal");
  });

  it("renders an empty state when there are no deliverables", async () => {
    listMock.mockResolvedValue({ items: [], limit: 50, offset: 0 });

    await renderDeliverables(container);
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No deliverables yet");
  });
});
