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

function buildTaskAttachment(sha256: string) {
  return {
    sha256,
    contentType: "application/octet-stream",
    originalFilename: null,
    byteSize: 1,
    commentIndex: null,
  };
}

function buildRichExportPreviewResult() {
  const base = buildExportPreviewResult();
  return {
    ...base,
    files: {
      "README.md": "# Paperclip\n",
      ".paperclip.yaml": "schema: paperclip/v1\n",
      "agents/ceo/AGENT.md": "# CEO\n",
      "tasks/one-off/TASK.md": "# One-off\n",
      "tasks/weekly-report/TASK.md": "# Weekly report\n",
      "blobs/aaa111": "binary",
    },
    manifest: {
      ...base.manifest,
      issues: [
        {
          slug: "one-off",
          title: "One-off",
          path: "tasks/one-off/TASK.md",
          recurring: false,
          attachments: [buildTaskAttachment("aaa111")],
        },
        {
          slug: "weekly-report",
          title: "Weekly report",
          path: "tasks/weekly-report/TASK.md",
          recurring: true,
          attachments: [],
        },
      ],
    },
    counts: { files: 6, agents: 1, skills: 0, projects: 0, issues: 2 },
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
    mockCompaniesApi.exportBundle.mockResolvedValue({ rootPath: "paperclip", files: {} });
    mockCompaniesApi.exportFidelity.mockResolvedValue(buildFidelityReport([]));
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:mock"),
      revokeObjectURL: vi.fn(),
    });
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

  function categoryInput(key: string): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>(`input[data-export-category="${key}"]`);
    if (!input) throw new Error(`No category toggle for ${key}`);
    return input;
  }

  function exportButton(): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.trim().startsWith("Export "),
    );
    if (!button) throw new Error("Export button not found");
    return button as HTMLButtonElement;
  }

  async function clickElement(element: HTMLElement) {
    await act(async () => {
      element.click();
    });
    await flushReact();
  }

  it("selects every file by default and requests them all on download", async () => {
    mockCompaniesApi.exportPreview.mockResolvedValue(buildRichExportPreviewResult());

    await renderPage();

    expect(container.textContent).toContain("Exporting 6 of 6 files");
    // The tree is a pure browser now — no per-file checkboxes.
    expect(container.querySelector('[role="tree"] input[type="checkbox"]')).toBeNull();

    await clickElement(exportButton());

    expect(mockCompaniesApi.exportBundle).toHaveBeenCalledTimes(1);
    const request = mockCompaniesApi.exportBundle.mock.calls[0]![1];
    expect(request.selectedFiles).toEqual([
      ".paperclip.yaml",
      "README.md",
      "agents/ceo/AGENT.md",
      "blobs/aaa111",
      "tasks/one-off/TASK.md",
      "tasks/weekly-report/TASK.md",
    ]);
  });

  it("toggling Tasks off drops one-off task files and their blobs but keeps routines", async () => {
    mockCompaniesApi.exportPreview.mockResolvedValue(buildRichExportPreviewResult());

    await renderPage();
    await clickElement(categoryInput("tasks"));

    expect(container.textContent).toContain("Exporting 4 of 6 files");
    // Routines can carry attachments, so Attachments stays enabled while routines remain.
    expect(categoryInput("attachments").disabled).toBe(false);
    // Excluded files render dimmed in the tree browser.
    expect(container.querySelector('[data-file-tree-path="blobs/aaa111"]')?.className).toContain("opacity-50");
    expect(container.querySelector('[data-file-tree-path="blobs"]')?.className).toContain("opacity-50");

    await clickElement(exportButton());

    expect(mockCompaniesApi.exportBundle).toHaveBeenCalledTimes(1);
    const request = mockCompaniesApi.exportBundle.mock.calls[0]![1];
    expect(request.selectedFiles).toEqual([
      ".paperclip.yaml",
      "README.md",
      "agents/ceo/AGENT.md",
      "tasks/weekly-report/TASK.md",
    ]);
  });

  it("disables Attachments once both Tasks and Routines are off", async () => {
    mockCompaniesApi.exportPreview.mockResolvedValue(buildRichExportPreviewResult());

    await renderPage();
    await clickElement(categoryInput("tasks"));
    await clickElement(categoryInput("routines"));

    const attachments = categoryInput("attachments");
    expect(attachments.disabled).toBe(true);
    expect(attachments.checked).toBe(false);
    expect(container.textContent).toContain("Exporting 3 of 6 files");
    expect(container.querySelector('[data-file-tree-path="tasks"]')?.className).toContain("opacity-50");
  });

  it("shows the estimated download size and updates it when a category toggles off", async () => {
    mockCompaniesApi.exportPreview.mockResolvedValue(buildRichExportPreviewResult());

    await renderPage();

    const sizeText = () =>
      container.textContent?.match(/Exporting [\d,]+ of [\d,]+ files \(~([\d.]+ [KMGT]?B)\)/)?.[1] ?? null;

    const initialSize = sizeText();
    expect(initialSize).not.toBeNull();

    await clickElement(categoryInput("tasks"));

    expect(container.textContent).toContain("Exporting 4 of 6 files");
    const toggledSize = sizeText();
    expect(toggledSize).not.toBeNull();
    // Dropping the one-off task and its blob shrinks the estimated zip.
    expect(toggledSize).not.toBe(initialSize);
  });

  it("renders the export fidelity panel with blocker and warning messages", async () => {
    mockCompaniesApi.exportFidelity.mockResolvedValue(buildFidelityReport([
      {
        code: "bundle_incompatible",
        severity: "blocker",
        message: "Importing this export will fail because the bundle references data this board cannot restore.",
      },
      {
        code: "approvals_not_exported",
        severity: "warning",
        message: "3 approvals are not included in the export bundle.",
      },
    ]));

    await renderPage();

    expect(mockCompaniesApi.exportFidelity).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Not included in this export");
    expect(container.textContent).toContain(
      "Importing this export will fail because the bundle references data this board cannot restore.",
    );
    expect(container.textContent).toContain("3 approvals are not included in the export bundle.");
  });

  it("renders no fidelity panel when the report has no warnings", async () => {
    await renderPage();

    expect(mockCompaniesApi.exportFidelity).toHaveBeenCalledWith("company-1");
    expect(container.textContent).not.toContain("Not included in this export");
  });
});
