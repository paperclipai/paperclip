// @vitest-environment jsdom

import { forwardRef, useImperativeHandle } from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardChat } from "./BoardChat";

/**
 * Regression coverage for the post-wizard Conference Room intro (PAP-134,
 * plan: PAP-133 A+B): a fresh mount shows the three-dot typing bubble for
 * ~2s, then the CEO welcome, then the suggestion chips ~700ms later. The
 * staged reveal must hold while the onboarding wizard overlay is open or
 * the tab is hidden, and must fast-forward when the user already replied.
 */

const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockGoalsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listComments: vi.fn(),
  listFeedbackVotes: vi.fn(),
}));
const mockDialogState = vi.hoisted(() => ({ onboardingOpen: false }));
const mockChatComposerProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Acme Robotics", issuePrefix: "PAP" },
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogState: () => ({ onboardingOpen: mockDialogState.onboardingOpen }),
}));

// Heavy children that are irrelevant to the staged intro.
vi.mock("../components/ActivityFeed", () => ({
  ActivityFeed: () => <div data-testid="activity-feed" />,
}));
vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/ChatComposer", () => ({
  ChatComposer: forwardRef((props: Record<string, unknown>, ref) => {
    mockChatComposerProps.push(props);
    useImperativeHandle(ref, () => ({ focus: vi.fn() }));
    return <div data-testid="chat-composer" />;
  }),
}));
vi.mock("../components/AgentBubbleActionRow", () => ({
  AgentBubbleActionRow: () => null,
  agentBubbleDateLabel: () => "",
}));
vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => null,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SheetContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="sheet-content">{children}</div>
  ),
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
  await Promise.resolve();
  flushSync(() => {});
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const CEO_AGENT = {
  id: "agent-ceo",
  name: "Alex",
  role: "ceo",
  status: "active",
  icon: null,
};
const BOARD_ISSUE = {
  id: "issue-board",
  identifier: "PAP-1",
  title: "Board Operations",
  originKind: "board_chat",
  status: "in_progress",
  createdAt: "2026-06-10T00:00:00.000Z",
  updatedAt: "2026-06-10T00:00:00.000Z",
};
const OLDER_BOARD_ISSUE = {
  id: "issue-board-old",
  identifier: "PAP-0",
  title: "Board Operations",
  originKind: "board_chat",
  status: "todo",
  createdAt: "2026-06-09T00:00:00.000Z",
  updatedAt: "2026-06-09T00:00:00.000Z",
};
const USER_COMMENT = {
  id: "comment-user-1",
  body: "Hi Alex!",
  authorAgentId: null,
  authorUserId: "user-1",
  createdAt: "2026-06-10T00:00:00.000Z",
};

function hasTypingDots(container: HTMLElement) {
  return container.querySelectorAll(".typing-dots").length > 0;
}

function hasWelcome(container: HTMLElement) {
  return (container.textContent ?? "").includes("Welcome to");
}

function hasChips(container: HTMLElement) {
  return (container.textContent ?? "").includes("Draft a Company Brief");
}

describe("BoardChat staged typing intro", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    container = document.createElement("div");
    document.body.appendChild(container);
    mockDialogState.onboardingOpen = false;
    mockAgentsApi.list.mockResolvedValue([CEO_AGENT]);
    mockGoalsApi.list.mockResolvedValue([
      { id: "goal-1", title: "Build affordable robots", status: "active" },
    ]);
    mockIssuesApi.list.mockResolvedValue([BOARD_ISSUE]);
    mockIssuesApi.listComments.mockResolvedValue([]);
    mockIssuesApi.listFeedbackVotes.mockResolvedValue([]);
    mockChatComposerProps.length = 0;
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
    // Drop any per-test document.visibilityState override.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (document as any).visibilityState;
  });

  let queryClient: QueryClient | null = null;

  function buildElement() {
    // A fresh element every time — rendering an identical element reference
    // lets React bail out of re-rendering, which would hide mock-state flips.
    return (
      <QueryClientProvider client={queryClient!}>
        <BoardChat />
      </QueryClientProvider>
    );
  }

  async function render() {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    root = createRoot(container);
    await act(async () => {
      root!.render(buildElement());
    });
    // Let the agent/goal/issue queries resolve, plus the follow-up render
    // that enables the comments query off boardIssueId. react-query batches
    // notifications through zero-delay timers, so flush those too.
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }
  }

  /** Re-render the existing tree so hooks re-read mutated mock state. */
  async function rerender() {
    await act(async () => {
      root!.render(buildElement());
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("reveals typing dots, then the welcome at 2s, then chips at +700ms", async () => {
    await render();

    // Fresh mount: dots only.
    expect(hasTypingDots(container)).toBe(true);
    expect(hasWelcome(container)).toBe(false);

    // Just before the reveal: still dots.
    await advance(1900);
    expect(hasTypingDots(container)).toBe(true);
    expect(hasWelcome(container)).toBe(false);

    // t=2s: welcome bubble lands, dots leave, chips not yet.
    await advance(100);
    expect(hasWelcome(container)).toBe(true);
    expect(hasTypingDots(container)).toBe(false);
    expect(hasChips(container)).toBe(false);

    // t=2.7s: chips stage in.
    await advance(700);
    expect(hasChips(container)).toBe(true);
  });

  it("skips the staged reveal when a user comment already exists", async () => {
    mockIssuesApi.listComments.mockResolvedValue([USER_COMMENT]);
    await render();

    // Fast-forwarded: no dots, welcome immediately, no timer needed.
    expect(hasTypingDots(container)).toBe(false);
    expect(hasWelcome(container)).toBe(true);
  });

  it("holds the dots while the onboarding wizard overlay is open (PAP-134)", async () => {
    mockDialogState.onboardingOpen = true;
    await render();

    // The 2s window must not burn behind the wizard overlay.
    await advance(2500);
    expect(hasTypingDots(container)).toBe(true);
    expect(hasWelcome(container)).toBe(false);

    // Wizard closes → reveal timer starts fresh.
    mockDialogState.onboardingOpen = false;
    await rerender();
    await advance(2000);
    expect(hasWelcome(container)).toBe(true);
    expect(hasTypingDots(container)).toBe(false);
  });

  it("holds the dots while the document is hidden (PAP-134)", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    await render();

    // The 2s window must not burn while the tab is hidden.
    await advance(2500);
    expect(hasTypingDots(container)).toBe(true);
    expect(hasWelcome(container)).toBe(false);

    // Tab becomes visible → reveal timer starts fresh.
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(2000);
    expect(hasWelcome(container)).toBe(true);
    expect(hasTypingDots(container)).toBe(false);
  });

  it("reserves mobile viewport height and bottom-nav space for the composer", async () => {
    await render();

    const shell = container.querySelector(
      '[data-testid="board-chat-shell"]',
    ) as HTMLDivElement | null;
    expect(shell).not.toBeNull();
    expect(shell?.className).toContain("h-[calc(100dvh_-_3rem_-_4rem");
    expect(shell?.className).toContain("env(safe-area-inset-top)");
    expect(shell?.className).toContain("env(safe-area-inset-bottom)");
    expect(shell?.className).toContain("-m-4");
    expect(shell?.className).toContain("md:h-[calc(100%_+_3rem)]");

    const dock = container.querySelector(
      '[data-testid="board-chat-composer-dock"]',
    ) as HTMLDivElement | null;
    expect(dock).not.toBeNull();
    expect(dock?.className).toContain("bottom-0");
    expect(dock?.className).toContain("px-4");
    expect(dock?.className).toContain("md:px-6");

    const feedButton = container.querySelector(
      'button[aria-label="Open agent feed"]',
    ) as HTMLButtonElement | null;
    expect(feedButton).not.toBeNull();
    expect(feedButton?.className).toContain(
      "bottom-[calc(5rem_+_env(safe-area-inset-bottom))]",
    );
  });

  it("configures the Conference Room composer to submit on Cmd/Ctrl+Enter", async () => {
    await render();

    expect(mockChatComposerProps.at(-1)?.submitKey).toBe("mod-enter");
  });

  it("loads Conference Room history by board_chat origin", async () => {
    await render();

    expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
      originKind: "board_chat",
      sortField: "updated",
      sortDir: "desc",
    }));
  });

  it("uses a friendly date label for legacy Board Operations history rows", async () => {
    mockIssuesApi.list.mockResolvedValue([OLDER_BOARD_ISSUE]);
    await render();

    expect(container.textContent).toMatch(/Chat from .*2026/);
    expect(container.textContent).not.toContain("PAP-0");
  });

  it("starts a fresh server-side conversation after New chat is clicked", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "start", issueId: "issue-new" })}\n\n` +
                `data: ${JSON.stringify({ type: "done", issueId: "issue-new" })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await render();

    const newChatButton = container.querySelector(
      'button[aria-label="new chat"]',
    ) as HTMLButtonElement | null;
    expect(newChatButton).not.toBeNull();

    await act(async () => {
      newChatButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      (mockChatComposerProps.at(-1)?.onChange as (value: string) => void)("Fresh start");
    });
    await act(async () => {
      (mockChatComposerProps.at(-1)?.onSubmit as () => void)();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      companyId: "company-1",
      message: "Fresh start",
      newConversation: true,
    });
  });

  it("switches comment history when a prior chat is selected", async () => {
    const olderPlanningIssue = {
      ...OLDER_BOARD_ISSUE,
      title: "Older planning chat",
    };
    mockIssuesApi.list.mockResolvedValue([BOARD_ISSUE, olderPlanningIssue]);
    mockIssuesApi.listComments.mockImplementation(async (issueId: string) =>
      issueId === olderPlanningIssue.id
        ? [{ ...USER_COMMENT, id: "comment-old", body: "Older chat" }]
        : [],
    );
    await render();

    expect(mockIssuesApi.listComments).toHaveBeenCalledWith(BOARD_ISSUE.id);

    const historyButton = container.querySelector(
      'button[aria-label="chat history"]',
    ) as HTMLButtonElement | null;
    expect(historyButton).not.toBeNull();
    await act(async () => {
      historyButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const olderButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes(olderPlanningIssue.title),
    ) as HTMLButtonElement | undefined;
    expect(olderButton).toBeDefined();
    await act(async () => {
      olderButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockIssuesApi.listComments).toHaveBeenCalledWith(olderPlanningIssue.id);
    expect(container.textContent).toContain("Older chat");
  });
});
