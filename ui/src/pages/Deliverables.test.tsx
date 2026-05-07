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
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
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
    await new Promise((resolve) => window.setTimeout(resolve, 0));
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
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    contentPath: "/api/attachments/abc/content",
    contentType: "application/pdf",
    byteSize: 2048,
    originalFilename: "report.pdf",
    childIssue: { id: "child-1", identifier: "PAP-12", title: "Write report", status: "done" },
    rootIssue: { id: "root-1", identifier: "PAP-1", title: "Quarterly review", status: "in_progress" },
    agent: { id: "agent-1", name: "Astro", icon: null },
    runId: "run-1",
    ...overrides,
  };
}

describe("Deliverables page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders deliverables in a table with download links", async () => {
    listMock.mockResolvedValue({
      items: [sampleItem(), sampleItem({ id: "deliverable-2", title: "Draft", originalFilename: "draft.md" })],
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

    const downloadLinks = Array.from(container.querySelectorAll("a")).filter(
      (a) => a.getAttribute("href") === "/api/attachments/abc/content",
    );
    expect(downloadLinks.length).toBeGreaterThan(0);
    const firstDownload = downloadLinks[0]!;
    expect(firstDownload.getAttribute("download")).toBe("report.pdf");
  });

  it("uses server-side search query parameter", async () => {
    listMock.mockImplementation(async (_companyId: string, filters?: { q?: string }) => {
      if (filters?.q === "draft") {
        return {
          items: [sampleItem({ id: "deliverable-2", title: "Draft" })],
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

    await flushReact();
    await flushReact();

    expect(listMock.mock.calls.some(([, filters]) => (filters as { q?: string } | undefined)?.q === "draft")).toBe(true);
    expect(container.textContent).toContain("Draft");
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

    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No deliverables match your search.");
    expect(container.querySelector('input[type="search"]')).toBeTruthy();
  });

  it("renders an empty state when there are no deliverables", async () => {
    listMock.mockResolvedValue({ items: [], limit: 50, offset: 0 });

    await renderDeliverables(container);
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No deliverables yet");
  });
});
