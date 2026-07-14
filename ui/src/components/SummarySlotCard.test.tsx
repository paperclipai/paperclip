// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BuiltInAgentState } from "@/api/builtInAgents";
import type {
  GetSummarySlotResponse,
  ListSummarySlotRevisionsResponse,
  SummarySlot,
  SummarySlotDocument,
  SummarySlotIssueRef,
  SummarySlotRevision,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SummarySlotCard } from "./SummarySlotCard";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockInstanceSettingsApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));
const mockSummarySlotsApi = vi.hoisted(() => ({
  get: vi.fn(),
  revisions: vi.fn(),
  generate: vi.fn(),
}));
const mockBuiltInAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({ resume: vi.fn() }));

vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("@/api/summarySlots", () => ({ summarySlotsApi: mockSummarySlotsApi }));
vi.mock("@/api/builtInAgents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/builtInAgents")>()),
  builtInAgentsApi: mockBuiltInAgentsApi,
}));
vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children?: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="markdown-body">{children}</div>,
}));
vi.mock("@/components/ConfigureBuiltInAgentModal", () => ({
  ConfigureBuiltInAgentModal: ({ open }: { open: boolean }) => (open ? <div data-testid="configure-modal" /> : null),
}));

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushQueries() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function readySummarizer(): BuiltInAgentState {
  return {
    definition: {
      key: "summarizer",
      displayName: "Summarizer",
      featureKeys: ["summarizer"],
      shortPurpose: "Writes summaries",
      defaultInstructions: "Summarize",
      defaultRole: "Summarizer",
    },
    status: "ready",
    agentId: "agent-summarizer",
    agent: null,
    pauseReason: null,
    resources: [],
  };
}

function needsSetupSummarizer(): BuiltInAgentState {
  return {
    ...readySummarizer(),
    status: "needs_setup",
    agentId: "agent-summarizer",
  };
}

function slot(overrides: Partial<SummarySlot> = {}): SummarySlot {
  return {
    id: "slot-1",
    companyId: "company-1",
    scopeKind: "project",
    scopeId: "project-1",
    slotKey: "header",
    documentId: null,
    status: "idle",
    generatingIssueId: null,
    lastGeneratedAt: null,
    lastGeneratedByAgentId: null,
    lastModel: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

function summaryDocument(overrides: Partial<SummarySlotDocument> = {}): SummarySlotDocument {
  return {
    id: "doc-1",
    companyId: "company-1",
    title: "Project summary",
    format: "markdown",
    body: "## Needs you\nLatest body",
    latestRevisionId: "rev-2",
    latestRevisionNumber: 2,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: "agent-summarizer",
    updatedByUserId: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

function issue(overrides: Partial<SummarySlotIssueRef> = {}): SummarySlotIssueRef {
  return {
    id: "issue-1",
    identifier: "PAP-14000",
    title: "Summarize project",
    status: "todo",
    ...overrides,
  };
}

function revision(overrides: Partial<SummarySlotRevision> = {}): SummarySlotRevision {
  return {
    id: "rev-1",
    companyId: "company-1",
    documentId: "doc-1",
    revisionNumber: 1,
    title: "Project summary",
    format: "markdown",
    body: "## Old\nOld body",
    changeSummary: null,
    createdByAgentId: "agent-summarizer",
    createdByUserId: null,
    createdByRunId: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

function renderCard(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SummarySlotCard
          companyId="company-1"
          scopeKind="project"
          scopeId="project-1"
          title="Project summary"
          description="Project status at a glance."
        />
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("SummarySlotCard", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableSummaries: true });
    mockBuiltInAgentsApi.list.mockResolvedValue([readySummarizer()]);
    mockSummarySlotsApi.get.mockResolvedValue({ slot: null, document: null, generatingIssue: null } satisfies GetSummarySlotResponse);
    mockSummarySlotsApi.revisions.mockResolvedValue({ slot: null, revisions: [] } satisfies ListSummarySlotRevisionsResponse);
    mockSummarySlotsApi.generate.mockResolvedValue({
      slot: slot({ status: "generating", generatingIssueId: "issue-1" }),
      generatingIssue: issue(),
      alreadyGenerating: false,
    });
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("renders nothing and does not fetch slots when the summaries flag is off", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableSummaries: false });

    root = renderCard(container);
    await flushQueries();

    expect(container.textContent).toBe("");
    expect(mockSummarySlotsApi.get).not.toHaveBeenCalled();
    expect(mockBuiltInAgentsApi.list).not.toHaveBeenCalled();
  });

  it("shows setup CTA when the Summarizer built-in agent needs setup", async () => {
    mockBuiltInAgentsApi.list.mockResolvedValue([needsSetupSummarizer()]);

    root = renderCard(container);
    await flushQueries();

    expect(container.textContent).toContain("Set up the Summarizer");
    const setupButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Set up Summarizer",
    );
    expect(setupButton).not.toBeNull();

    await act(async () => {
      setupButton?.click();
    });
    await flushQueries();

    expect(container.querySelector('[data-testid="configure-modal"]')).not.toBeNull();
  });

  it("shows the empty state and starts generation", async () => {
    root = renderCard(container);
    await flushQueries();

    expect(container.textContent).toContain("No summary yet");
    const generateButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Generate summary"),
    );
    expect(generateButton).not.toBeNull();

    await act(async () => {
      generateButton?.click();
    });
    await flushQueries();

    expect(mockSummarySlotsApi.generate).toHaveBeenCalledWith({
      companyId: "company-1",
      scopeKind: "project",
      scopeId: "project-1",
      slotKey: "header",
    });
  });

  it("shows an active generating state with the linked task", async () => {
    mockSummarySlotsApi.get.mockResolvedValue({
      slot: slot({ status: "generating", generatingIssueId: "issue-1" }),
      document: null,
      generatingIssue: issue({ status: "in_progress" }),
    } satisfies GetSummarySlotResponse);

    root = renderCard(container);
    await flushQueries();

    expect(container.textContent).toContain("Generating summary");
    expect(container.textContent).toContain("PAP-14000: Summarize project");
    expect(container.querySelector('a[href="/issues/PAP-14000"]')).not.toBeNull();
  });

  it("renders the latest generated markdown", async () => {
    mockSummarySlotsApi.get.mockResolvedValue({
      slot: slot({ documentId: "doc-1" }),
      document: summaryDocument({ body: "## Needs you\nReview the launch notes." }),
      generatingIssue: null,
    } satisfies GetSummarySlotResponse);
    mockSummarySlotsApi.revisions.mockResolvedValue({
      slot: slot({ documentId: "doc-1" }),
      revisions: [revision({ id: "rev-2", revisionNumber: 2, body: "## Needs you\nReview the launch notes." })],
    });

    root = renderCard(container);
    await flushQueries();

    expect(container.textContent).toContain("Latest revision");
    expect(container.textContent).toContain("Review the launch notes.");
  });

  it("switches to a historical revision", async () => {
    mockSummarySlotsApi.get.mockResolvedValue({
      slot: slot({ documentId: "doc-1" }),
      document: summaryDocument({ body: "## Latest\nCurrent body" }),
      generatingIssue: null,
    } satisfies GetSummarySlotResponse);
    mockSummarySlotsApi.revisions.mockResolvedValue({
      slot: slot({ documentId: "doc-1" }),
      revisions: [
        revision({ id: "rev-1", revisionNumber: 1, body: "## Old\nOld body" }),
        revision({ id: "rev-2", revisionNumber: 2, body: "## Latest\nCurrent body" }),
      ],
    });

    root = renderCard(container);
    await flushQueries();

    expect(container.textContent).toContain("Current body");
    const revisionOneButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Revision 1",
    );
    expect(revisionOneButton).not.toBeNull();

    await act(async () => {
      revisionOneButton?.click();
    });
    await flushQueries();

    expect(container.textContent).toContain("Historical revision");
    expect(container.textContent).toContain("Old body");
  });

  it("shows stopped generation as a failed retryable state", async () => {
    mockSummarySlotsApi.get.mockResolvedValue({
      slot: slot({ status: "generating", generatingIssueId: "issue-1" }),
      document: null,
      generatingIssue: issue({ status: "done" }),
    } satisfies GetSummarySlotResponse);

    root = renderCard(container);
    await flushQueries();

    expect(container.textContent).toContain("Summary generation stopped");
    const retryButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Retry",
    );
    expect(retryButton).not.toBeNull();

    await act(async () => {
      retryButton?.click();
    });
    await flushQueries();

    expect(mockSummarySlotsApi.generate).toHaveBeenCalled();
  });
});
