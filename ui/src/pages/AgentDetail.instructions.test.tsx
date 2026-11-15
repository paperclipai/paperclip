// @vitest-environment jsdom

import { act as reactAct, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, AgentInstructionsBundle, AgentInstructionsFileDetail, AgentInstructionsFileSummary } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentFileRunNotice, PromptsTab } from "./AgentDetail";
import { TooltipProvider } from "../components/ui/tooltip";
import { queryKeys } from "../lib/queryKeys";

const mockAgentsApi = vi.hoisted(() => ({
  instructionsBundle: vi.fn(),
  instructionsFile: vi.fn(),
  updateInstructionsBundle: vi.fn(),
  saveInstructionsFile: vi.fn(),
  renameInstructionsFile: vi.fn(),
  deleteInstructionsFile: vi.fn(),
  instructionHistory: vi.fn(),
  instructionCandidates: vi.fn(),
  resolveInstructionCandidate: vi.fn(),
  instructionDiff: vi.fn(),
  restoreInstructions: vi.fn(),
}));

const markdownEditorRenderMock = vi.hoisted(() => vi.fn());
const copyTextToClipboardMock = vi.hoisted(() => vi.fn(async (_text: string) => {}));

vi.mock("../lib/clipboard", () => ({ copyTextToClipboard: copyTextToClipboardMock }));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: {
    uploadImage: vi.fn(async () => ({ contentPath: "/assets/uploaded-image.png" })),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("@/adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => () => ({
    supportsInstructionsBundle: true,
    supportsSkills: true,
    supportsLocalAgentJwt: true,
    requiresMaterializedRuntimeSkills: false,
  }),
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    placeholder,
    contentClassName,
    imageUploadHandler,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    contentClassName?: string;
    imageUploadHandler?: (file: File) => Promise<string>;
  }) => {
    markdownEditorRenderMock({
      value,
      onChange,
      contentClassName,
      hasImageUploadHandler: Boolean(imageUploadHandler),
    });
    return (
      <textarea
        data-testid="markdown-editor"
        aria-label="Markdown editor"
        className={contentClassName}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  },
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="markdown-body">{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitFor<T>(assertion: () => T): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await flushReact();
    }
  }
  throw lastError;
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button as HTMLButtonElement;
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Codex Coder",
    urlKey: "codexcoder",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeSummary(
  path: string,
  entryFile: string,
  overrides: Partial<AgentInstructionsFileSummary> = {},
): AgentInstructionsFileSummary {
  const markdown = path.toLowerCase().endsWith(".md");
  return {
    path,
    size: 24,
    language: markdown ? "markdown" : "text",
    markdown,
    isEntryFile: path === entryFile,
    editable: true,
    deprecated: false,
    virtual: false,
    ...overrides,
  };
}

function makeDetail(
  summary: AgentInstructionsFileSummary,
  content = "# Agent instructions",
  overrides: Partial<AgentInstructionsFileDetail> = {},
): AgentInstructionsFileDetail {
  return {
    ...summary,
    content,
    ...overrides,
  };
}

function makeBundle(
  entryFile: string,
  files: AgentInstructionsFileSummary[],
  overrides: Partial<AgentInstructionsBundle> = {},
): AgentInstructionsBundle {
  return {
    agentId: "agent-1",
    companyId: "company-1",
    mode: "managed",
    rootPath: "/paperclip/agents/agent-1/instructions",
    managedRootPath: "/paperclip/agents/agent-1/instructions",
    entryFile,
    resolvedEntryPath: `/paperclip/agents/agent-1/instructions/${entryFile}`,
    editable: true,
    warnings: [],
    legacyPromptTemplateActive: false,
    legacyBootstrapPromptTemplateActive: false,
    files,
    ...overrides,
  };
}

describe("PromptsTab instruction editor", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let queryClient: QueryClient;
  let saveAction: (() => void) | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    saveAction = null;
    markdownEditorRenderMock.mockClear();
    Object.values(mockAgentsApi).forEach((mock) => mock.mockReset());
    mockAgentsApi.instructionCandidates.mockResolvedValue([]);
    mockAgentsApi.updateInstructionsBundle.mockResolvedValue({});
    mockAgentsApi.saveInstructionsFile.mockImplementation(async (_agentId, data) => ({
      path: data.path,
      size: data.content.length,
      language: "markdown",
      markdown: true,
      isEntryFile: true,
      editable: true,
      deprecated: false,
      virtual: false,
      content: data.content,
    }));
    mockAgentsApi.renameInstructionsFile.mockImplementation(async (_agentId, data) => ({
      ...makeSummary(data.renameTo, data.renameTo), content: data.content, contentHash: "b".repeat(64),
    }));
    mockAgentsApi.deleteInstructionsFile.mockResolvedValue({});
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPromptsTab(
    bundle: AgentInstructionsBundle,
    details: Record<string, AgentInstructionsFileDetail>,
    props: Partial<ComponentProps<typeof PromptsTab>> = {},
  ) {
    mockAgentsApi.instructionsBundle.mockResolvedValue(bundle);
    mockAgentsApi.instructionsFile.mockImplementation(async (_agentId: string, path: string) => {
      const detail = details[path];
      if (!detail) throw new Error(`Missing detail for ${path}`);
      return detail;
    });

    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}><TooltipProvider>
          <PromptsTab
            agent={props.agent ?? makeAgent()}
            companyId={props.companyId ?? "company-1"}
            onDirtyChange={props.onDirtyChange ?? vi.fn()}
            onSaveActionChange={props.onSaveActionChange ?? ((next) => { saveAction = next; })}
            onCancelActionChange={props.onCancelActionChange ?? vi.fn()}
            onSavingChange={props.onSavingChange ?? vi.fn()}
          />
        </TooltipProvider></QueryClientProvider>,
      );
    });
    await flushReact();
  }

  async function selectInstructionMode(mode: "Edit" | "Raw") {
    const editing = Boolean(container.querySelector('button[aria-pressed="true"][aria-label^="Stop editing"]'));
    if ((mode === "Edit") !== editing) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>(mode === "Edit" ? 'button[aria-label^="Edit "]' : 'button[aria-label^="Stop editing"]')!.click();
      });
    }
    await flushReact();
  }

  it("opens preview text for editing without dirtying it, and clears dirty state after undo or discard", async () => {
    const summary = makeSummary("AGENTS.md", "AGENTS.md");
    const onDirtyChange = vi.fn();
    let discard: (() => void) | null = null;
    await renderPromptsTab(makeBundle("AGENTS.md", [summary]), { "AGENTS.md": makeDetail(summary, "Original") }, {
      onDirtyChange, onCancelActionChange: next => { discard = next; },
    });
    await waitFor(() => expect(container.querySelector('[data-testid="instructions-raw-source"]')).not.toBeNull());
    await act(() => container.querySelector<HTMLElement>('[data-testid="instructions-raw-source"]')!.click());
    expect(container.querySelector('[aria-label="Stop editing AGENTS.md"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Instruction file editor"]')!;
    await act(() => setNativeValue(editor, "Changed"));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    await act(() => setNativeValue(editor, "Original"));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    await act(() => setNativeValue(editor, "Changed again"));
    await waitFor(() => expect(discard).toEqual(expect.any(Function)));
    await act(() => discard?.());
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(editor.value).toBe("Original");
  });

  it("only creates Markdown basenames and discards an unsaved empty file", async () => {
    const onDirtyChange = vi.fn();
    let discard: (() => void) | null = null;
    await renderPromptsTab(makeBundle("AGENTS.md", []), {}, {
      onDirtyChange, onCancelActionChange: next => { discard = next; },
    });
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Add agent file"]')!.click());
    const input = container.querySelector<HTMLInputElement>('[aria-label="Markdown file name"]')!;
    expect(document.activeElement).toBe(input);
    expect(input.placeholder).toBe("Untitled");
    expect(container.textContent).toContain("Untitled.md");
    for (const invalid of ["bad name", "file.json", "../escape", "notes.md", "bad!", "AGENTS"]) {
      await act(() => setNativeValue(input, invalid));
      expect(input.getAttribute("aria-invalid")).toBe("true");
    }
    await act(() => setNativeValue(input, "valid-notes_2"));
    expect(input.getAttribute("aria-invalid")).not.toBe("true");
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    expect(container.textContent).toContain("valid-notes_2.md");
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe("");
    await act(() => discard?.());
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(container.textContent).not.toContain("valid-notes_2.md");
    expect(mockAgentsApi.saveInstructionsFile).not.toHaveBeenCalled();
  });

  it("saves the live draft name and content together without creating Untitled.md", async () => {
    await renderPromptsTab(makeBundle("AGENTS.md", []), {});
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Add agent file"]')!.click());
    await act(() => setNativeValue(container.querySelector<HTMLInputElement>('[aria-label="Markdown file name"]')!, "research"));
    await act(() => setNativeValue(container.querySelector<HTMLTextAreaElement>('[aria-label="Instruction file editor"]')!, "# Research notes"));
    await waitFor(() => expect(saveAction).toEqual(expect.any(Function)));
    await act(async () => { saveAction?.(); });
    await waitFor(() => expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledWith("agent-1", expect.objectContaining({ path: "research.md", content: "# Research notes" }), "company-1"));
    expect(mockAgentsApi.deleteInstructionsFile).not.toHaveBeenCalled();
    expect(mockAgentsApi.updateInstructionsBundle).not.toHaveBeenCalled();
  });

  it("keeps the required root delete control disabled", async () => {
    const summary = makeSummary("AGENTS.md", "AGENTS.md");
    await renderPromptsTab(makeBundle("AGENTS.md", [summary]), { "AGENTS.md": makeDetail(summary, "Original") });
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Delete AGENTS.md"]')!;
    expect(button.disabled).toBe(true);
    expect(button.closest('[aria-label="This file is required"]')).not.toBeNull();
  });

  it("renames the root through one source-hash guarded server operation", async () => {
    const summary = makeSummary("AGENTS.md", "AGENTS.md");
    await renderPromptsTab(makeBundle("AGENTS.md", [summary]), { "AGENTS.md": makeDetail(summary, "Original", { contentHash: "a".repeat(64) }) });
    await waitFor(() => expect(container.querySelector('[data-testid="instructions-raw-source"]')?.textContent).toBe("Original"));
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Rename AGENTS.md"]')!.click());
    await act(() => setNativeValue(container.querySelector<HTMLInputElement>('[aria-label="Markdown file name"]')!, "ROOT"));
    await waitFor(() => expect(saveAction).toEqual(expect.any(Function)));
    await act(async () => { saveAction?.(); });
    await waitFor(() => expect(mockAgentsApi.renameInstructionsFile).toHaveBeenCalledWith("agent-1", {
      path: "AGENTS.md", renameTo: "ROOT.md", content: "Original", baseHash: "a".repeat(64),
    }, "company-1"));
    expect(mockAgentsApi.saveInstructionsFile).not.toHaveBeenCalled();
    expect(mockAgentsApi.updateInstructionsBundle).not.toHaveBeenCalled();
    expect(mockAgentsApi.deleteInstructionsFile).not.toHaveBeenCalled();
  });

  it("persists the new configured name when renaming a missing root", async () => {
    await renderPromptsTab(makeBundle("AGENTS.md", []), {});
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Rename AGENTS.md"]')!.click());
    await act(() => setNativeValue(container.querySelector<HTMLInputElement>('[aria-label="Markdown file name"]')!, "ROOT"));
    await waitFor(() => expect(saveAction).toEqual(expect.any(Function)));
    await act(async () => { saveAction?.(); });
    await waitFor(() => expect(mockAgentsApi.renameInstructionsFile).toHaveBeenCalledWith("agent-1", {
      path: "AGENTS.md", renameTo: "ROOT.md", content: "", baseHash: null,
    }, "company-1"));
    expect(mockAgentsApi.saveInstructionsFile).not.toHaveBeenCalled();
  });

  it("retains the draft when the server rejects a stale rename", async () => {
    const summary = makeSummary("AGENTS.md", "AGENTS.md");
    await renderPromptsTab(makeBundle("AGENTS.md", [summary]), { "AGENTS.md": makeDetail(summary, "Original", { contentHash: "a".repeat(64) }) });
    await waitFor(() => expect(container.querySelector('[aria-label="Rename AGENTS.md"]')).not.toBeNull());
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Rename AGENTS.md"]')!.click());
    await act(() => setNativeValue(container.querySelector<HTMLInputElement>('[aria-label="Markdown file name"]')!, "ROOT"));
    mockAgentsApi.renameInstructionsFile.mockRejectedValueOnce(new Error("File changed"));
    await waitFor(() => expect(saveAction).toEqual(expect.any(Function)));
    await act(async () => { saveAction?.(); });
    await waitFor(() => expect(container.textContent).toContain("File changed"));
    expect(mockAgentsApi.deleteInstructionsFile).not.toHaveBeenCalled();
    expect(mockAgentsApi.updateInstructionsBundle).not.toHaveBeenCalled();
  });

  it("shows inline copy feedback before Edit for five seconds without dirtying the file", async () => {
    const summary = makeSummary("AGENTS.md", "AGENTS.md");
    await renderPromptsTab(makeBundle("AGENTS.md", [summary]), { "AGENTS.md": makeDetail(summary, "Original") });
    await waitFor(() => expect(container.querySelector('[aria-label="Copy instructions file as markdown"]')).not.toBeNull());
    vi.useFakeTimers();
    try {
      await reactAct(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Copy instructions file as markdown"]')!.click(); });
      await reactAct(() => {});
      const notice = container.querySelector('.agent-file-copy-notice')!;
      expect(notice.textContent).toBe("File copied");
      expect(notice.classList.contains("opacity-0")).toBe(false);
      expect(notice.nextElementSibling?.getAttribute("aria-label")).toBe("Edit AGENTS.md");
      expect(copyTextToClipboardMock).toHaveBeenCalledWith("Original");
      await reactAct(() => { vi.advanceTimersByTime(4999); });
      expect(notice.classList.contains("opacity-0")).toBe(false);
      await reactAct(() => { vi.advanceTimersByTime(1); });
      expect(notice.classList.contains("opacity-0")).toBe(true);
      expect(saveAction).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("shows extensionless Markdown files as raw text and saves the edited draft", async () => {
    const summary = makeSummary("AGENTS", "AGENTS", {
      language: "markdown",
      markdown: true,
    });
    await renderPromptsTab(
      makeBundle("AGENTS", [summary]),
      { AGENTS: makeDetail(summary, "# Current") },
    );

    await waitFor(() => {
      expect(container.querySelector('[data-testid="instructions-raw-source"]')?.textContent?.trim()).toBe("# Current");
    });
    expect(container.querySelector('[data-testid="markdown-body"]')).toBeNull();
    await selectInstructionMode("Edit");

    const editor = await waitFor(() => {
      const candidate = container.querySelector<HTMLTextAreaElement>('textarea[placeholder="File contents"]');
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    expect(editor.value).toBe("# Current");
    expect(markdownEditorRenderMock).not.toHaveBeenCalled();

    await act(async () => {
      editor.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      setNativeValue(editor, "# Updated");
    });
    await waitFor(() => {
      expect(saveAction).toEqual(expect.any(Function));
    });

    saveAction?.();
    await waitFor(() => {
      expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledWith(
        "agent-1",
        {
          path: "AGENTS",
          content: "# Updated",
          baseRevisionId: null,
          clearLegacyPromptTemplate: false,
        },
        "company-1",
      );
    });
  });

  it("loads preserved edits against the displayed head and retains their pinned base after a conflict", async () => {
    const summary = makeSummary("AGENTS.md", "AGENTS.md");
    const revision = { id: "head-1", entryFile: "AGENTS.md" } as NonNullable<AgentInstructionsFileDetail["revision"]>;
    mockAgentsApi.instructionCandidates.mockResolvedValue([{ runId: "preserved-run", entryFile: "AGENTS.md", baseRevisionId: "older-base", baseHash: "base-hash", state: "conflict", candidateHash: "candidate-hash", content: "preserved edit", errorCode: "INSTRUCTION_REVISION_CONFLICT", errorMessage: "Instructions changed", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }]);
    await renderPromptsTab(makeBundle("AGENTS.md", [summary]), { "AGENTS.md": makeDetail(summary, "current content", { revision }) });
    await waitFor(() => expect(buttonByText(container, "Review preserved edits")).toBeDefined());
    await act(async () => { buttonByText(container, "Review preserved edits").click(); });
    const editor = await waitFor(() => {
      const element = container.querySelector<HTMLTextAreaElement>('textarea[placeholder="File contents"]');
      expect(element?.value).toBe("preserved edit"); return element!;
    });
    mockAgentsApi.resolveInstructionCandidate.mockRejectedValue(new Error("Instructions changed since the base revision"));
    await waitFor(() => expect(saveAction).toEqual(expect.any(Function)));
    await act(async () => { saveAction?.(); });
    await waitFor(() => expect(mockAgentsApi.resolveInstructionCandidate).toHaveBeenCalledWith("agent-1", "preserved-run", { content: "preserved edit", baseRevisionId: "head-1" }, "company-1"));
    expect(mockAgentsApi.saveInstructionsFile).not.toHaveBeenCalled();
    expect(editor.value).toBe("preserved edit");
    await act(async () => { queryClient.setQueryData(["agents", "instructions-bundle", "agent-1", "file", "AGENTS.md"], makeDetail(summary, "newer content", { revision: { ...revision, id: "head-2" } })); });
    await act(async () => { saveAction?.(); });
    await waitFor(() => expect(mockAgentsApi.resolveInstructionCandidate).toHaveBeenCalledTimes(2));
    expect(mockAgentsApi.resolveInstructionCandidate.mock.lastCall?.[2].baseRevisionId).toBe("head-1");
    expect(editor.value).toBe("preserved edit");
    mockAgentsApi.instructionsFile.mockResolvedValue(makeDetail(summary, "latest content", { revision: { ...revision, id: "head-3" } }));
    await waitFor(() => expect(buttonByText(container, "Refresh current revision").disabled).toBe(false));
    await act(async () => { buttonByText(container, "Refresh current revision").click(); });
    await waitFor(() => expect(container.textContent).toContain("latest content"));
    expect(editor.value).toBe("preserved edit");
    expect(mockAgentsApi.resolveInstructionCandidate).toHaveBeenCalledTimes(2);
    await act(async () => { saveAction?.(); });
    await waitFor(() => expect(mockAgentsApi.resolveInstructionCandidate).toHaveBeenCalledTimes(3));
    expect(mockAgentsApi.resolveInstructionCandidate.mock.lastCall?.[2].baseRevisionId).toBe("head-3");
  });

  it("keeps historical whole-folder failures out of the current editor while preserving legacy review", async () => {
    const summary = makeSummary("AGENTS.md", "AGENTS.md");
    const failures = [1, 2, 3].map(attempt => ({ contract: "agent_files", runId: `failed-auth-${attempt}`,
      entryFile: "AGENTS.md", state: "unavailable", content: null,
      errorMessage: "The registered instruction copy could not be retrieved safely before environment release. No instruction save is claimed." }));
    mockAgentsApi.instructionCandidates.mockResolvedValue(failures);
    await renderPromptsTab(makeBundle("AGENTS.md", [summary], { persistence: "agent_files" }), {
      "AGENTS.md": makeDetail(summary, "Successfully saved agent instructions"),
    });
    await waitFor(() => expect(container.textContent).toContain("Successfully saved agent instructions"));
    expect(container.textContent).not.toContain("could not be retrieved");
    expect(container.textContent).not.toContain("Preserved instruction edits");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => {
      queryClient.setQueryData(queryKeys.agents.instructionCandidates("agent-1"), [...failures, {
        contract: "legacy", runId: "preserved-run", entryFile: "AGENTS.md", state: "conflict",
        content: "Legacy edits to review", createdAt: "2026-01-01T00:00:00Z",
      }]);
    });
    await waitFor(() => expect(buttonByText(container, "Review preserved edits").disabled).toBe(false));
    expect(container.textContent).toContain("Preserved instruction edits");
    expect(container.textContent).not.toContain("could not be retrieved");
  });

  it("scopes sync warnings to the affected run and displays a storage warning only once", async () => {
    root = createRoot(container);
    const render = async (instructionSave: Record<string, unknown>) => act(async () => {
      root?.render(<AgentFileRunNotice resultJson={{ instructionSave }} />);
    });
    await render({ contract: "agent_files", state: "unavailable", errorMessage: "This run's files were not saved." });
    expect(container.textContent).toContain("Agent file sync failed for this run");
    expect(container.textContent).toContain("This run's files were not saved.");
    await render({ contract: "agent_files", state: "unavailable", errorCode: "AGENT_FILES_LIMIT_EXCEEDED", errorMessage: "Save rejected", storageWarning: "Agent storage is full. Runs can continue." });
    expect(container.querySelectorAll('[role="note"]')).toHaveLength(1);
    expect(container.textContent).toContain("Runs can continue");
    expect(container.textContent).not.toContain("Save rejected");
    await render({ contract: "agent_files", state: "unavailable", errorCode: "AGENT_FILES_SAVE_FAILED", errorMessage: "An I/O failure prevented saving this run's files.", storageWarning: "Agent storage is full. Runs can continue." });
    expect(container.querySelectorAll('[role="note"]')).toHaveLength(2);
    expect(container.textContent).toContain("Runs can continue");
    expect(container.textContent).toContain("An I/O failure prevented saving this run's files.");
    await render({ contract: "agent_files", state: "saved" });
    expect(container.textContent).toBe("");
    await render({ state: "conflict", errorMessage: "Legacy candidate needs review" });
    expect(container.textContent).toBe("");
  });

  it("keeps changed-entry preserved edits readable and copyable without enabling a save", async () => {
    const summary = makeSummary("CURRENT.md", "CURRENT.md");
    const revision = { id: "current-head", entryFile: "CURRENT.md" } as NonNullable<AgentInstructionsFileDetail["revision"]>;
    const preserved = "# Original entry\nPreserve these exact edits.\n";
    mockAgentsApi.instructionCandidates.mockResolvedValue([{ runId: "old-entry-run", entryFile: "OLD.md", baseRevisionId: "old-head", baseHash: "base-hash", state: "conflict", candidateHash: "candidate-hash", content: preserved, errorCode: "INSTRUCTION_ENTRY_CHANGED", errorMessage: "The instruction entry changed", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }]);
    await renderPromptsTab(makeBundle("CURRENT.md", [summary]), { "CURRENT.md": makeDetail(summary, "Current instructions", { revision }) });
    await waitFor(() => expect(buttonByText(container, "Review preserved edits").disabled).toBe(false));
    await act(async () => { buttonByText(container, "Review preserved edits").click(); });
    const review = await waitFor(() => {
      const region = container.querySelector<HTMLElement>('[aria-label="Preserved edits for OLD.md"]');
      expect(region?.querySelector("pre")?.textContent).toBe(preserved);
      return region!;
    });
    expect(review.textContent).toContain("Read only");
    expect(review.textContent).toContain("CURRENT.md");
    expect(review.querySelector("textarea, input, [contenteditable=true]")).toBeNull();
    expect(saveAction).toBeNull();
    expect(mockAgentsApi.instructionsFile.mock.calls.every((call) => call[1] === "CURRENT.md")).toBe(true);
    await act(async () => { review.querySelector<HTMLButtonElement>('[aria-label="Copy preserved edits for OLD.md"]')!.click(); });
    expect(copyTextToClipboardMock).toHaveBeenCalledWith(preserved);
    expect(saveAction).toBeNull();
    expect(mockAgentsApi.resolveInstructionCandidate).not.toHaveBeenCalled();
    expect(mockAgentsApi.saveInstructionsFile).not.toHaveBeenCalled();

    // Choosing to edit and paste into the current entry is a separate ordinary save.
    await selectInstructionMode("Edit");
    const editor = container.querySelector<HTMLTextAreaElement>('textarea[placeholder="File contents"]')!;
    expect(editor.value).toBe("Current instructions");
    await act(async () => { editor.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); setNativeValue(editor, preserved); });
    await waitFor(() => expect(saveAction).toEqual(expect.any(Function)));
    await act(async () => { saveAction?.(); });
    await waitFor(() => expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledWith("agent-1", { path: "CURRENT.md", content: preserved, baseRevisionId: "current-head", clearLegacyPromptTemplate: false }, "company-1"));
    expect(mockAgentsApi.resolveInstructionCandidate).not.toHaveBeenCalled();
  });

  it("retains the draft and its base when a concurrent save conflicts", async () => {
    const summary = makeSummary("AGENTS.md", "AGENTS.md");
    const revision = { id: "base-1", entryFile: "AGENTS.md" } as NonNullable<AgentInstructionsFileDetail["revision"]>;
    await renderPromptsTab(makeBundle("AGENTS.md", [summary]), { "AGENTS.md": makeDetail(summary, "original", { revision }) });
    mockAgentsApi.saveInstructionsFile.mockRejectedValue(new Error("Instructions changed since the base revision"));
    await selectInstructionMode("Edit");
    const editor = container.querySelector<HTMLTextAreaElement>('textarea[placeholder="File contents"]')!;
    await act(async () => { editor.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); setNativeValue(editor, "my unsaved edit"); });
    await waitFor(() => expect(saveAction).toEqual(expect.any(Function)));
    await act(async () => { saveAction?.(); });
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("base revision"));
    expect(editor.value).toBe("my unsaved edit");
    expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledWith("agent-1", expect.objectContaining({ content: "my unsaved edit", baseRevisionId: "base-1" }), "company-1");
  });

  it("shows revision content and restores against the displayed current head", async () => {
    const summary = makeSummary("AGENTS.md", "AGENTS.md");
    const revision = { id: "current-1", entryFile: "AGENTS.md" } as NonNullable<AgentInstructionsFileDetail["revision"]>;
    mockAgentsApi.instructionHistory.mockResolvedValue({ revisions: [{ id: "old-revision", source: "board", createdAt: "2026-01-01T00:00:00Z" }], nextCursor: null });
    mockAgentsApi.instructionDiff.mockResolvedValue({ from: { content: "old text" }, removed: "old", added: "new" });
    mockAgentsApi.restoreInstructions.mockResolvedValue(makeDetail(summary, "old text", { revision: { ...revision, id: "restored-1" } }));
    await renderPromptsTab(makeBundle("AGENTS.md", [summary]), { "AGENTS.md": makeDetail(summary, "new text", { revision }) });
    await waitFor(() => expect(buttonByText(container, "History")).toBeDefined());
    await act(async () => { buttonByText(container, "History").click(); });
    await waitFor(() => expect(buttonByText(container, "old-revi")).toBeDefined());
    await act(async () => { buttonByText(container, "old-revi").click(); });
    await waitFor(() => expect(container.textContent).toContain("old text"));
    await act(async () => { buttonByText(container, "Restore as new revision").click(); });
    await waitFor(() => expect(mockAgentsApi.restoreInstructions).toHaveBeenCalledWith("agent-1", { path: "AGENTS.md", revisionId: "old-revision", baseRevisionId: "current-1" }, "company-1"));
  });

  it("releases dirty state and save controls when the instructions tab unmounts", async () => {
    const summary = makeSummary("AGENTS.md", "AGENTS.md");
    const onDirtyChange = vi.fn();
    const onSavingChange = vi.fn();
    let cancelAction: (() => void) | null = null;
    await renderPromptsTab(
      makeBundle("AGENTS.md", [summary]),
      { "AGENTS.md": makeDetail(summary, "# Current") },
      {
        onDirtyChange,
        onSavingChange,
        onSaveActionChange: (next) => { saveAction = next; },
        onCancelActionChange: (next) => { cancelAction = next; },
      },
    );
    await selectInstructionMode("Edit");

    const editor = await waitFor(() => {
      const candidate = container.querySelector<HTMLTextAreaElement>('textarea[placeholder="File contents"]');
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    await act(async () => {
      editor.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      setNativeValue(editor, "# Updated");
    });
    await waitFor(() => {
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      expect(saveAction).toEqual(expect.any(Function));
      expect(cancelAction).toEqual(expect.any(Function));
    });

    await act(async () => {
      root?.unmount();
    });
    root = null;

    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(onSavingChange).toHaveBeenLastCalledWith(false);
    expect(saveAction).toBeNull();
    expect(cancelAction).toBeNull();
  });

  it("adopts a loaded external profile instead of keeping the old bundle as unsaved changes", async () => {
    const managed = makeSummary("AGENTS.md", "AGENTS.md");
    const loaded = makeSummary("SOUL.md", "SOUL.md");
    const onDirtyChange = vi.fn();
    await renderPromptsTab(
      makeBundle("AGENTS.md", [managed]),
      {
        "AGENTS.md": makeDetail(managed, "# Managed"),
        "SOUL.md": makeDetail(loaded, "# Loaded profile"),
      },
      { onDirtyChange },
    );
    mockAgentsApi.updateInstructionsBundle.mockImplementation(async () => {
      mockAgentsApi.instructionsBundle.mockResolvedValue(makeBundle("SOUL.md", [loaded], {
        mode: "external",
        rootPath: "/srv/prompts/atlas",
        resolvedEntryPath: "/srv/prompts/atlas/SOUL.md",
      }));
      return {};
    });

    await act(async () => buttonByText(container, "Advanced management").click());
    const panel = container.querySelector<HTMLElement>('[aria-label="External management"]')!;
    const [rootInput, entryInput] = Array.from(panel.querySelectorAll("input"));
    await act(async () => setNativeValue(rootInput, "/srv/prompts/atlas"));
    await act(async () => setNativeValue(entryInput, "SOUL.md"));
    await act(async () => buttonByText(container, "Load profile").click());

    await waitFor(() => {
      expect(panel.querySelector('[role="status"]')?.textContent).toContain("Loaded SOUL.md from /srv/prompts/atlas");
      expect(container.querySelector('[data-testid="instructions-raw-source"]')?.textContent?.trim()).toBe("# Loaded profile");
    });
    expect(mockAgentsApi.updateInstructionsBundle).toHaveBeenCalledTimes(1);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(saveAction).toBeNull();
  });

  it("edits pending new files as raw text before server metadata exists", async () => {
    const summary = makeSummary("settings.json", "settings.json", {
      language: "json",
      markdown: false,
    });
    await renderPromptsTab(
      makeBundle("settings.json", [summary]),
      { "settings.json": makeDetail(summary, "{\n  \"ok\": true\n}") },
    );

    await selectInstructionMode("Edit");
    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>('textarea[placeholder="File contents"]')).not.toBeNull();
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Add agent file"]')!.click();
    });
    await flushReact();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Markdown file name"]');
    expect(input).not.toBeNull();

    await act(async () => {
      setNativeValue(input!, "notes");
    });

    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>('textarea[placeholder="File contents"]')?.value).toBe("");
    });
    expect(markdownEditorRenderMock).not.toHaveBeenCalled();
    expect(mockAgentsApi.instructionsFile).not.toHaveBeenCalledWith("agent-1", "notes.md", "company-1");
  });

  it("edits .md files without Markdown metadata as raw text", async () => {
    const summary = makeSummary("FALLBACK.md", "FALLBACK.md", {
      language: "text",
      markdown: undefined,
    });
    await renderPromptsTab(
      makeBundle("FALLBACK.md", [summary]),
      { "FALLBACK.md": makeDetail(summary, "# Fallback", { markdown: undefined }) },
    );

    await selectInstructionMode("Edit");
    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>('textarea[placeholder="File contents"]')?.value).toBe("# Fallback");
    });
  });

  it("keeps the raw textarea when server metadata marks an .md file as non-Markdown", async () => {
    const summary = makeSummary("NOTES.md", "NOTES.md", {
      language: "text",
      markdown: false,
    });
    await renderPromptsTab(
      makeBundle("NOTES.md", [summary]),
      { "NOTES.md": makeDetail(summary, "raw instructions") },
    );

    await selectInstructionMode("Edit");
    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>('textarea[placeholder="File contents"]')?.value).toBe("raw instructions");
    });
  });
});
