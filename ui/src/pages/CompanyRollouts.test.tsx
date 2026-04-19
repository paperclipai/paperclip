// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CompanyRolloutPreviewResult,
  CompanyRolloutRelease,
  CompanyPortabilityExportPreviewResult,
} from "@paperclipai/shared";
import { CompanyRollouts } from "./CompanyRollouts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "source-company",
  selectedCompany: {
    id: "source-company",
    name: "Source Co",
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix: "SRC",
    issueCounter: 0,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: new Date("2026-04-18T00:00:00.000Z"),
    updatedAt: new Date("2026-04-18T00:00:00.000Z"),
  },
  companies: [
    {
      id: "source-company",
      name: "Source Co",
      status: "active",
    },
    {
      id: "target-active",
      name: "Target Active",
      status: "active",
    },
    {
      id: "target-paused",
      name: "Target Paused",
      status: "paused",
    },
    {
      id: "target-archived",
      name: "Target Archived",
      status: "archived",
    },
  ],
}));

const breadcrumbsState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const toastState = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

const companiesApiMock = vi.hoisted(() => ({
  exportPreview: vi.fn(),
}));

const companyRolloutsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  detail: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
}));

const exportPreview: CompanyPortabilityExportPreviewResult = {
  rootPath: ".",
  manifest: {
    schemaVersion: 1,
    generatedAt: "2026-04-18T00:00:00.000Z",
    source: {
      companyId: "source-company",
      companyName: "Source Co",
    },
    includes: {
      company: false,
      agents: true,
      projects: true,
      issues: true,
      skills: true,
    },
    company: null,
    sidebar: null,
    agents: [
      {
        slug: "builder",
        path: "agents/builder/AGENTS.md",
        name: "Builder",
        role: "engineer",
        title: null,
        icon: null,
        reportsToSlug: null,
        capabilities: null,
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        budgetMonthlyCents: 0,
        permissions: {},
        skills: [],
        metadata: null,
      },
    ],
    skills: [],
    projects: [],
    issues: [
      {
        slug: "weekly-review",
        identifier: null,
        path: "tasks/weekly-review/TASK.md",
        title: "Weekly review",
        description: null,
        dueDate: null,
        projectSlug: null,
        projectWorkspaceKey: null,
        assigneeAgentSlug: null,
        priority: "medium",
        status: "todo",
        recurring: true,
        routine: {
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          variables: [],
          triggers: [],
        },
        legacyRecurrence: null,
        labelIds: [],
        billingCode: null,
        executionWorkspaceSettings: null,
        assigneeAdapterOverrides: null,
        metadata: null,
      },
      {
        slug: "one-off",
        identifier: null,
        path: "tasks/one-off/TASK.md",
        title: "One off",
        description: null,
        dueDate: null,
        projectSlug: null,
        projectWorkspaceKey: null,
        assigneeAgentSlug: null,
        priority: "medium",
        status: "todo",
        recurring: false,
        routine: null,
        legacyRecurrence: null,
        labelIds: [],
        billingCode: null,
        executionWorkspaceSettings: null,
        assigneeAdapterOverrides: null,
        metadata: null,
      },
    ],
    envInputs: [],
  },
  files: {
    "agents/builder/AGENTS.md": "# Builder\n",
    "tasks/weekly-review/TASK.md": "# Weekly review\n",
    "tasks/one-off/TASK.md": "# One off\n",
  },
  fileInventory: [
    { path: "agents/builder/AGENTS.md", kind: "agent" },
    { path: "tasks/weekly-review/TASK.md", kind: "issue" },
    { path: "tasks/one-off/TASK.md", kind: "issue" },
  ],
  counts: {
    files: 3,
    agents: 1,
    skills: 0,
    projects: 0,
    issues: 2,
  },
  warnings: [],
  paperclipExtensionPath: ".paperclip.yaml",
};

const release: CompanyRolloutRelease = {
  id: "release-1",
  sourceCompanyId: "source-company",
  version: 1,
  title: "Operating model",
  notes: null,
  manifest: exportPreview.manifest,
  files: exportPreview.files,
  selectedFiles: ["agents/builder/AGENTS.md", "tasks/weekly-review/TASK.md"],
  packageHash: "a".repeat(64),
  counts: {
    files: 2,
    agents: 1,
    skills: 0,
    projects: 0,
    routines: 1,
    issues: 0,
  },
  createdByUserId: "user-1",
  createdAt: new Date("2026-04-18T00:00:00.000Z"),
};

function previewResult(errors: string[] = []): CompanyRolloutPreviewResult {
  return {
    release,
    targets: [
      {
        companyId: "target-active",
        companyName: "Target Active",
        companyStatus: "active",
        status: errors.length > 0 ? "failed" : "previewed",
        counts: {
          create: errors.length > 0 ? 0 : 2,
          update: 1,
          skipNoChange: 0,
          skipUnmanagedConflict: 0,
          error: errors.length,
        },
        warnings: [],
        errors,
        entityActions: [],
        updatedAt: null,
      },
    ],
  };
}

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbsState,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => toastState,
}));

vi.mock("../api/companies", () => ({
  companiesApi: companiesApiMock,
}));

vi.mock("../api/companyRollouts", () => ({
  companyRolloutsApi: companyRolloutsApiMock,
}));

function renderRollouts(container: HTMLDivElement): Root {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <CompanyRollouts />
      </QueryClientProvider>,
    );
  });
  return root;
}

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function buttonByText(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((entry) =>
    entry.textContent?.includes(text),
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button as HTMLButtonElement;
}

async function click(button: HTMLElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

describe("CompanyRollouts", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    companiesApiMock.exportPreview.mockReset();
    companiesApiMock.exportPreview.mockResolvedValue(exportPreview);
    companyRolloutsApiMock.list.mockReset();
    companyRolloutsApiMock.list.mockResolvedValue([release]);
    companyRolloutsApiMock.create.mockReset();
    companyRolloutsApiMock.preview.mockReset();
    companyRolloutsApiMock.preview.mockResolvedValue(previewResult());
    companyRolloutsApiMock.apply.mockReset();
    companyRolloutsApiMock.apply.mockResolvedValue(previewResult());
    breadcrumbsState.setBreadcrumbs.mockClear();
    toastState.pushToast.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("previews active targets by default and renders rollout counts", async () => {
    const root = renderRollouts(container);
    await flush();

    await click(buttonByText(container, "Preview"));

    expect(companyRolloutsApiMock.preview).toHaveBeenCalledWith("release-1", {
      targetCompanyIds: ["target-active"],
    });
    expect(container.textContent).toContain("Target Active");
    expect(container.textContent).toContain("Create");
    expect(container.textContent).toContain("Update");

    act(() => root.unmount());
  });

  it("disables apply when preview has blocking errors", async () => {
    companyRolloutsApiMock.preview.mockResolvedValue(previewResult(["Routine requires rolled-out project."]));
    const root = renderRollouts(container);
    await flush();

    await click(buttonByText(container, "Preview"));

    expect(container.textContent).toContain("Routine requires rolled-out project.");
    expect(buttonByText(container, "Apply").disabled).toBe(true);

    act(() => root.unmount());
  });
});
