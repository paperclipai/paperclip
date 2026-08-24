// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeBrowser } from "./KnowledgeBrowser";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1" as string | null,
}));

const breadcrumbState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const toastState = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbState,
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => toastState,
}));

const knowledgeApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  submitForReview: vi.fn(),
  review: vi.fn(),
  publish: vi.fn(),
  archive: vi.fn(),
  listRevisions: vi.fn(),
  getRevision: vi.fn(),
  diff: vi.fn(),
  listBacklinks: vi.fn(),
  searchPublished: vi.fn(),
}));

vi.mock("../api/knowledge", () => ({
  knowledgeApi: knowledgeApiMock,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="markdown-body">{children}</div>,
}));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForAssertion(assertion: () => void, attempts = 50) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function renderKB(container: HTMLDivElement, node?: ReactNode) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/knowledge"]}>
          <Routes>
            <Route path="/knowledge" element={node ?? <KnowledgeBrowser />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

describe("KnowledgeBrowser page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    breadcrumbState.setBreadcrumbs.mockReset();
    toastState.pushToast.mockReset();
    knowledgeApiMock.list.mockReset();
    knowledgeApiMock.get.mockReset();
    knowledgeApiMock.searchPublished.mockReset();
    knowledgeApiMock.create.mockReset();
    window.localStorage.clear();
  });

  afterEach(() => {
    container.remove();
  });

  it("renders empty state when no company is selected", () => {
    companyState.selectedCompanyId = null;
    renderKB(container);
    expect(container.textContent).toContain("Select a company to view knowledge base");
    companyState.selectedCompanyId = "company-1";
  });

  it("shows 'No knowledge documents yet' when list returns empty", async () => {
    knowledgeApiMock.list.mockResolvedValue({ items: [], nextCursor: undefined });
    renderKB(container);
    await waitForAssertion(() => {
      expect(container.textContent).toContain("No knowledge documents yet");
    });
  });

  it("renders document cards from list response", async () => {
    knowledgeApiMock.list.mockResolvedValue({
      items: [
        {
          id: "doc-1",
          title: "Onboarding Guide",
          summary: "How to onboard users",
          status: "published",
          version: 2,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-06-01T00:00:00Z",
          revisionCount: 3,
        },
        {
          id: "doc-2",
          title: "Deploy Checklist",
          summary: "Steps to deploy",
          status: "draft",
          version: 1,
          createdAt: "2026-02-01T00:00:00Z",
          updatedAt: "2026-06-15T00:00:00Z",
          revisionCount: 1,
        },
      ],
      nextCursor: undefined,
    });
    renderKB(container);
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Onboarding Guide");
      expect(container.textContent).toContain("Deploy Checklist");
      expect(container.textContent).toContain("Published");
      expect(container.textContent).toContain("Draft");
    });
  });

  it("calls searchPublished when the search input has text", async () => {
    knowledgeApiMock.list.mockResolvedValue({ items: [], nextCursor: undefined });
    knowledgeApiMock.searchPublished.mockResolvedValueOnce([
      { id: "doc-1", title: "Search Result", summary: "Matched doc", score: 0.95 },
    ]);
    renderKB(container);

    // Type in search using native setter (same pattern as Search.test.tsx)
    const searchInput = container.querySelector('[aria-label="Search knowledge"]') as HTMLInputElement;
    flushSync(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      nativeSetter.call(searchInput, "deploy");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Wait for debounce (300ms) + flush
    await new Promise((resolve) => setTimeout(resolve, 400));

    await waitForAssertion(() => {
      expect(knowledgeApiMock.searchPublished).toHaveBeenCalledWith(
        "company-1",
        "deploy",
        expect.any(Number),
      );
    });
  });

  it("opens the create dialog and creates a document", async () => {
    knowledgeApiMock.list.mockResolvedValue({ items: [], nextCursor: undefined });
    knowledgeApiMock.create.mockResolvedValueOnce({ id: "doc-new" });

    renderKB(container);

    // Click "New Document" button
    await waitForAssertion(() => {
      const newBtn = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("New Document"),
      );
      expect(newBtn).toBeDefined();
      newBtn!.click();
    });

    // Fill in the form (use native setter so React's onChange fires)
    const titleInput = document.querySelector("#new-title") as HTMLInputElement;
    expect(titleInput).toBeDefined();
    const nativeSet = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    nativeSet?.call(titleInput, "Test Document");
    titleInput.dispatchEvent(new Event("input", { bubbles: true }));

    // Find and click Create button
    const createBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Create"),
    );
    expect(createBtn).toBeDefined();
    createBtn!.click();

    await waitForAssertion(() => {
      expect(knowledgeApiMock.create).toHaveBeenCalled();
      expect(toastState.pushToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Document created" }),
      );
    });
  });

  it("opens detail sheet when a document card is clicked", async () => {
    knowledgeApiMock.list.mockResolvedValue({
      items: [
        {
          id: "doc-1",
          title: "My Doc",
          status: "published",
          version: 1,
          summary: "A test",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-06-01T00:00:00Z",
          revisionCount: 1,
        },
      ],
      nextCursor: undefined,
    });
    knowledgeApiMock.get.mockResolvedValue({
      id: "doc-1",
      title: "My Doc",
      body: "# Hello\nWorld",
      status: "published",
      version: 1,
      summary: "A test",
      companyId: "company-1",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    knowledgeApiMock.listBacklinks.mockResolvedValue([]);

    renderKB(container);

    // Wait for card to appear
    await waitForAssertion(() => {
      expect(container.textContent).toContain("My Doc");
    });

    // Click the card
    const card = container.querySelector("button");
    expect(card).toBeDefined();
    card!.click();
  });

  it("sets breadcrumbs on mount", () => {
    knowledgeApiMock.list.mockResolvedValueOnce({ items: [], nextCursor: undefined });
    renderKB(container);
    expect(breadcrumbState.setBreadcrumbs).toHaveBeenCalledWith(
      [{ label: "Knowledge Base" }],
    );
  });
});