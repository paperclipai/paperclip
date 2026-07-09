// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { act, forwardRef, useImperativeHandle } from "react";
import type { ReactNode } from "react";
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
  listInteractions: vi.fn(),
}));
const mockDialogState = vi.hoisted(() => ({ onboardingOpen: false }));

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/activity", () => ({
  activityApi: { runsForIssue: vi.fn().mockResolvedValue([]) },
}));

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
vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: forwardRef((_props, ref) => {
    useImperativeHandle(ref, () => ({ focus: vi.fn() }));
    return <div data-testid="markdown-editor" />;
  }),
}));
vi.mock("./board-chat/BoardChatComposer", () => ({
  BoardChatComposer: ({ value }: { value?: string }) => (
    <div data-testid="markdown-editor" data-composer-value={value ?? ""} />
  ),
}));
vi.mock("../hooks/usePaperclipIssueRuntime", () => ({
  usePaperclipIssueRuntime: () => ({}),
}));
vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForIssue: vi.fn().mockResolvedValue([]), get: vi.fn() },
}));
vi.mock("../components/AgentBubbleActionRow", () => ({
  AgentBubbleActionRow: () => null,
  agentBubbleDateLabel: () => "",
}));
vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => null,
}));
vi.mock("../components/IssueThreadInteractionCard", () => ({
  IssueThreadInteractionCard: ({
    interaction,
  }: {
    interaction: { id: string; title: string; kind: string };
  }) => (
    <div data-testid="issue-thread-interaction-card" data-kind={interaction.kind}>
      {interaction.title}
    </div>
  ),
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
const BOARD_ISSUE = { id: "issue-board", title: "Board Operations", status: "in_progress" };
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
  return (container.textContent ?? "").includes("Bem-vindo");
}

function hasChips(container: HTMLElement) {
  return (container.textContent ?? "").includes("Rascunhar um brief da empresa");
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
    mockIssuesApi.listInteractions.mockResolvedValue([]);
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

  it("prefixes NUX chip prompts with a structured CEO agent:// mention", async () => {
    await render();
    await advance(2000);
    expect(hasWelcome(container)).toBe(true);
    await advance(700);
    expect(hasChips(container)).toBe(true);

    const chip = container.querySelector<HTMLButtonElement>(
      '[data-testid="board-chat-nux-chip"]',
    );
    expect(chip).toBeTruthy();

    await act(async () => {
      chip!.click();
    });

    const composer = container.querySelector("[data-testid='markdown-editor']");
    const value = composer?.getAttribute("data-composer-value") ?? "";
    expect(value).toContain("agent://agent-ceo");
    expect(value).toMatch(/\[@Alex]\(agent:\/\/agent-ceo/);
  });

  it("skips the staged reveal when a user comment already exists", async () => {
    mockIssuesApi.listComments.mockResolvedValue([USER_COMMENT]);
    await render();

    // With history, skip typing intro and hide the persistent welcome bubble.
    expect(hasTypingDots(container)).toBe(false);
    expect(hasWelcome(container)).toBe(false);
    expect(hasChips(container)).toBe(false);
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
});

describe("BoardChat HITL cards", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    container = document.createElement("div");
    document.body.appendChild(container);
    mockDialogState.onboardingOpen = false;
    mockAgentsApi.list.mockResolvedValue([CEO_AGENT]);
    mockGoalsApi.list.mockResolvedValue([]);
    mockIssuesApi.list.mockResolvedValue([BOARD_ISSUE]);
    mockIssuesApi.listComments.mockResolvedValue([USER_COMMENT]);
    mockIssuesApi.listFeedbackVotes.mockResolvedValue([]);
    mockIssuesApi.listInteractions.mockResolvedValue([
      {
        id: "interaction-questions-1",
        companyId: "company-1",
        issueId: BOARD_ISSUE.id,
        kind: "ask_user_questions",
        title: "Qual prioridade da sala?",
        summary: "Escolha uma opção para continuar.",
        status: "pending",
        continuationPolicy: "wake_assignee",
        createdByAgentId: "agent-ceo",
        createdByUserId: null,
        resolvedByAgentId: null,
        resolvedByUserId: null,
        createdAt: new Date("2026-06-10T00:01:00.000Z"),
        updatedAt: new Date("2026-06-10T00:01:00.000Z"),
        resolvedAt: null,
        payload: {
          version: 1,
          submitLabel: "Enviar respostas",
          questions: [
            {
              id: "priority",
              prompt: "Qual prioridade?",
              selectionMode: "single",
              required: true,
              options: [{ id: "high", label: "Alta" }],
            },
          ],
        },
        result: null,
      },
    ]);
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
  });

  async function render() {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient!}>
          <BoardChat />
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }
  }

  it("busca interactions e renderiza card HITL pendente na thread", async () => {
    await render();

    expect(mockIssuesApi.listInteractions).toHaveBeenCalledWith(BOARD_ISSUE.id);
    expect(
      container.querySelector('[data-testid="board-chat-hitl-cards"]'),
    ).toBeTruthy();
    const card = container.querySelector(
      '[data-testid="issue-thread-interaction-card"]',
    );
    expect(card).toBeTruthy();
    expect(card?.getAttribute("data-kind")).toBe("ask_user_questions");
    expect(container.textContent).toContain("Qual prioridade da sala?");
  });
});

describe("typing-dots CSS animation guard (PAP-54 failure mode)", () => {
  // PAP-54: the .typing-dots CSS block was silently dropped from index.css
  // during a theme migration, leaving static markup with no animation. Guard
  // the source so the block can't vanish again without failing a test. The
  // browser-computed `animationName !== "none"` assertion lives in
  // tests/e2e/conference-room-typing-intro.spec.ts.
  // Locate ui/src/index.css regardless of whether vitest runs from ui/ or
  // the workspace root (import.meta.url is an http URL under jsdom, and the
  // css pipeline swallows `?raw` imports — plain fs is the reliable path).
  function readIndexCss(): string {
    let dir = process.cwd();
    for (let depth = 0; depth < 6; depth++) {
      for (const candidate of [
        path.join(dir, "src/index.css"),
        path.join(dir, "ui/src/index.css"),
      ]) {
        if (existsSync(candidate)) return readFileSync(candidate, "utf8");
      }
      dir = path.dirname(dir);
    }
    throw new Error("ui/src/index.css not found from " + process.cwd());
  }
  const css = readIndexCss();

  it("keeps the bounce animation wired to .typing-dots span", () => {
    const spanRules = [...css.matchAll(/\.typing-dots span\s*\{[^}]*\}/g)].map(
      (m) => m[0],
    );
    expect(spanRules.length).toBeGreaterThan(0);
    expect(
      spanRules.some((rule) => /animation:\s*typing-bounce/.test(rule)),
    ).toBe(true);
  });

  it("keeps the typing-bounce keyframes", () => {
    expect(css).toMatch(/@keyframes typing-bounce\s*\{/);
  });
});
