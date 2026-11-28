// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaseDetail } from "./CaseDetail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const caseFixture = {
  id: "case-1",
  companyId: "company-1",
  projectId: null,
  caseNumber: 4,
  identifier: "PAP-C4",
  caseType: "support",
  key: "plain-thread-1",
  title: "Investigate escalation (Plain th_01M7V3SF2W8R79ABCDEF0123456789)",
  summary: "Unbroken token summary_th_01M7V3SF2W8R79ABCDEF0123456789",
  status: "in_review",
  fields: {},
  parentCaseId: null,
  parent: null,
  labels: [],
  documents: [],
  taskDocuments: [],
  attachments: [],
  issueLinks: [],
  workIssueId: null,
  createdByAgentId: null,
  createdByUserId: null,
  completedAt: null,
  createdAt: "2026-08-01T10:00:00Z",
  updatedAt: "2026-08-01T10:00:00Z",
};

vi.mock("@/api/cases", () => ({
  casesApi: {
    get: vi.fn(async () => caseFixture),
    listChildren: vi.fn(async () => []),
  },
  caseAttachmentUrl: () => "",
  isImageAttachment: () => false,
}));

vi.mock("@/api/agents", () => ({
  agentsApi: { list: vi.fn(async () => []) },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: { get: vi.fn(async () => null) },
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/components/cases/CaseWorkSummary", () => ({
  CaseWorkSummary: () => null,
}));

vi.mock("@/components/cases/CaseHandoffHistory", () => ({
  CaseHandoffHistory: () => null,
}));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children: ReactNode } & React.ComponentProps<"a">) => (
      <a href={to} {...props}>{children}</a>
    ),
    useCaseHref: () => (identifier?: string) => (identifier ? `/cases/${identifier}` : "/cases"),
  };
});

describe("CaseDetail mobile wrapping", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    client.clear();
    container.remove();
  });

  it("applies break-words, wrap-anywhere, and min-w-0 to the CaseDetail heading so unbroken IDs cannot overflow 390px", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/cases/PAP-C4"]}>
            <Routes>
              <Route path="/cases/:caseIdentifier" element={<CaseDetail />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const heading = container.querySelector("h1");
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toContain("th_01M7V3SF2W8R79ABCDEF0123456789");
    expect(heading!.className).toContain("min-w-0");
    expect(heading!.className).toContain("break-words");
    expect(heading!.className).toContain("wrap-anywhere");
  });
});
