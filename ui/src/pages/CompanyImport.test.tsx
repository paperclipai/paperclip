// @vitest-environment jsdom

import { webcrypto } from "node:crypto";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanyPortabilityImportResult, CompanyPortabilityPreviewResult } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { CompanyImportJobAccepted } from "../api/companies";
import { CompanyImport } from "./CompanyImport";

// jsdom's crypto has no SubtleCrypto; the chunked transfer path hashes parts
// with WebCrypto, so back the global with Node's implementation.
if (!globalThis.crypto?.subtle) {
  vi.stubGlobal("crypto", webcrypto);
}

const mockCompaniesApi = vi.hoisted(() => ({
  importPreview: vi.fn(),
  importPreviewPackage: vi.fn(),
  importBundle: vi.fn(),
  importBundleAsync: vi.fn(),
  importBundlePackageAsync: vi.fn(),
  importTransferCreate: vi.fn(),
  importTransferUploadPart: vi.fn(),
  importTransferStatus: vi.fn(),
  importTransferPreview: vi.fn(),
  importTransferApply: vi.fn(),
  getImportJob: vi.fn(),
  get: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  resume: vi.fn(),
  adapterModels: vi.fn(async () => [] as unknown[]),
  detectModel: vi.fn(async () => null),
  testEnvironment: vi.fn(),
  getActiveAdapterAuthLoginSession: vi.fn(async () => {
    throw new Error("no active session");
  }),
  getActiveClaudeSetupTokenLoginSession: vi.fn(async () => {
    throw new Error("no active session");
  }),
  getClaudeOAuthTokenStatus: vi.fn(async () => null),
}));
const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(async () => [] as unknown[]),
  capabilities: vi.fn(async () => ({ sandboxProviders: {} })),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(async () => ({ defaultEnvironmentId: null })),
  getExperimental: vi.fn(async () => ({})),
  getGeneral: vi.fn(async () => ({ executionMode: "any" })),
}));
const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(async () => [] as unknown[]),
  listProposals: vi.fn(async () => [] as unknown[]),
  listUserSecretDefinitions: vi.fn(async () => [] as unknown[]),
}));
const mockAdaptersApi = vi.hoisted(() => ({
  list: vi.fn(),
}));
const mockRoutinesApi = vi.hoisted(() => ({
  update: vi.fn(),
}));
const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));
const mockSidebarPreferencesApi = vi.hoisted(() => ({
  updateProjectOrder: vi.fn(),
}));
const mockPushToast = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockReadZipArchive = vi.hoisted(() => vi.fn());

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

// Keep the real sessionStorage bookkeeping so reload-resume is exercised, but
// make the poll delay instant so tests never wait the real 3s interval.
vi.mock("../lib/import-job-watch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/import-job-watch")>();
  return { ...actual, waitForNextImportJobPoll: () => Promise.resolve() };
});

vi.mock("../lib/zip", () => ({
  readZipArchive: mockReadZipArchive,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/environments", () => ({
  environmentsApi: mockEnvironmentsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("../api/adapters", () => ({
  adaptersApi: mockAdaptersApi,
}));

vi.mock("../api/routines", () => ({
  routinesApi: mockRoutinesApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/sidebarPreferences", () => ({
  sidebarPreferencesApi: mockSidebarPreferencesApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
  useOptionalCompany: () => null,
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
  useOptionalToastActions: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// MarkdownEditor pulls in @mdxeditor/editor, whose sandpack dependency inserts
// CSS rules jsdom cannot parse; the editor is never exercised by these tests.
vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value?: string }) => <textarea readOnly value={value ?? ""} />,
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

// The async import runs submit → poll → onSuccess, several awaits deep. Drain a
// handful of macrotask turns so the outcome/activation panels have committed.
async function settle(times = 6) {
  for (let index = 0; index < times; index += 1) {
    await flushReact();
  }
}

const previewFiles = {
  ".paperclip.yaml": 'schema: "paperclip/v1"\n',
  "agents/coder/AGENTS.md": "---\nname: Coder\n---\n\nYou write code.\n",
  "tasks/weekly-report/TASK.md": "---\nname: Weekly Report\nrecurring: true\n---\n\nSend the report.\n",
};

function buildPreviewResult(): CompanyPortabilityPreviewResult {
  return {
    include: { company: true, agents: true, projects: true, issues: true },
    targetCompanyId: null,
    targetCompanyName: null,
    collisionStrategy: "rename",
    selectedAgentSlugs: ["coder"],
    plan: {
      companyAction: "create",
      agentPlans: [{ slug: "coder", action: "create", plannedName: "Coder", existingAgentId: null, reason: null }],
      projectPlans: [],
      issuePlans: [{ slug: "weekly-report", action: "create", plannedTitle: "Weekly Report", reason: "Recurring task will be imported as a routine." }],
    },
    manifest: {
      agents: [{ slug: "coder", name: "Coder", path: "agents/coder/AGENTS.md", adapterType: "claude_local" }],
      projects: [],
      issues: [{ slug: "weekly-report", title: "Weekly Report", path: "tasks/weekly-report/TASK.md" }],
      skills: [],
      company: null,
    },
    files: previewFiles,
    envInputs: [],
    warnings: [],
    errors: [],
  } as unknown as CompanyPortabilityPreviewResult;
}

/** Preview whose manifest mixes adapters: one claude_local agent and one codex_local agent. */
function buildMixedAdapterPreviewResult(): CompanyPortabilityPreviewResult {
  return {
    include: { company: true, agents: true, projects: true, issues: true },
    targetCompanyId: null,
    targetCompanyName: null,
    collisionStrategy: "rename",
    selectedAgentSlugs: ["coder", "researcher"],
    plan: {
      companyAction: "create",
      agentPlans: [
        { slug: "coder", action: "create", plannedName: "Coder", existingAgentId: null, reason: null },
        { slug: "researcher", action: "create", plannedName: "Researcher", existingAgentId: null, reason: null },
      ],
      projectPlans: [],
      issuePlans: [],
    },
    manifest: {
      agents: [
        { slug: "coder", name: "Coder", path: "agents/coder/AGENTS.md", adapterType: "claude_local" },
        { slug: "researcher", name: "Researcher", path: "agents/researcher/AGENTS.md", adapterType: "codex_local" },
      ],
      projects: [],
      issues: [],
      skills: [],
      company: null,
    },
    files: {
      ".paperclip.yaml": 'schema: "paperclip/v1"\n',
      "agents/coder/AGENTS.md": "---\nname: Coder\n---\n\nYou write code.\n",
      "agents/researcher/AGENTS.md": "---\nname: Researcher\n---\n\nYou research.\n",
    },
    envInputs: [],
    warnings: [],
    errors: [],
  } as unknown as CompanyPortabilityPreviewResult;
}

function buildImportResult(): CompanyPortabilityImportResult {
  return {
    company: { id: "company-2", name: "Imported Test", action: "created" },
    agents: [{ slug: "coder", id: "agent-1", action: "created", name: "Coder", reason: null }],
    skills: [],
    projects: [],
    routines: [{ slug: "weekly-report", id: "routine-1", action: "created", title: "Weekly Report", status: "paused" }],
    envInputs: [],
    warnings: [],
  };
}

function buildAccepted(id = "job-1"): CompanyImportJobAccepted {
  return { job: { id, status: "running" }, statusUrl: `/companies/import/jobs/${id}` };
}

function buildTransferCreated(missingParts: number[], alreadyCompleted = false) {
  return {
    transferId: "transfer-1",
    status: "running",
    alreadyCompleted,
    totalParts: 2,
    missingParts,
  };
}

const TRANSFER_PART_SIZE = 32 * 1024 * 1024;

/**
 * A zip whose declared size crosses the 48 MB chunked-transfer threshold. Its
 * real content is one full part plus a 1 KB tail so the manifest slices into
 * two parts without allocating 48 MB in the test.
 */
function buildLargeZipFile(): File {
  const bytes = new Uint8Array(TRANSFER_PART_SIZE + 1024);
  const file = new File([bytes], "big-package.zip", { type: "application/zip" });
  Object.defineProperty(file, "size", { value: 49 * 1024 * 1024 });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
  return file;
}

function buildSucceededJob(id = "job-1") {
  return { job: { id, status: "succeeded" as const, importResult: buildImportResult() } };
}

describe("CompanyImport", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mockAgentsApi.list.mockResolvedValue([]);
    mockAdaptersApi.list.mockResolvedValue([
      { type: "claude_local", disabled: false },
      { type: "codex_local", disabled: false },
    ]);
    mockAgentsApi.resume.mockResolvedValue({ id: "agent-1", status: "idle" });
    mockRoutinesApi.update.mockResolvedValue({ id: "routine-1", status: "active" });
    mockCompaniesApi.importPreview.mockResolvedValue(buildPreviewResult());
    mockCompaniesApi.importPreviewPackage.mockResolvedValue(buildPreviewResult());
    // Default async flow: the submit is accepted (202) and the first poll finds
    // the job already finished with the full result. Individual tests override.
    mockCompaniesApi.importBundleAsync.mockResolvedValue(buildAccepted());
    mockCompaniesApi.importBundlePackageAsync.mockResolvedValue(buildAccepted());
    mockCompaniesApi.importTransferCreate.mockResolvedValue(buildTransferCreated([0, 1]));
    mockCompaniesApi.importTransferUploadPart.mockResolvedValue({ ok: true, index: 0, alreadyCompleted: false });
    mockCompaniesApi.importTransferPreview.mockResolvedValue(buildPreviewResult());
    mockCompaniesApi.importTransferApply.mockResolvedValue(buildAccepted());
    mockCompaniesApi.getImportJob.mockResolvedValue(buildSucceededJob());
    mockCompaniesApi.get.mockResolvedValue({ id: "company-2", name: "Imported Test", issuePrefix: "IMP" });
    mockSidebarPreferencesApi.updateProjectOrder.mockResolvedValue(undefined);
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
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  function findButton(matches: (text: string) => boolean) {
    return Array.from(container.querySelectorAll("button"))
      .find((button) => matches(button.textContent?.trim() ?? "")) as HTMLButtonElement | undefined;
  }

  async function clickButton(matches: (text: string) => boolean) {
    const button = findButton(matches);
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();
  }

  async function renderPage() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const currentRoot = root;

    await act(async () => {
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <CompanyImport />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  async function enterGithubUrl(url = "https://github.com/acme/starter/tree/main/company") {
    const urlInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="https://github.com/owner/repo/tree/main/company"]',
    );
    expect(urlInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(urlInput!, url);
      urlInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();
  }

  async function chooseLocalZip(file: File) {
    await clickButton((text) => text.includes("Local zip"));
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).toBeTruthy();
    Object.defineProperty(fileInput!, "files", { value: [file], configurable: true });
    await act(async () => {
      fileInput!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
  }

  async function renderPageAndImport() {
    await renderPage();
    await enterGithubUrl();

    await clickButton((text) => text === "Preview import");

    // Paused-import checkbox is present and checked by default.
    const pauseLabel = Array.from(container.querySelectorAll("label"))
      .find((label) => label.textContent?.includes("Start imported agents and routines paused"));
    expect(pauseLabel).toBeTruthy();
    expect(pauseLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);

    await clickButton((text) => text.startsWith("Import 3 file"));
    await settle();
  }

  it("submits the import as an async job, then activates selected agents and routines", async () => {
    await renderPageAndImport();

    expect(mockCompaniesApi.importBundleAsync).toHaveBeenCalledWith(
      expect.objectContaining({ pauseAutomations: true }),
    );
    // The page polls the job it was handed and runs the same activation path
    // the synchronous response used to drive.
    expect(mockCompaniesApi.getImportJob).toHaveBeenCalledWith("job-1");
    expect(container.textContent).toContain("Import complete");
    expect(container.textContent).toContain("Activate imported agents and routines");
    expect(container.textContent).toContain("Coder");
    expect(container.textContent).toContain("Weekly Report");

    await clickButton((text) => text.startsWith("Activate selected"));

    expect(mockAgentsApi.resume).toHaveBeenCalledWith("agent-1");
    expect(mockRoutinesApi.update).toHaveBeenCalledWith("routine-1", { status: "active" });
    expect(container.textContent).toContain("activated");
    expect(container.textContent).not.toContain("failed:");
    expect(findButton((text) => text === "Go to dashboard")).toBeTruthy();
  });

  it("keeps activating remaining items and surfaces per-item failures", async () => {
    mockAgentsApi.resume.mockRejectedValue(new Error("resume exploded"));
    await renderPageAndImport();

    await clickButton((text) => text.startsWith("Activate selected"));

    expect(mockAgentsApi.resume).toHaveBeenCalledWith("agent-1");
    expect(mockRoutinesApi.update).toHaveBeenCalledWith("routine-1", { status: "active" });
    expect(container.textContent).toContain("failed: resume exploded");
    expect(container.textContent).toContain("activated");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });

  it("uploads a local .zip as a multipart package and never blocks on inline size", async () => {
    // Even a package whose inflated inline JSON would blow past the old browser
    // limit uploads fine now: the raw compressed zip goes up as multipart and is
    // unzipped server-side, so the inline-size ceiling no longer gates it.
    mockReadZipArchive.mockResolvedValue({
      rootPath: "big-package",
      files: {
        "COMPANY.md": "---\nname: Big\n---\n",
        ".paperclip.yaml": 'schema: "paperclip/v1"\n',
        "blobs/4f2d1c9a": {
          encoding: "base64",
          data: "A".repeat(57 * 1024 * 1024),
          contentType: "application/octet-stream",
        },
      },
    });

    await renderPage();

    await clickButton((text) => text.includes("Local zip"));

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).toBeTruthy();
    const file = new File(["stub-zip-bytes"], "big-package.zip", { type: "application/zip" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(0) });
    Object.defineProperty(fileInput!, "files", { value: [file] });
    await act(async () => {
      fileInput!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    // The inline preflight no longer blocks the zip path.
    expect(container.textContent).not.toContain("Package too large for browser import");
    expect(container.textContent).not.toContain("CLI folder import");
    expect(findButton((text) => text === "Preview import")?.disabled).toBe(false);

    await clickButton((text) => text === "Preview import");
    // The preview goes up as a multipart package (the raw File), not inline JSON.
    expect(mockCompaniesApi.importPreviewPackage).toHaveBeenCalledTimes(1);
    expect(mockCompaniesApi.importPreview).not.toHaveBeenCalled();
    expect(mockCompaniesApi.importPreviewPackage.mock.calls[0]![0]).toBe(file);

    await clickButton((text) => text.startsWith("Import 3 file"));
    await settle();

    // The apply also uploads the raw File as a multipart async job — never the
    // inflated inline body that truncated in transit.
    expect(mockCompaniesApi.importBundleAsync).not.toHaveBeenCalled();
    expect(mockCompaniesApi.importBundlePackageAsync).toHaveBeenCalledTimes(1);
    const [sentFile, meta] = mockCompaniesApi.importBundlePackageAsync.mock.calls[0]! as [
      File,
      { pauseAutomations: boolean; target: { mode: string } },
    ];
    expect(sentFile).toBe(file);
    expect(sentFile.name).toBe("big-package.zip");
    expect(meta.pauseAutomations).toBe(true);
    // The bundle itself is never expanded into the request; only the raw zip travels.
    expect(meta).not.toHaveProperty("source");
    // A zip under the chunked threshold never touches the transfer machinery.
    expect(mockCompaniesApi.importTransferCreate).not.toHaveBeenCalled();
    expect(mockCompaniesApi.importTransferUploadPart).not.toHaveBeenCalled();
  });

  it("uploads a large local .zip through the chunked transfer path for preview and import", async () => {
    mockReadZipArchive.mockResolvedValue({ rootPath: "big-package", files: previewFiles });
    mockCompaniesApi.importTransferCreate
      .mockResolvedValueOnce(buildTransferCreated([0, 1]))
      // The import's re-declaration resumes the transfer the preview uploaded.
      .mockResolvedValueOnce(buildTransferCreated([]));

    // Hold the last part so the visible upload progress can be observed.
    let resolveLastPart!: (value: { ok: true; index: number; alreadyCompleted: boolean }) => void;
    mockCompaniesApi.importTransferUploadPart.mockImplementation((_id: string, index: number) => {
      if (index === 0) return Promise.resolve({ ok: true, index, alreadyCompleted: false });
      return new Promise((resolve) => {
        resolveLastPart = resolve;
      });
    });

    await renderPage();
    await chooseLocalZip(buildLargeZipFile());
    await clickButton((text) => text === "Preview import");
    await vi.waitFor(() => {
      expect(mockCompaniesApi.importTransferUploadPart).toHaveBeenCalledTimes(2);
    });
    await flushReact();

    expect(container.textContent).toContain("Uploading part 2 of 2");
    expect(container.textContent).toContain("32 MB");

    await act(async () => {
      resolveLastPart({ ok: true, index: 1, alreadyCompleted: false });
    });
    await vi.waitFor(() => {
      expect(mockCompaniesApi.importTransferPreview).toHaveBeenCalledTimes(1);
    });
    await settle();

    // The declaration describes the sliced zip: whole-file hash plus one
    // content hash per 32 MB byte range.
    const manifest = mockCompaniesApi.importTransferCreate.mock.calls[0]![0] as {
      totalBytes: number;
      zipSha256: string;
      partSizeBytes: number;
      parts: Array<{ index: number; byteSize: number; sha256: string }>;
    };
    expect(manifest.totalBytes).toBe(TRANSFER_PART_SIZE + 1024);
    expect(manifest.partSizeBytes).toBe(TRANSFER_PART_SIZE);
    expect(manifest.zipSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.parts.map((part) => ({ index: part.index, byteSize: part.byteSize }))).toEqual([
      { index: 0, byteSize: TRANSFER_PART_SIZE },
      { index: 1, byteSize: 1024 },
    ]);
    expect(manifest.parts.every((part) => /^[0-9a-f]{64}$/.test(part.sha256))).toBe(true);

    // Both parts traveled, then the preview ran against the assembled spool —
    // never the single-shot multipart endpoints.
    expect(mockCompaniesApi.importTransferUploadPart).toHaveBeenNthCalledWith(1, "transfer-1", 0, expect.anything());
    expect(mockCompaniesApi.importTransferUploadPart).toHaveBeenNthCalledWith(2, "transfer-1", 1, expect.anything());
    expect(mockCompaniesApi.importTransferPreview).toHaveBeenCalledWith(
      "transfer-1",
      expect.objectContaining({ collisionStrategy: "rename", target: { mode: "new_company", newCompanyName: null } }),
    );
    expect(mockCompaniesApi.importPreviewPackage).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Import preview");

    await clickButton((text) => text.startsWith("Import 3 file"));
    await vi.waitFor(() => {
      expect(mockCompaniesApi.importTransferApply).toHaveBeenCalledTimes(1);
    });
    await settle();

    // The resumed transfer had nothing left to upload, so the apply reused
    // the spooled parts and ran as the usual async job.
    expect(mockCompaniesApi.importTransferCreate).toHaveBeenCalledTimes(2);
    expect(mockCompaniesApi.importTransferUploadPart).toHaveBeenCalledTimes(2);
    expect(mockCompaniesApi.importTransferApply).toHaveBeenCalledWith(
      "transfer-1",
      expect.objectContaining({ pauseAutomations: true }),
    );
    expect(mockCompaniesApi.importBundlePackageAsync).not.toHaveBeenCalled();
    expect(mockCompaniesApi.getImportJob).toHaveBeenCalledWith("job-1");
    expect(container.textContent).toContain("Import complete");
  });

  it("retries a failed part before surfacing the error panel, keeping the transfer resumable", async () => {
    mockReadZipArchive.mockResolvedValue({ rootPath: "big-package", files: previewFiles });
    mockCompaniesApi.importTransferCreate.mockResolvedValue(buildTransferCreated([0, 1]));
    mockCompaniesApi.importTransferUploadPart.mockImplementation((_id: string, index: number) => {
      if (index === 0) return Promise.resolve({ ok: true, index, alreadyCompleted: false });
      return Promise.reject(new Error("socket hang up"));
    });

    await renderPage();
    await chooseLocalZip(buildLargeZipFile());
    await clickButton((text) => text === "Preview import");
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Preview failed: socket hang up");
    });

    // Part 1 was attempted three times before the failure surfaced; the
    // preview never ran and no state was consumed, so retrying can resume.
    const partOneAttempts = mockCompaniesApi.importTransferUploadPart.mock.calls.filter(
      (call) => call[1] === 1,
    );
    expect(partOneAttempts).toHaveLength(3);
    expect(mockCompaniesApi.importTransferPreview).not.toHaveBeenCalled();
    expect(findButton((text) => text === "Preview import")?.disabled).toBe(false);

    // Retry: the re-declared transfer reports only the lost part missing, so
    // just that part travels again.
    mockCompaniesApi.importTransferCreate.mockResolvedValue(buildTransferCreated([1]));
    mockCompaniesApi.importTransferUploadPart.mockResolvedValue({ ok: true, index: 1, alreadyCompleted: false });
    mockCompaniesApi.importTransferUploadPart.mockClear();

    await clickButton((text) => text === "Preview import");
    await vi.waitFor(() => {
      expect(mockCompaniesApi.importTransferPreview).toHaveBeenCalledTimes(1);
    });
    await settle();

    expect(mockCompaniesApi.importTransferUploadPart).toHaveBeenCalledTimes(1);
    expect(mockCompaniesApi.importTransferUploadPart).toHaveBeenCalledWith("transfer-1", 1, expect.anything());
    expect(container.textContent).toContain("Import preview");
  });

  it("re-uploads only the missing parts when resuming an interrupted transfer", async () => {
    // A previous page load already uploaded part 0; re-declaring the same
    // file resumes that transfer, so only part 1 travels.
    mockReadZipArchive.mockResolvedValue({ rootPath: "big-package", files: previewFiles });
    mockCompaniesApi.importTransferCreate.mockResolvedValue(buildTransferCreated([1]));

    await renderPage();
    await chooseLocalZip(buildLargeZipFile());
    await clickButton((text) => text === "Preview import");
    await vi.waitFor(() => {
      expect(mockCompaniesApi.importTransferPreview).toHaveBeenCalledTimes(1);
    });
    await settle();

    expect(mockCompaniesApi.importTransferUploadPart).toHaveBeenCalledTimes(1);
    expect(mockCompaniesApi.importTransferUploadPart).toHaveBeenCalledWith("transfer-1", 1, expect.anything());
    expect(container.textContent).toContain("Import preview");
  });

  it("explains the disabled preview button until a package is chosen", async () => {
    await renderPage();

    expect(findButton((text) => text === "Preview import")?.disabled).toBe(true);
    expect(container.textContent).toContain("Choose a package above to enable the preview.");

    await enterGithubUrl();

    expect(findButton((text) => text === "Preview import")?.disabled).toBe(false);
    expect(container.textContent).not.toContain("Choose a package above to enable the preview.");
  });

  it("shows a progress panel while the preview runs and a durable error panel when it fails", async () => {
    let rejectPreview!: (err: Error) => void;
    mockCompaniesApi.importPreview.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPreview = reject;
        }),
    );
    await renderPage();
    await enterGithubUrl();

    await clickButton((text) => text === "Preview import");

    expect(container.textContent).toContain("Uploading and analyzing your package");
    expect(container.textContent).toContain("Keep this page open.");

    // A mid-flight config edit keeps the progress panel visible (the request
    // really is still running) but supersedes the request, so its failure
    // settles silently instead of describing a package no longer selected.
    await enterGithubUrl("https://github.com/acme/starter-b/tree/main/company");

    expect(container.textContent).toContain("Uploading and analyzing your package");

    await act(async () => {
      rejectPreview(new Error("stream disconnected"));
    });
    await flushReact();

    expect(container.textContent).not.toContain("Uploading and analyzing your package");
    expect(container.textContent).not.toContain("Preview failed:");
    expect(mockPushToast).not.toHaveBeenCalled();

    // A failure of the currently configured request renders a durable panel.
    await clickButton((text) => text === "Preview import");
    await act(async () => {
      rejectPreview(new Error("stream disconnected"));
    });
    await flushReact();

    expect(container.textContent).toContain("Preview failed: stream disconnected");
    expect(container.textContent).toContain("Retry, or re-export the package without large attachments");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));

    // Changing the package supersedes the failed request: the error panel resets.
    await enterGithubUrl("https://github.com/acme/other-starter/tree/main/company");

    expect(container.textContent).not.toContain("Preview failed:");
  });

  it("shows a progress panel while the import runs and a durable error panel when it fails", async () => {
    // The submit stays pending across the whole job, so the progress panel and
    // structural locks cover it. Rejecting the submit surfaces the error panel.
    let rejectImport!: (err: Error) => void;
    mockCompaniesApi.importBundleAsync.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectImport = reject;
        }),
    );
    await renderPage();
    await enterGithubUrl();
    await clickButton((text) => text === "Preview import");

    await clickButton((text) => text.startsWith("Import 3 file"));

    expect(container.textContent).toContain("Import running on the server");
    expect(container.textContent).toContain("safe to keep waiting");

    // While the import runs, previewing and the structural package/settings
    // controls are locked (and explained), so nothing can replace or unmount
    // the plan the import started from.
    expect(findButton((text) => text === "Preview import")?.disabled).toBe(true);
    expect(container.textContent).toContain(
      "Import in progress — the package and settings unlock when it finishes.",
    );
    const lockedUrlInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="https://github.com/owner/repo/tree/main/company"]',
    );
    expect(lockedUrlInput?.disabled).toBe(true);
    const lockedSelects = Array.from(container.querySelectorAll("select")).filter(
      (select) => select.value === "new" || select.value === "rename",
    );
    expect(lockedSelects).toHaveLength(2);
    expect(lockedSelects.every((select) => select.disabled)).toBe(true);

    // Config edits while the import is in flight must not detach it from
    // the UI: the progress panel keeps reporting it until it settles.
    const midFlightNameInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Imported Organization"]',
    );
    expect(midFlightNameInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(midFlightNameInput!, "Mid Flight");
      midFlightNameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Import running on the server");

    await act(async () => {
      rejectImport(new Error("connection reset"));
    });
    await flushReact();

    expect(container.textContent).not.toContain("Import running on the server");
    expect(container.textContent).toContain("Import failed: connection reset");
    expect(container.textContent).toContain("check the target company before retrying.");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));

    // The new-company name feeds the request payload too: editing it clears
    // the stale error panel without discarding the rendered preview.
    const nameInput = container.querySelector<HTMLInputElement>('input[placeholder="Imported Organization"]');
    expect(nameInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(nameInput!, "Renamed Import");
      nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).not.toContain("Import failed:");
    expect(findButton((text) => text.startsWith("Import 3 file"))).toBeTruthy();
    expect(findButton((text) => text === "Preview import")?.disabled).toBe(false);
    expect(
      container.querySelector<HTMLInputElement>(
        'input[placeholder="https://github.com/owner/repo/tree/main/company"]',
      )?.disabled,
    ).toBe(false);

    // The pause toggle feeds the request payload too: after another failed
    // attempt, toggling it also supersedes the request and clears the panel.
    await clickButton((text) => text.startsWith("Import 3 file"));
    await act(async () => {
      rejectImport(new Error("second failure"));
    });
    await flushReact();

    expect(container.textContent).toContain("Import failed: second failure");

    const pauseInput = Array.from(container.querySelectorAll("label"))
      .find((label) => label.textContent?.includes("Start imported agents and routines paused"))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(pauseInput).toBeTruthy();
    await act(async () => {
      pauseInput!.click();
    });
    await flushReact();

    expect(container.textContent).not.toContain("Import failed:");

    // File-selection edits feed the payload too and supersede a failure.
    await clickButton((text) => text.startsWith("Import 3 file"));
    await act(async () => {
      rejectImport(new Error("third failure"));
    });
    await flushReact();

    expect(container.textContent).toContain("Import failed: third failure");

    const fileCheckbox = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).find((input) => !input.closest("label")?.textContent?.includes("Start imported agents"));
    expect(fileCheckbox).toBeTruthy();
    await act(async () => {
      fileCheckbox!.click();
    });
    await flushReact();

    expect(container.textContent).not.toContain("Import failed:");

    // Changing the package supersedes the failed import: previewing a fresh
    // package must not resurface the stale import error panel.
    await enterGithubUrl("https://github.com/acme/other-starter/tree/main/company");
    await clickButton((text) => text === "Preview import");

    expect(findButton((text) => text.startsWith("Import 3 file"))).toBeTruthy();
    expect(container.textContent).not.toContain("Import failed:");

    // The outcome reports the submitted pause option, not the live checkbox:
    // a mid-flight toggle must not change what the completed import did. The
    // submit stays pending until we resolve it to the accepted job.
    let resolveAccepted!: (value: CompanyImportJobAccepted) => void;
    mockCompaniesApi.importBundleAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAccepted = resolve;
        }),
    );
    mockCompaniesApi.getImportJob.mockResolvedValue(buildSucceededJob("job-final"));
    await clickButton((text) => text.startsWith("Import 3 file"));

    expect(mockCompaniesApi.importBundleAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ pauseAutomations: false }),
    );

    const midFlightPauseInput = Array.from(container.querySelectorAll("label"))
      .find((label) => label.textContent?.includes("Start imported agents and routines paused"))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(midFlightPauseInput).toBeTruthy();
    await act(async () => {
      midFlightPauseInput!.click();
    });
    await flushReact();

    await act(async () => {
      resolveAccepted(buildAccepted("job-final"));
    });
    await settle();

    expect(container.textContent).toContain("Import complete");
    expect(container.textContent).not.toContain("Activate imported agents and routines");
  });

  it("adopts the already-running job when the server reports a 409", async () => {
    mockCompaniesApi.importBundleAsync.mockRejectedValueOnce(
      new ApiError("An import is already running for this account", 409, {
        job: { id: "job-existing", status: "running" },
        statusUrl: "/companies/import/jobs/job-existing",
      }),
    );
    mockCompaniesApi.getImportJob.mockResolvedValue(buildSucceededJob("job-existing"));

    await renderPageAndImport();

    // The duplicate submit adopts the running job from the 409 body and polls
    // it instead of firing a second import.
    expect(mockCompaniesApi.getImportJob).toHaveBeenCalledWith("job-existing");
    expect(container.textContent).toContain("Import complete");
    expect(container.textContent).toContain("Activate imported agents and routines");
  });

  it("surfaces a failed import job in the durable error panel", async () => {
    mockCompaniesApi.getImportJob.mockResolvedValue({
      job: { id: "job-1", status: "failed", error: { message: "blob mismatch" } },
    });

    await renderPage();
    await enterGithubUrl();
    await clickButton((text) => text === "Preview import");
    await clickButton((text) => text.startsWith("Import 3 file"));
    await settle();

    expect(container.textContent).toContain("Import failed: blob mismatch");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });

  it("terminates the import when polling hits a permanent auth error", async () => {
    // A 403 (expired or revoked board session) will never recover by polling
    // again, so the watch must stop and surface an error instead of leaving the
    // import locked in its running state forever.
    mockCompaniesApi.getImportJob.mockRejectedValue(
      new ApiError("Board access required", 403, { error: "Board access required" }),
    );

    await renderPage();
    await enterGithubUrl();
    await clickButton((text) => text === "Preview import");
    await clickButton((text) => text.startsWith("Import 3 file"));
    await settle();

    expect(container.textContent).not.toContain("Import running on the server");
    expect(container.textContent).toContain("your session may have expired");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });

  it("keeps watching through a transient poll failure", async () => {
    // A one-off 5xx is transient: the job is still running server-side, so the
    // watch must keep polling and settle on the eventual success rather than
    // treating the blip as a terminal failure.
    mockCompaniesApi.getImportJob
      .mockRejectedValueOnce(new ApiError("upstream unavailable", 503, null))
      .mockResolvedValue(buildSucceededJob("job-1"));

    await renderPageAndImport();

    expect(container.textContent).not.toContain("Import failed:");
    expect(container.textContent).toContain("Import complete");
  });

  it("treats a server-confirmed success without a full result as a soft success and refreshes the company list", async () => {
    // The server reports the job `succeeded` but retains only the compact
    // summary (a cloud tenant job, or a board job whose full in-memory result
    // aged out): status is a confirmed success, `importResult` is gone, and the
    // summary still carries the company id. That is a success we can no longer
    // fully read — never a scary failure.
    mockCompaniesApi.getImportJob.mockResolvedValue({
      job: { id: "job-1", status: "succeeded", result: { companyId: "company-2" } },
    });

    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    try {
      await renderPageAndImport();

      // Success-leaning panel, not the failure panel.
      expect(container.textContent).toContain("Import completed");
      // The readable company gives the panel a name and a direct CTA into the
      // new company's dashboard, plus the paused-agents pointer.
      expect(container.textContent).toContain("Imported Test");
      // The default import submits with pauseAutomations checked, so the
      // paused pointer must show; it is gated off when the user unchecks it.
      expect(container.textContent).toContain("Imported agents arrived paused");
      const openCompany = container.querySelector('[data-testid="import-expired-open-company"]');
      expect(openCompany).not.toBeNull();
      expect(container.textContent).not.toContain("Import failed");
      expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "success" }));
      // The company list is refreshed so the new company appears in the switcher.
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["companies"] }));
      // The summary's company id still drives navigation into the import.
      expect(mockSetSelectedCompanyId).toHaveBeenCalledWith("company-2");
    } finally {
      invalidateSpy.mockRestore();
    }
  });

  it("falls back to switcher guidance when the expired job's company is unreadable", async () => {
    mockCompaniesApi.getImportJob.mockResolvedValue({
      job: { id: "job-1", status: "succeeded", result: { companyId: "company-2" } },
    });
    mockCompaniesApi.get.mockRejectedValue(new Error("forbidden"));

    await renderPageAndImport();

    expect(container.textContent).toContain("Import completed");
    expect(container.textContent).toContain("select it from the organization switcher");
    // No readable company, so no dashboard CTA — the switcher guidance stands in.
    expect(container.querySelector('[data-testid="import-expired-open-company"]')).toBeNull();
  });

  it("surfaces a first-poll 404 as an error because the job never existed", async () => {
    // A 404 on the very first poll — before the client ever saw the job
    // running — means the id never existed. That stays a hard error.
    mockCompaniesApi.getImportJob.mockRejectedValue(
      new ApiError("Import job not found", 404, { error: "Import job not found" }),
    );

    await renderPage();
    await enterGithubUrl();
    await clickButton((text) => text === "Preview import");
    await clickButton((text) => text.startsWith("Import 3 file"));
    await settle();

    expect(container.textContent).toContain("Import failed:");
    expect(container.textContent).toContain("it may have restarted while the import ran");
    expect(container.textContent).not.toContain("Import completed");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });

  it("surfaces a running-then-gone job as an error because the server restarted mid-import", async () => {
    // The first poll finds the job running; the next poll 404s. A running job is
    // never dropped by the retention sweep (only settled jobs age out), so its
    // disappearance means the server restarted mid-import — the import never
    // reached a confirmed success and may not have finished. Report that
    // honestly instead of masking a possibly-incomplete import as completed.
    mockCompaniesApi.getImportJob
      .mockResolvedValueOnce({ job: { id: "job-1", status: "running" } })
      .mockRejectedValue(new ApiError("Import job not found", 404, { error: "Import job not found" }));

    await renderPage();
    await enterGithubUrl();
    await clickButton((text) => text === "Preview import");
    await clickButton((text) => text.startsWith("Import 3 file"));
    await settle();

    expect(container.textContent).toContain("Import failed:");
    expect(container.textContent).toContain("it may have restarted while the import ran");
    expect(container.textContent).not.toContain("Import completed");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });

  it("refreshes the company list on a full import success", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    try {
      await renderPageAndImport();

      expect(container.textContent).toContain("Import complete");
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["companies"] }));
    } finally {
      invalidateSpy.mockRestore();
    }
  });

  it("resumes watching a stored import job on mount", async () => {
    // A previous page load persisted a running job; reloading must resume
    // watching it rather than showing the stale form.
    sessionStorage.setItem(
      "paperclip:company-import-job:company-1:acme/starter",
      JSON.stringify({ jobId: "job-resume", pauseAutomations: false }),
    );

    let resolveFirstPoll!: (value: ReturnType<typeof buildSucceededJob>) => void;
    mockCompaniesApi.getImportJob.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstPoll = resolve;
        }),
    );

    await renderPage();

    // The resume panel is shown while the first poll is in flight, and no new
    // submit was fired — the job is only being watched.
    expect(container.textContent).toContain("Resume watching import");
    expect(mockCompaniesApi.importBundleAsync).not.toHaveBeenCalled();
    expect(mockCompaniesApi.getImportJob).toHaveBeenCalledWith("job-resume");

    await act(async () => {
      resolveFirstPoll(buildSucceededJob("job-resume"));
    });
    await settle();

    expect(container.textContent).not.toContain("Resume watching import");
    expect(container.textContent).toContain("Import complete");
    // The stored entry is cleared once the job settles.
    expect(sessionStorage.getItem("paperclip:company-import-job:company-1:acme/starter")).toBeNull();
  });

  /** Adapter selects in the picker list, in manifest order (excludes the target/collision selects). */
  function findAdapterSelects() {
    return Array.from(container.querySelectorAll("select"))
      .filter((select) => select.value !== "new" && select.value !== "existing" && select.value !== "rename");
  }

  async function previewMixedAdapterPackage() {
    mockCompaniesApi.importPreview.mockResolvedValue(buildMixedAdapterPreviewResult());
    await renderPage();
    await enterGithubUrl();
    await clickButton((text) => text === "Preview import");
  }

  function lastImportMeta() {
    const call = mockCompaniesApi.importBundleAsync.mock.calls.at(-1);
    expect(call).toBeTruthy();
    return call![0] as { adapterOverrides?: Record<string, { adapterType: string }> };
  }

  it("keeps manifest adapters and sends no overrides when the user touches nothing", async () => {
    await previewMixedAdapterPackage();

    // The picker shows each agent's source adapter, not a coerced CEO default.
    expect(findAdapterSelects().map((select) => select.value)).toEqual(["claude_local", "codex_local"]);

    await clickButton((text) => text.startsWith("Import 3 file"));
    await settle();

    // Untouched agents flow through with no override at all, so the server
    // applies each agent's manifest adapterType.
    expect(lastImportMeta().adapterOverrides).toBeUndefined();
  });

  it("sends an override only for the agent whose adapter the user changed", async () => {
    await previewMixedAdapterPackage();

    const coderSelect = findAdapterSelects()[0];
    expect(coderSelect?.value).toBe("claude_local");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(coderSelect!, "codex_local");
      coderSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    await clickButton((text) => text.startsWith("Import 3 file"));
    await settle();

    expect(lastImportMeta().adapterOverrides).toEqual({
      coder: { adapterType: "codex_local" },
    });
  });

  it("hides Paperclip Runner import configuration while its experimental flag is off", async () => {
    mockAdaptersApi.list.mockResolvedValue([
      { type: "claude_local", disabled: false },
      { type: "codex_local", disabled: false },
      { type: "paperclip_runner", disabled: true },
    ]);
    await previewMixedAdapterPackage();

    for (const select of findAdapterSelects()) {
      expect(Array.from(select.options).map((option) => option.value))
        .not.toContain("paperclip_runner");
    }
  });

  it("offers Paperclip Runner import configuration after its experimental flag is enabled", async () => {
    mockAdaptersApi.list.mockResolvedValue([
      { type: "claude_local", disabled: false },
      { type: "codex_local", disabled: false },
      { type: "paperclip_runner", disabled: false },
    ]);
    await previewMixedAdapterPackage();

    for (const select of findAdapterSelects()) {
      expect(Array.from(select.options).map((option) => option.value))
        .toContain("paperclip_runner");
    }
  });

  it("falls back to the CEO adapter with a visible warning when a manifest adapter is not installed", async () => {
    // The destination has no codex_local adapter; the CEO fallback (an empty
    // agent list defaults to claude_local) takes over — never silently.
    mockAdaptersApi.list.mockResolvedValue([{ type: "claude_local", disabled: false }]);
    await previewMixedAdapterPackage();

    expect(container.textContent).toContain("source adapter codex_local is not installed here");
    expect(container.textContent).toContain("will use Claude Code");
    expect(findAdapterSelects().map((select) => select.value)).toEqual(["claude_local", "claude_local"]);

    await clickButton((text) => text.startsWith("Import 3 file"));
    await settle();

    // Only the unavailable agent is overridden; the claude_local agent still
    // carries no override and keeps its manifest adapter.
    expect(lastImportMeta().adapterOverrides).toEqual({
      researcher: { adapterType: "claude_local" },
    });
  });

  it("picks an installed adapter as the fallback when the CEO adapter is itself unavailable", async () => {
    // Neither codex_local nor the CEO fallback (claude_local) is installed;
    // the fallback must be an adapter that actually exists on the
    // destination, never an unavailable type the server would reject.
    mockAdaptersApi.list.mockResolvedValue([{ type: "gemini_local", disabled: false }]);
    await previewMixedAdapterPackage();

    expect(container.textContent).toContain("source adapter codex_local is not installed here");
    expect(findAdapterSelects().map((select) => select.value)).toEqual(["gemini_local", "gemini_local"]);

    await clickButton((text) => text.startsWith("Import 3 file"));
    await settle();

    expect(lastImportMeta().adapterOverrides).toEqual({
      researcher: { adapterType: "gemini_local" },
      coder: { adapterType: "gemini_local" },
    });
  });

  it("fails open to manifest adapters when the adapter list cannot be read", async () => {
    // Unknown availability must never coerce: with no adapter list, every
    // agent keeps its manifest adapter and no fallback warning renders.
    mockAdaptersApi.list.mockRejectedValue(new ApiError("adapters unavailable", 500, null));
    await previewMixedAdapterPackage();

    expect(container.textContent).not.toContain("is not installed here");
    expect(findAdapterSelects().map((select) => select.value)).toEqual(["claude_local", "codex_local"]);

    await clickButton((text) => text.startsWith("Import 3 file"));
    await settle();

    expect(lastImportMeta().adapterOverrides).toBeUndefined();
  });

  describe("Devin Fusion model gating", () => {
    beforeEach(() => {
      mockAdaptersApi.list.mockResolvedValue([
        { type: "claude_local", disabled: false },
        { type: "devin_local", disabled: false },
      ]);
    });

    const IMPORT_FUSION_MODELS = [
      {
        id: "fusion-alpha-high-sidekick-beta-low",
        label: "Fusion (Alpha High + Beta Low)",
        fusion: {
          version: 1 as const,
          kind: "fusion" as const,
          components: {
            orchestrator: {
              id: "alpha-high", modelKey: "alpha", modelLabel: "Alpha",
              effortKey: "high", effortLabel: "High", effortSource: "uid" as const,
              label: "Alpha High", modifiers: [] as string[],
            },
            worker: {
              id: "beta-low", modelKey: "beta", modelLabel: "Beta",
              effortKey: "low", effortLabel: "Low", effortSource: "uid" as const,
              label: "Beta Low", modifiers: [] as string[],
            },
          },
          rates: null,
          costSummary: null,
        },
      },
      {
        id: "fusion-alpha-low-sidekick-delta",
        label: "Fusion (Alpha Low + Delta)",
        fusion: {
          version: 1 as const,
          kind: "fusion" as const,
          components: {
            orchestrator: {
              id: "alpha-low", modelKey: "alpha", modelLabel: "Alpha",
              effortKey: "low", effortLabel: "Low", effortSource: "uid" as const,
              label: "Alpha Low", modifiers: [] as string[],
            },
            worker: {
              id: "delta", modelKey: "delta", modelLabel: "Delta",
              effortKey: "unspecified:delta", effortLabel: "Not specified by catalog",
              effortSource: "unspecified" as const,
              label: "Delta", modifiers: [] as string[],
            },
          },
          rates: null,
          costSummary: null,
        },
      },
      { id: "devin-family", label: "Devin family", efforts: ["low", "high"] },
    ];

    function buildDevinFusionPreview(
      planAction: "create" | "skip" = "create",
      model = "fusion",
      extraAgents: { slug: string; name: string; path: string; model: string }[] = [],
    ) {
      const manifestAgents = [
        {
          slug: "dev-agent",
          name: "Dev",
          path: "agents/dev/AGENTS.md",
          adapterType: "devin_local",
          adapterConfig: { model },
        },
        ...extraAgents.map((agent) => ({
          slug: agent.slug,
          name: agent.name,
          path: agent.path,
          adapterType: "devin_local",
          adapterConfig: { model: agent.model },
        })),
      ];
      const files: Record<string, string> = {
        ".paperclip.yaml": 'schema: "paperclip/v1"\n',
        "agents/dev/AGENTS.md": "---\nname: Dev\n---\n\nYou code.\n",
      };
      for (const agent of extraAgents) {
        files[agent.path] = `---\nname: ${agent.name}\n---\n\nAgent.\n`;
      }
      return {
        include: { company: true, agents: true, projects: false, issues: false },
        targetCompanyId: null,
        targetCompanyName: null,
        collisionStrategy: "rename",
        selectedAgentSlugs: manifestAgents.map((agent) => agent.slug),
        plan: {
          companyAction: "create",
          agentPlans: manifestAgents.map((agent, index) => ({
            slug: agent.slug,
            action: index === 0 ? planAction : "create",
            plannedName: agent.name,
            existingAgentId: null,
            reason: null,
          })),
          projectPlans: [],
          issuePlans: [],
        },
        manifest: {
          agents: manifestAgents,
          projects: [],
          issues: [],
          skills: [],
          company: null,
        },
        files,
        envInputs: [],
        warnings: [],
        errors: [],
      } as unknown as CompanyPortabilityPreviewResult;
    }

    async function chooseImportSelect(label: string, value: string) {
      const select = Array.from(container.querySelectorAll("select")).find(
        (el) => el.getAttribute("aria-label") === label,
      ) as HTMLSelectElement | undefined;
      expect(select, `Missing select ${label}`).toBeTruthy();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!;
      await act(async () => {
        setter.call(select!, value);
        select!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await flushReact();
    }

    async function expandImportConfig(index = 0) {
      const buttons = Array.from(container.querySelectorAll("button")).filter(
        (button) => button.textContent?.trim() === "configure adapter",
      );
      expect(buttons.length).toBeGreaterThan(index);
      await act(async () => {
        buttons[index]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settle();
    }

    async function previewDevinImport(
      preview: CompanyPortabilityPreviewResult,
    ) {
      mockCompaniesApi.importPreview.mockResolvedValue(preview);
      await renderPage();
      await enterGithubUrl();
      await clickButton((text) => text === "Preview import");
      await settle();
    }

    it("rejects a bare fusion manifest model before submitting and names the slug", async () => {
      mockCompaniesApi.importPreview.mockResolvedValue(buildDevinFusionPreview());
      await renderPage();
      await enterGithubUrl();
      await clickButton((text) => text === "Preview import");
      await clickButton((text) => text.startsWith("Import "));
      await settle();

      expect(mockCompaniesApi.importBundleAsync).not.toHaveBeenCalled();
      expect(mockCompaniesApi.importBundle).not.toHaveBeenCalled();
      expect(container.textContent).toContain("dev-agent");
      expect(container.textContent).toContain("Fusion combination");
    });

    it("ignores a bare fusion model on an agent the plan skips", async () => {
      mockCompaniesApi.importPreview.mockResolvedValue(buildDevinFusionPreview("skip"));
      mockCompaniesApi.importBundleAsync.mockResolvedValue(buildAccepted());
      mockCompaniesApi.getImportJob.mockResolvedValue(buildSucceededJob());
      await renderPage();
      await enterGithubUrl();
      await clickButton((text) => text === "Preview import");
      await clickButton((text) => text.startsWith("Import "));
      await settle();

      expect(mockCompaniesApi.importBundleAsync).toHaveBeenCalled();
    });

    it("seeds the manifest model and imports the exact Fusion UID from the real picker", async () => {
      mockAgentsApi.adapterModels.mockResolvedValue(IMPORT_FUSION_MODELS);
      await previewDevinImport(buildDevinFusionPreview("create", "devin-family"));
      mockCompaniesApi.importBundleAsync.mockResolvedValue(buildAccepted());
      mockCompaniesApi.getImportJob.mockResolvedValue(buildSucceededJob());

      await expandImportConfig();
      const strategy = container.querySelector<HTMLSelectElement>(
        'select[aria-label="Strategy"]',
      )!;
      expect(strategy.value).toBe("single");
      await chooseImportSelect("Strategy", "fusion");
      await chooseImportSelect("Orchestrator model", "alpha");
      await chooseImportSelect("Orchestrator effort", "low");
      await chooseImportSelect("Worker model", "delta");

      await clickButton((text) => text.startsWith("Import "));
      await settle();

      expect(mockCompaniesApi.importBundleAsync).toHaveBeenCalled();
      const payload = mockCompaniesApi.importBundleAsync.mock.calls.at(-1)![0] as {
        adapterOverrides?: Record<string, { adapterConfig?: { model?: string } }>;
      };
      expect(
        payload.adapterOverrides?.["dev-agent"]?.adapterConfig?.model,
      ).toBe("fusion-alpha-low-sidekick-delta");
    });

    it("blocks the import while a rendered slot draft is pending and names the slug", async () => {
      mockAgentsApi.adapterModels.mockResolvedValue(IMPORT_FUSION_MODELS);
      await previewDevinImport(buildDevinFusionPreview("create", "devin-family"));

      await expandImportConfig();
      await chooseImportSelect("Strategy", "fusion");
      await chooseImportSelect("Orchestrator model", "alpha");

      await clickButton((text) => text.startsWith("Import "));
      await settle();

      expect(mockCompaniesApi.importBundleAsync).not.toHaveBeenCalled();
      expect(container.textContent).toContain("dev-agent");
      expect(container.textContent).toContain("model selection");
    });

    it("keeps a collapsed visited slot mounted so its pending draft still gates", async () => {
      mockAgentsApi.adapterModels.mockResolvedValue(IMPORT_FUSION_MODELS);
      await previewDevinImport(buildDevinFusionPreview("create", "devin-family"));

      await expandImportConfig();
      await chooseImportSelect("Strategy", "fusion");
      await chooseImportSelect("Orchestrator model", "alpha");
      await expandImportConfig();
      expect(
        container.querySelector('select[aria-label="Orchestrator model"]'),
      ).toBeTruthy();

      await clickButton((text) => text.startsWith("Import "));
      await settle();
      expect(mockCompaniesApi.importBundleAsync).not.toHaveBeenCalled();
      expect(container.textContent).toContain("dev-agent");
    });

    it("ignores a deselected agent file even when its manifest model is bare", async () => {
      mockAgentsApi.adapterModels.mockResolvedValue(IMPORT_FUSION_MODELS);
      await previewDevinImport(buildDevinFusionPreview("create", "fusion"));
      mockCompaniesApi.importBundleAsync.mockResolvedValue(buildAccepted());
      mockCompaniesApi.getImportJob.mockResolvedValue(buildSucceededJob());

      const dirToggle = container.querySelector(
        '[aria-label="Expand dev"]',
      );
      if (dirToggle) {
        await act(async () => {
          dirToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flushReact();
      }
      const fileRow = container.querySelector(
        '[data-file-tree-path="agents/dev/AGENTS.md"]',
      );
      expect(fileRow).toBeTruthy();
      const checkbox = fileRow!.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      )!;
      expect(checkbox.checked).toBe(true);
      await act(async () => {
        checkbox.click();
      });
      await flushReact();

      await clickButton((text) => text.startsWith("Import "));
      await settle();
      expect(mockCompaniesApi.importBundleAsync).toHaveBeenCalled();
    });

    it("names only the pending slot when another slot stays valid", async () => {
      mockAgentsApi.adapterModels.mockResolvedValue(IMPORT_FUSION_MODELS);
      await previewDevinImport(
        buildDevinFusionPreview("create", "devin-family", [
          {
            slug: "dev-two",
            name: "Dev Two",
            path: "agents/dev-two/AGENTS.md",
            model: "devin-family",
          },
        ]),
      );

      await expandImportConfig(0);
      await chooseImportSelect("Strategy", "fusion");
      await chooseImportSelect("Orchestrator model", "alpha");

      await clickButton((text) => text.startsWith("Import "));
      await settle();
      expect(mockCompaniesApi.importBundleAsync).not.toHaveBeenCalled();
      expect(container.textContent).toContain("dev-agent");
      expect(container.textContent).not.toContain("dev-two: ");
    });

    it("preserves manifest adapter config through an exact Fusion model change", async () => {
      const preview = buildDevinFusionPreview("create", "devin-family");
      (preview.manifest.agents[0] as { adapterConfig: Record<string, unknown> }).adapterConfig = {
        model: "devin-family",
        thinkingEffort: "high",
        contextSize: "200k",
        fastMode: true,
        priority: true,
        permissionMode: "smart",
        timeoutSec: 42,
        cwd: "/work/repo",
        command: "devin --alpha",
        env: { MY_KEY: { type: "secret_ref", secretId: "s1", version: "latest" } },
        passthrough: "keep-me",
      };
      mockAgentsApi.adapterModels.mockResolvedValue(IMPORT_FUSION_MODELS);
      await previewDevinImport(preview);
      mockCompaniesApi.importBundleAsync.mockResolvedValue(buildAccepted());
      mockCompaniesApi.getImportJob.mockResolvedValue(buildSucceededJob());

      await expandImportConfig();
      await chooseImportSelect("Strategy", "fusion");
      await chooseImportSelect("Orchestrator model", "alpha");
      await chooseImportSelect("Orchestrator effort", "low");
      await chooseImportSelect("Worker model", "delta");

      await clickButton((text) => text.startsWith("Import "));
      await settle();

      expect(mockCompaniesApi.importBundleAsync).toHaveBeenCalled();
      const payload = mockCompaniesApi.importBundleAsync.mock.calls.at(-1)![0] as {
        adapterOverrides?: Record<string, { adapterConfig?: Record<string, unknown> }>;
      };
      const config = payload.adapterOverrides?.["dev-agent"]?.adapterConfig;
      expect(config).toMatchObject({
        model: "fusion-alpha-low-sidekick-delta",
        permissionMode: "smart",
        timeoutSec: 42,
        cwd: "/work/repo",
        command: "devin --alpha",
        passthrough: "keep-me",
        env: { MY_KEY: { type: "secret_ref", secretId: "s1", version: "latest" } },
      });
      for (const axis of ["thinkingEffort", "contextSize", "fastMode", "priority"]) {
        expect(config).not.toHaveProperty(axis);
      }
    });

    it("imports a metadata-backed opaque Fusion UID and drops the four axes", async () => {
      const opaqueModels = [
        ...IMPORT_FUSION_MODELS.slice(0, -1),
        {
          id: "acme-pair-1",
          label: "Acme Pair One",
          fusion: {
            version: 1 as const,
            kind: "fusion" as const,
            components: null,
            rates: null,
            costSummary: null,
          },
        },
        IMPORT_FUSION_MODELS.at(-1)!,
      ];
      const preview = buildDevinFusionPreview("create", "devin-family");
      (preview.manifest.agents[0] as { adapterConfig: Record<string, unknown> }).adapterConfig = {
        model: "devin-family",
        thinkingEffort: "high",
        contextSize: "200k",
        fastMode: true,
        priority: true,
        permissionMode: "smart",
        timeoutSec: 42,
        cwd: "/work/repo",
        env: { MY_KEY: { type: "secret_ref", secretId: "s1", version: "latest" } },
      };
      mockAgentsApi.adapterModels.mockResolvedValue(opaqueModels);
      await previewDevinImport(preview);
      mockCompaniesApi.importBundleAsync.mockResolvedValue(buildAccepted());
      mockCompaniesApi.getImportJob.mockResolvedValue(buildSucceededJob());

      await expandImportConfig();
      await chooseImportSelect("Strategy", "fusion");
      const combo = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Combination"]',
      )!;
      expect(combo).toBeTruthy();
      await act(async () => {
        combo.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      const opaqueOption = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.includes("Acme Pair One"),
      )!;
      expect(opaqueOption).toBeTruthy();
      await act(async () => opaqueOption.click());
      await flushReact();

      await clickButton((text) => text.startsWith("Import "));
      await settle();

      expect(mockCompaniesApi.importBundleAsync).toHaveBeenCalled();
      const payload = mockCompaniesApi.importBundleAsync.mock.calls.at(-1)![0] as {
        adapterOverrides?: Record<string, { adapterConfig?: Record<string, unknown> }>;
      };
      const config = payload.adapterOverrides?.["dev-agent"]?.adapterConfig;
      expect(config).toMatchObject({
        model: "acme-pair-1",
        permissionMode: "smart",
        timeoutSec: 42,
        cwd: "/work/repo",
        env: { MY_KEY: { type: "secret_ref", secretId: "s1", version: "latest" } },
      });
      for (const axis of ["thinkingEffort", "contextSize", "fastMode", "priority"]) {
        expect(config).not.toHaveProperty(axis);
      }
    });

    it("keeps the manifest model and axes when only an unrelated field changes", async () => {
      const preview = buildDevinFusionPreview("create", "devin-family");
      (preview.manifest.agents[0] as { adapterConfig: Record<string, unknown> }).adapterConfig = {
        model: "devin-family",
        thinkingEffort: "high",
        permissionMode: "smart",
        timeoutSec: 42,
        env: { MY_KEY: { type: "secret_ref", secretId: "s1", version: "latest" } },
      };
      mockAgentsApi.adapterModels.mockResolvedValue(IMPORT_FUSION_MODELS);
      await previewDevinImport(preview);
      mockCompaniesApi.importBundleAsync.mockResolvedValue(buildAccepted());
      mockCompaniesApi.getImportJob.mockResolvedValue(buildSucceededJob());

      await expandImportConfig();
      const cwdInput = container.querySelector<HTMLInputElement>(
        'input[placeholder="/Users/you/project"]',
      )!;
      expect(cwdInput).toBeTruthy();
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(cwdInput, "/new/dir");
        cwdInput.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await flushReact();

      await clickButton((text) => text.startsWith("Import "));
      await settle();

      expect(mockCompaniesApi.importBundleAsync).toHaveBeenCalled();
      const payload = mockCompaniesApi.importBundleAsync.mock.calls.at(-1)![0] as {
        adapterOverrides?: Record<string, { adapterConfig?: Record<string, unknown> }>;
      };
      const config = payload.adapterOverrides?.["dev-agent"]?.adapterConfig;
      expect(config).toMatchObject({
        model: "devin-family",
        thinkingEffort: "high",
        permissionMode: "smart",
        timeoutSec: 42,
        cwd: "/new/dir",
        env: { MY_KEY: { type: "secret_ref", secretId: "s1", version: "latest" } },
      });
    });

    it("restores the manifest model when a deselected slot is reselected", async () => {
      mockAgentsApi.adapterModels.mockResolvedValue(IMPORT_FUSION_MODELS);
      await previewDevinImport(buildDevinFusionPreview("create", "devin-family"));

      await expandImportConfig();
      await chooseImportSelect("Strategy", "fusion");
      await chooseImportSelect("Orchestrator model", "alpha");
      await chooseImportSelect("Orchestrator effort", "low");
      await chooseImportSelect("Worker model", "delta");
      const strategyAfterChoice = container.querySelector<HTMLSelectElement>(
        'select[aria-label="Strategy"]',
      )!;
      expect(strategyAfterChoice.value).toBe("fusion");

      const dirToggle = container.querySelector('[aria-label="Expand dev"]');
      if (dirToggle) {
        await act(async () => {
          dirToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flushReact();
      }
      const checkbox = container
        .querySelector('[data-file-tree-path="agents/dev/AGENTS.md"]')!
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      await act(async () => {
        checkbox.click();
      });
      await flushReact();
      await act(async () => {
        checkbox.click();
      });
      await flushReact();

      await expandImportConfig();
      const strategy = container.querySelector<HTMLSelectElement>(
        'select[aria-label="Strategy"]',
      )!;
      expect(strategy.value).toBe("single");
      expect(container.textContent).not.toContain("Complete the model selection");

      mockCompaniesApi.importBundleAsync.mockResolvedValue(buildAccepted());
      mockCompaniesApi.getImportJob.mockResolvedValue(buildSucceededJob());
      await clickButton((text) => text.startsWith("Import "));
      await settle();
      expect(mockCompaniesApi.importBundleAsync).toHaveBeenCalled();
      const payload = mockCompaniesApi.importBundleAsync.mock.calls.at(-1)![0] as {
        adapterOverrides?: Record<string, { adapterConfig?: { model?: string } }>;
      };
      expect(
        payload.adapterOverrides?.["dev-agent"]?.adapterConfig?.model,
      ).not.toBe("fusion-alpha-low-sidekick-delta");
    });

    it("clears a slot draft when a new source replaces the preview", async () => {
      mockAgentsApi.adapterModels.mockResolvedValue(IMPORT_FUSION_MODELS);
      await previewDevinImport(buildDevinFusionPreview("create", "devin-family"));
      mockCompaniesApi.importBundleAsync.mockResolvedValue(buildAccepted());
      mockCompaniesApi.getImportJob.mockResolvedValue(buildSucceededJob());

      await expandImportConfig();
      await chooseImportSelect("Strategy", "fusion");
      await chooseImportSelect("Orchestrator model", "alpha");

      await enterGithubUrl("https://github.com/acme/other-starter/tree/main/company");
      await clickButton((text) => text === "Preview import");
      await settle();

      await clickButton((text) => text.startsWith("Import "));
      await settle();
      expect(mockCompaniesApi.importBundleAsync).toHaveBeenCalled();
    });
  });
});
