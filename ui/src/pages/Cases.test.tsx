// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseSummary } from "@/api/cases";
import { Cases } from "./Cases";

function act(callback: () => void) {
  flushSync(callback);
}

const companyState = vi.hoisted(() => ({ selectedCompanyId: "company-1" }));
const mockCasesApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockProjectsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ listLabels: vi.fn() }));

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => companyState }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/api/cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/cases")>()),
  casesApi: mockCasesApi,
}));
vi.mock("@/api/projects", () => ({ projectsApi: mockProjectsApi }));
vi.mock("@/api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useCaseHref: () => (...segments: string[]) =>
    `/PAP/${["cases", ...segments].filter(Boolean).join("/")}`,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  flushSync(() => {});
}
async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      assertion();
      return;
    } catch (e) {
      lastError = e;
      await flush();
    }
  }
  throw lastError;
}

function createCase(overrides: Partial<CaseSummary>): CaseSummary {
  return {
    id: overrides.id ?? "case-1",
    companyId: "company-1",
    projectId: null,
    caseNumber: 1,
    identifier: overrides.identifier ?? "PAP-C1",
    caseType: overrides.caseType ?? "blog_post",
    key: null,
    title: overrides.title ?? "A case",
    summary: null,
    status: overrides.status ?? "in_progress",
    fields: {},
    parentCaseId: null,
    createdByAgentId: null,
    createdByUserId: null,
    completedAt: null,
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

function renderPage(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Cases />
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("Cases list", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockCasesApi.list.mockReset();
    mockProjectsApi.list.mockReset().mockResolvedValue([]);
    mockIssuesApi.listLabels.mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    container.remove();
  });

  it("requests active cases by default", async () => {
    mockCasesApi.list.mockResolvedValue([
      createCase({ id: "a", identifier: "PAP-C1", title: "Active post", status: "in_progress" }),
    ]);

    const root = renderPage(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Active post");
      expect(container.textContent).toContain("1 active · 1 total");
      expect(mockCasesApi.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
        status: "active",
        limit: 200,
      }));
    });

    act(() => root.unmount());
  });

  it("sends search filters to the cases API instead of filtering a fetched page locally", async () => {
    mockCasesApi.list.mockResolvedValue([
      createCase({ id: "a", identifier: "PAP-C1", title: "Active post", status: "in_progress" }),
    ]);
    const root = renderPage(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Active post");
    });

    const input = container.querySelector<HTMLInputElement>("input[placeholder='Search cases…']");
    expect(input).toBeTruthy();
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input, "launch");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockCasesApi.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({
        q: "launch",
        status: "active",
        limit: 200,
      }));
    });

    act(() => root.unmount());
  });

  it("renders the onboarding hero when there are no cases at all", async () => {
    mockCasesApi.list.mockResolvedValue([]);
    const root = renderPage(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("No cases yet");
      expect(container.textContent).toContain("references/cases.md");
    });

    // No create-case UI anywhere (agent-only v1).
    expect(container.textContent).not.toContain("New case");
    expect(container.textContent).not.toContain("Create case");

    act(() => root.unmount());
  });

  it("groups by case_type by default", async () => {
    mockCasesApi.list.mockResolvedValue([
      createCase({ id: "a", identifier: "PAP-C1", title: "Post one", caseType: "blog_post" }),
      createCase({ id: "b", identifier: "PAP-C2", title: "Storm one", caseType: "tweet_storm" }),
    ]);

    const root = renderPage(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("blog_post");
      expect(container.textContent).toContain("tweet_storm");
      expect(container.textContent).toContain("Post one");
      expect(container.textContent).toContain("Storm one");
    });

    act(() => root.unmount());
  });
});
