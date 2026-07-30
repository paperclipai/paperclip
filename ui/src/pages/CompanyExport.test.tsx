// @vitest-environment jsdom

import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExportFidelityReport } from "@paperclipai/shared/portability-fidelity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyExport } from "./CompanyExport";

const mockCompaniesApi = vi.hoisted(() => ({
  exportPreview: vi.fn(),
  exportBundle: vi.fn(),
  exportFidelity: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));
const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));
const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
  useOptionalCompany: () => null,
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/PAP/company/export", search: "" }),
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function buildExportPreviewResult() {
  return {
    rootPath: "paperclip",
    manifest: {
      agents: [],
      skills: [],
      projects: [],
      issues: [],
      envInputs: [],
      includes: { company: true, agents: true, projects: true, issues: true, skills: false },
      company: { name: "Paperclip", description: null },
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      source: null,
    },
    files: { "README.md": "# Paperclip\n" },
    fileInventory: [],
    counts: { files: 1, agents: 0, skills: 0, projects: 0, issues: 0 },
    warnings: [],
    paperclipExtensionPath: ".paperclip.yaml",
  };
}

function buildFidelityReport(warnings: ExportFidelityReport["warnings"]): ExportFidelityReport {
  return {
    schema: "paperclip-export-fidelity-v1",
    companyId: "company-1",
    counts: {
      labelDefinitions: 0,
      issueLabelReferences: 0,
      issueBlockerRelations: 0,
      issueDocuments: 0,
      issueWorkProducts: 0,
      issueAttachments: 0,
      approvals: 0,
      costEvents: 0,
      activityLogEntries: 0,
      issueMonitors: 0,
    },
    warnings,
    generatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("CompanyExport", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mockAgentsApi.list.mockResolvedValue([]);
    mockProjectsApi.list.mockResolvedValue([]);
    mockCompaniesApi.exportPreview.mockResolvedValue(buildExportPreviewResult());
    mockCompaniesApi.exportFidelity.mockResolvedValue(buildFidelityReport([]));
  });

  afterEach(async () => {
    if (root) {
      const currentRoot = root;
      await act(async () => {
        currentRoot.unmount();
      });
      root = null;
    }
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPage() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const currentRoot = root;

    await act(async () => {
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <CompanyExport />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();
  }

  it("renders the export fidelity panel with blocker and warning messages", async () => {
    mockCompaniesApi.exportFidelity.mockResolvedValue(buildFidelityReport([
      {
        code: "labels_require_mapping",
        severity: "blocker",
        message: "Importing this export will fail because 2 issue label references refer to label definitions that are not included in the export bundle.",
      },
      {
        code: "attachments_not_exported",
        severity: "warning",
        message: "3 issue attachments are not included in the export bundle.",
      },
    ]));

    await renderPage();

    expect(mockCompaniesApi.exportFidelity).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Not included in this export");
    expect(container.textContent).toContain(
      "Importing this export will fail because 2 issue label references refer to label definitions that are not included in the export bundle.",
    );
    expect(container.textContent).toContain("3 issue attachments are not included in the export bundle.");
  });

  it("renders no fidelity panel when the report has no warnings", async () => {
    await renderPage();

    expect(mockCompaniesApi.exportFidelity).toHaveBeenCalledWith("company-1");
    expect(container.textContent).not.toContain("Not included in this export");
  });
});
