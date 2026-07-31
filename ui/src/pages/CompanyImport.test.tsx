// @vitest-environment jsdom

import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanyPortabilityImportResult, CompanyPortabilityPreviewResult } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { CompanyImportJobAccepted } from "../api/companies";
import { CompanyImport } from "./CompanyImport";

const mockCompaniesApi = vi.hoisted(() => ({
  importPreview: vi.fn(),
  importPreviewPackage: vi.fn(),
  importBundle: vi.fn(),
  importBundleAsync: vi.fn(),
  importBundlePackageAsync: vi.fn(),
  getImportJob: vi.fn(),
  get: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  resume: vi.fn(),
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
}));

vi.mock("@/components/ui/tooltip", () => ({
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

function buildImportResult(): CompanyPortabilityImportResult {
  return {
    company: { id: "company-2", name: "Imported Test", action: "created" },
    agents: [{ slug: "coder", id: "agent-1", action: "created", name: "Coder", reason: null }],
    projects: [],
    routines: [{ slug: "weekly-report", id: "routine-1", action: "created", title: "Weekly Report", status: "paused" }],
    envInputs: [],
    warnings: [],
  };
}

function buildAccepted(id = "job-1"): CompanyImportJobAccepted {
  return { job: { id, status: "running" }, statusUrl: `/companies/import/jobs/${id}` };
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
    mockAgentsApi.resume.mockResolvedValue({ id: "agent-1", status: "idle" });
    mockRoutinesApi.update.mockResolvedValue({ id: "routine-1", status: "active" });
    mockCompaniesApi.importPreview.mockResolvedValue(buildPreviewResult());
    mockCompaniesApi.importPreviewPackage.mockResolvedValue(buildPreviewResult());
    // Default async flow: the submit is accepted (202) and the first poll finds
    // the job already finished with the full result. Individual tests override.
    mockCompaniesApi.importBundleAsync.mockResolvedValue(buildAccepted());
    mockCompaniesApi.importBundlePackageAsync.mockResolvedValue(buildAccepted());
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
    expect(container.textContent).toContain("Retry, or use the CLI folder import");
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
      'input[placeholder="Imported Company"]',
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
    const nameInput = container.querySelector<HTMLInputElement>('input[placeholder="Imported Company"]');
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
      expect(container.textContent).toContain("open it to view it");
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
});
