// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BuiltInAgentState } from "@/api/builtInAgents";
import type {
  CompanyLiveEventHandler,
} from "@/context/LiveUpdatesProvider";
import type {
  GetSummarySlotResponse,
  ListSummarySlotRevisionsResponse,
  LiveEvent,
  SummarySlot,
  SummarySlotIssueRef,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __liveUpdatesTestUtils } from "@/context/LiveUpdatesProvider";
import { SummarySlotCard, resolveGenerationStatusLine } from "./SummarySlotCard";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { LiveEventSubscriptionContext, dispatchLiveEventToSubscribers } = __liveUpdatesTestUtils;

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
  ConfigureBuiltInAgentModal: () => null,
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

function slot(overrides: Partial<SummarySlot> = {}): SummarySlot {
  return {
    id: "slot-1",
    companyId: "company-1",
    scopeKind: "project",
    scopeId: "project-1",
    slotKey: "header",
    documentId: null,
    status: "generating",
    failureReason: null,
    generatingIssueId: "issue-1",
    lastGeneratedAt: null,
    lastGeneratedByAgentId: null,
    lastModel: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

function issue(overrides: Partial<SummarySlotIssueRef> = {}): SummarySlotIssueRef {
  return {
    id: "issue-1",
    identifier: "PAP-14000",
    title: "Summarize project",
    status: "in_progress",
    ...overrides,
  };
}

function progressEvent(payload: Record<string, unknown>): LiveEvent {
  return {
    id: 1,
    companyId: "company-1",
    type: "heartbeat.run.progress",
    createdAt: "2026-07-15T00:00:00.000Z",
    payload,
  };
}

function renderCard(container: HTMLDivElement, subscribers: Set<CompanyLiveEventHandler>) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const subscription = {
    subscribe: (fn: CompanyLiveEventHandler) => {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <LiveEventSubscriptionContext.Provider value={subscription}>
          <SummarySlotCard
            companyId="company-1"
            scopeKind="project"
            scopeId="project-1"
            title="Project summary"
          />
        </LiveEventSubscriptionContext.Provider>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("resolveGenerationStatusLine", () => {
  it("prefers the server status message", () => {
    expect(
      resolveGenerationStatusLine({
        message: "reviewing 14 open issues",
        currentToolName: "Read",
        lastAssistantSnippet: "thinking about the launch",
      }),
    ).toBe("reviewing 14 open issues");
  });

  it("falls back to the assistant snippet, then the tool name", () => {
    expect(
      resolveGenerationStatusLine({ message: null, currentToolName: "Grep", lastAssistantSnippet: "drafting" }),
    ).toBe("drafting");
    expect(
      resolveGenerationStatusLine({ message: null, currentToolName: "Grep", lastAssistantSnippet: null }),
    ).toBe("Working with Grep");
  });

  it("returns null when nothing has streamed", () => {
    expect(resolveGenerationStatusLine(null)).toBeNull();
    expect(
      resolveGenerationStatusLine({ message: null, currentToolName: null, lastAssistantSnippet: null }),
    ).toBeNull();
  });
});

describe("SummarySlotCard live status line", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableSummaries: true });
    mockBuiltInAgentsApi.list.mockResolvedValue([readySummarizer()]);
    mockSummarySlotsApi.get.mockResolvedValue({
      slot: slot(),
      document: null,
      generatingIssue: issue(),
    } satisfies GetSummarySlotResponse);
    mockSummarySlotsApi.revisions.mockResolvedValue({ slot: slot(), revisions: [] } satisfies ListSummarySlotRevisionsResponse);
    mockSummarySlotsApi.generate.mockResolvedValue({
      slot: slot(),
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

  it("renders a live status line from a matching progress event", async () => {
    const subscribers = new Set<CompanyLiveEventHandler>();
    root = renderCard(container, subscribers);
    await flushQueries();

    // Falls back to the static generating copy before any event arrives.
    expect(container.querySelector('[data-testid="summary-generation-status-line"]')).toBeNull();
    expect(container.textContent).toContain("Summarizer is working in");

    await act(async () => {
      dispatchLiveEventToSubscribers(
        subscribers,
        "company-1",
        progressEvent({ issueId: "issue-1", message: "reviewing 14 open issues" }),
      );
    });
    await flushQueries();

    const statusLine = container.querySelector('[data-testid="summary-generation-status-line"]');
    expect(statusLine).not.toBeNull();
    expect(statusLine?.textContent).toBe("reviewing 14 open issues");
  });

  it("ignores progress events for a different generating issue", async () => {
    const subscribers = new Set<CompanyLiveEventHandler>();
    root = renderCard(container, subscribers);
    await flushQueries();

    await act(async () => {
      dispatchLiveEventToSubscribers(
        subscribers,
        "company-1",
        progressEvent({ issueId: "issue-999", message: "unrelated run" }),
      );
    });
    await flushQueries();

    expect(container.querySelector('[data-testid="summary-generation-status-line"]')).toBeNull();
    expect(container.textContent).not.toContain("unrelated run");
  });
});
