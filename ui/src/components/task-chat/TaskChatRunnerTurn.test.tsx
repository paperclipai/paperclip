// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { TaskChatRunnerTurn } from "./TaskChatRunnerTurn";
import type {
  TaskChatItem,
  TaskChatProviderActivityFamily,
  TaskChatProviderActivityItem,
  TaskChatRuntimeRequestDecision,
  TaskChatRuntimeRequestItem,
} from "./task-chat-model";

describe("TaskChatRunnerTurn", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (
    items: TaskChatItem[],
    status = "running",
    runId = "run-1",
    onRuntimeRequestDecision?: (
      item: TaskChatRuntimeRequestItem,
      decision: TaskChatRuntimeRequestDecision,
    ) => void,
    suppressFinal = false,
  ) =>
    act(() =>
      root.render(
        <MemoryRouter>
          <ThemeProvider>
            <TaskChatRunnerTurn
              runId={runId}
              agentName="Runner"
              items={items}
              status={status}
              startedAtMs={Date.now() - 2_000}
              suppressFinal={suppressFinal}
              onRuntimeRequestDecision={onRuntimeRequestDecision}
            />
          </ThemeProvider>
        </MemoryRouter>,
      ),
    );

  const resolvedQuestion = (
    id: string,
    prompt: string,
  ): TaskChatRuntimeRequestItem => ({
    id,
    kind: "protocol",
    surface: "runtime_request",
    runId: "run-1",
    requestId: id,
    requestKind: "user_input",
    turnId: "turn-1",
    requestType: "input",
    status: "resolved",
    prompt: "Codex needs your input.",
    choices: [],
    fields: [],
    questionSet: {
      schema: "paperclip.question_set.v1",
      questions: [
        { id: `${id}-field`, prompt, required: true, answerMode: "text" },
      ],
    },
    response: {
      schema: "paperclip.question_response.v1",
      answers: { [`${id}-field`]: { text: "Answered" } },
    },
  });

  it("shows a stable Working header with Thinking at the turn tail", () => {
    render([], "queued");
    expect(container.textContent).toContain("Thinking");
    expect(container.textContent).toContain("Runner");
    expect(
      container.querySelector(
        '[data-testid="task-chat-runner-disclosure-caret"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="task-chat-current-activity-icon"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="task-chat-current-activity-label"]',
      )?.textContent,
    ).toBe("Thinking");
    expect(
      container.querySelector('[data-testid="task-chat-current-activity"]')
        ?.tagName,
    ).toBe("DIV");
    expect(
      container.querySelector('[data-testid="task-chat-turn-status-header"]')
        ?.textContent,
    ).toContain("Working for");
    expect(container.textContent).not.toContain("Waiting for transcript");
    const identity = container.querySelector(
      '[data-testid="task-chat-agent-identity"]',
    );
    const status = container.querySelector(
      '[data-testid="task-chat-turn-status-header"]',
    );
    const identityRow = container.querySelector(
      '[data-testid="task-chat-runner-identity-row"]',
    );
    const activity = container.querySelector(
      '[data-testid="task-chat-current-activity"]',
    );
    expect(identity?.parentElement).toBe(identityRow);
    expect(status?.parentElement).toBe(identityRow);
    expect(status?.getAttribute("data-turn-position")).toBe("identity");
    expect(identity?.compareDocumentPosition(activity!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(activity?.getAttribute("data-turn-position")).toBe("tail");
    expect(activity?.classList.contains("px-1")).toBe(true);
    expect(activity?.firstElementChild?.hasAttribute("aria-hidden")).toBe(
      false,
    );
  });

  it("keeps progress mounted above its grouped current command", () => {
    render([
      {
        id: "p1",
        kind: "message",
        author: "agent",
        text: "Running the exact command now.",
        interstitial: true,
        channel: "progress",
        streaming: true,
      },
      {
        id: "t1",
        kind: "tool",
        name: "command",
        rawName: "Bash",
        target: "for i in 1 2 3 4; do echo STREAM-$i; done",
        status: "in_progress",
        detail: "STREAM-1\n",
      },
    ]);
    expect(
      container.querySelector('[data-testid="task-chat-phase-interstitial"]')
        ?.textContent,
    ).toContain("Running the exact command now.");
    expect(
      container.querySelector('[data-testid="task-chat-phase-summary"]')
        ?.textContent,
    ).toContain("Ran a command");
    expect(
      container.querySelector('[data-testid="task-chat-current-activity"]')
        ?.textContent,
    ).toContain("Running a command");
    expect(container.textContent).toContain("STREAM-$i");
    const identity = container.querySelector(
      '[data-testid="task-chat-agent-identity"]',
    );
    const activity = container.querySelector(
      '[data-testid="task-chat-current-activity"]',
    );
    const timeline = container.querySelector(
      '[data-testid="task-chat-turn-timeline"]',
    );
    expect(identity?.compareDocumentPosition(timeline!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(timeline?.compareDocumentPosition(activity!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      container
        .querySelector('[data-testid="task-chat-runner-identity-row"]')
        ?.classList.contains("pt-2"),
    ).toBe(true);
  });

  it("keeps the timer at the top and moves resumed Thinking below completed activity", () => {
    render([
      {
        id: "commentary",
        kind: "message",
        author: "agent",
        text: "I’ll inspect the workspace.",
        interstitial: true,
        channel: "progress",
      },
      {
        id: "tool",
        kind: "tool",
        name: "Command",
        rawName: "bash",
        status: "completed",
      },
      {
        id: "thinking",
        kind: "thinking",
        lines: [],
        lifecycleOnly: true,
        streaming: true,
      },
    ]);

    const header = container.querySelector(
      '[data-testid="task-chat-turn-status-header"]',
    );
    const timeline = container.querySelector(
      '[data-testid="task-chat-turn-timeline"]',
    );
    const activity = container.querySelector(
      '[data-testid="task-chat-current-activity"]',
    );
    expect(header?.textContent).toContain("Working for");
    expect(activity?.textContent).toBe("Thinking");
    expect(header?.compareDocumentPosition(timeline!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(timeline?.compareDocumentPosition(activity!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("keeps earlier commentary mounted when later commentary streams", () => {
    render([
      {
        id: "commentary",
        kind: "message",
        author: "agent",
        text: "I’ll inspect the card.",
        interstitial: true,
        channel: "progress",
        transcriptIndex: 1,
      },
      {
        id: "reasoning",
        kind: "thinking",
        lines: ["The saved preview can be reused."],
        streaming: true,
        channel: "summary",
        transcriptIndex: 2,
      },
    ]);
    expect(
      container.querySelector('[data-testid="task-chat-phase-interstitial"]')
        ?.textContent,
    ).toContain("I’ll inspect the card.");

    render([
      {
        id: "commentary",
        kind: "message",
        author: "agent",
        text: "I’ll inspect the card.",
        interstitial: true,
        channel: "progress",
        transcriptIndex: 1,
      },
      {
        id: "reasoning",
        kind: "thinking",
        lines: ["The saved preview can be reused."],
        streaming: true,
        channel: "summary",
        transcriptIndex: 2,
      },
      {
        id: "commentary-later",
        kind: "message",
        author: "agent",
        text: "I’ve found the rendering seam.",
        interstitial: true,
        channel: "progress",
        transcriptIndex: 3,
      },
    ]);
    const commentary = container.querySelectorAll(
      '[data-testid="task-chat-phase-interstitial"]',
    );
    expect(commentary).toHaveLength(2);
    expect(commentary[0]?.textContent).toContain("I’ll inspect the card.");
    expect(commentary[1]?.textContent).toContain(
      "I’ve found the rendering seam.",
    );
    expect(
      container.querySelector('[data-testid="task-chat-thinking"]'),
    ).toBeNull();
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-phase-summary"]',
        )
        ?.click(),
    );
    expect(
      container.querySelector('[data-testid="task-chat-thinking"]')
        ?.textContent,
    ).toContain("Reasoning");
  });

  it("keeps the latest provider-authored reasoning line visible while activity is folded", () => {
    render([
      {
        id: "reasoning",
        kind: "thinking",
        lines: ["Inspecting the task state.", "Checking the steering path."],
        streaming: true,
        channel: "summary",
        transcriptIndex: 2,
      },
    ]);

    const ticker = container.querySelector(
      '[data-testid="task-chat-reasoning-ticker"]',
    );
    expect(ticker?.textContent).toContain("Checking the steering path.");
    expect(
      container.querySelector('[data-testid="task-chat-thinking"]'),
    ).toBeNull();
  });

  it("surfaces native activity transport failure while retrying", () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <ThemeProvider>
            <TaskChatRunnerTurn
              runId="run-1"
              agentName="Runner"
              items={[]}
              status="running"
              startedAtMs={Date.now() - 2_000}
              activityUnavailable
            />
          </ThemeProvider>
        </MemoryRouter>,
      ),
    );

    expect(
      container.querySelector('[data-testid="task-chat-activity-unavailable"]')
        ?.textContent,
    ).toContain("temporarily unavailable");
  });

  it("starts a separate activity group at every commentary boundary", () => {
    render([
      {
        id: "commentary-one",
        kind: "message",
        author: "agent",
        text: "First phase.",
        interstitial: true,
        channel: "progress",
      },
      {
        id: "tool-one",
        kind: "tool",
        name: "Read",
        rawName: "read_file",
        status: "completed",
      },
      {
        id: "commentary-two",
        kind: "message",
        author: "agent",
        text: "Second phase.",
        interstitial: true,
        channel: "progress",
      },
      {
        id: "tool-two",
        kind: "tool",
        name: "Bash",
        rawName: "bash",
        status: "completed",
      },
    ]);
    const rows = container.querySelectorAll(
      '[data-testid="task-chat-turn-timeline-row"]',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("First phase.");
    expect(rows[0]?.textContent).toContain("Read a file");
    expect(rows[1]?.textContent).toContain("Second phase.");
    expect(rows[1]?.textContent).toContain("Ran a command");
    act(() =>
      rows[0]
        ?.querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-phase-summary"]',
        )
        ?.click(),
    );
    expect(
      rows[0]
        ?.querySelector('[data-testid="task-chat-tool-icon"]')
        ?.parentElement?.classList.contains("w-5"),
    ).toBe(true);
  });

  it("keeps internal reasoning nested inside its activity group", () => {
    render([
      {
        id: "summary",
        kind: "thinking",
        lines: ["Inspect the current card."],
        streaming: false,
        channel: "summary",
        transcriptIndex: 1,
      },
      {
        id: "detail",
        kind: "thinking",
        lines: ["Keep the canonical revision atomic."],
        streaming: true,
        channel: "detail",
        transcriptIndex: 2,
      },
    ]);
    expect(
      container.querySelectorAll('[data-testid="task-chat-thinking"]'),
    ).toHaveLength(0);
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-phase-summary"]',
        )
        ?.click(),
    );
    const history = container.querySelector(
      '[data-testid="task-chat-runner-activity-list"]',
    );
    const rail = container.querySelector(
      '[data-testid="task-chat-runner-activity-rail"]',
    )?.parentElement;
    expect(rail?.classList.contains("pl-6")).toBe(true);
    expect(rail?.classList.contains("ml-4")).toBe(true);
    expect(history?.textContent).toContain("Inspect the current card.");
    expect(history?.textContent).toContain(
      "Keep the canonical revision atomic.",
    );
    const thinkingRows = history?.querySelectorAll(
      '[data-testid="task-chat-thinking"]',
    );
    expect(thinkingRows).toHaveLength(2);
    expect(thinkingRows?.[0]?.textContent).not.toContain("Reasoning");
    expect(thinkingRows?.[0]?.querySelector(".shimmer-text")).toBeNull();
    expect(
      thinkingRows?.[0]
        ?.querySelector('[data-testid="task-chat-thinking-icon"]')
        ?.classList.contains("text-(--status-agent-running)"),
    ).toBe(false);
    expect(thinkingRows?.[1]?.textContent).toContain("Reasoning detail…");
    expect(thinkingRows?.[1]?.querySelector(".shimmer-text")).not.toBeNull();
    expect(
      thinkingRows?.[1]
        ?.querySelector('[data-testid="task-chat-thinking-icon"]')
        ?.classList.contains("text-(--status-agent-running)"),
    ).toBe(true);
    expect(thinkingRows?.[0]?.classList.contains("text-xs")).toBe(true);
    expect(thinkingRows?.[0]?.classList.contains("font-normal")).toBe(true);
    expect(
      thinkingRows?.[0]
        ?.querySelector('[data-testid="task-chat-thinking-icon"]')
        ?.parentElement?.classList.contains("w-5"),
    ).toBe(true);
    expect(
      thinkingRows?.[0]
        ?.querySelector('[data-testid="task-chat-thinking-icon"]')
        ?.parentElement?.classList.contains("justify-center"),
    ).toBe(true);
    expect(
      thinkingRows?.[0]?.querySelector(
        '[data-testid="task-chat-thinking-text"]',
      )?.textContent,
    ).toContain("Inspect the current card.");
    expect(
      thinkingRows?.[0]?.querySelector(".task-chat-reasoning-markdown"),
    ).toBeNull();
    expect(
      thinkingRows?.[1]
        ?.querySelector("button")
        ?.classList.contains("font-normal"),
    ).toBe(true);
  });

  it("renders only the current reasoning block as active", () => {
    render([
      {
        id: "old-reasoning",
        kind: "thinking",
        lines: ["Inspect the current card."],
        streaming: true,
        transcriptIndex: 1,
      },
      {
        id: "read",
        kind: "tool",
        name: "Read files",
        rawName: "Read",
        status: "completed",
      },
      {
        id: "current-reasoning",
        kind: "thinking",
        lines: ["Verify the updated state."],
        streaming: true,
        transcriptIndex: 3,
      },
    ]);

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-phase-summary"]',
        )
        ?.click(),
    );

    const oldReasoning = container.querySelector(
      '[data-activity-item-id="old-reasoning"]',
    );
    expect(oldReasoning?.textContent).toBe("Inspect the current card.");
    expect(oldReasoning?.querySelector(".shimmer-text")).toBeNull();
    expect(
      oldReasoning?.querySelector('[data-testid="task-chat-thinking-text"]'),
    ).not.toBeNull();

    const currentReasoning = container.querySelector(
      '[data-activity-item-id="current-reasoning"]',
    );
    expect(currentReasoning?.textContent).toContain("Reasoning…");
    expect(
      currentReasoning
        ?.querySelector('[data-testid="task-chat-thinking-icon"]')
        ?.classList.contains("text-(--status-agent-running)"),
    ).toBe(true);
  });

  it("does not let a textless reasoning lifecycle remove sticky commentary", () => {
    render([
      {
        id: "commentary",
        kind: "message",
        author: "agent",
        text: "Old commentary",
        interstitial: true,
        channel: "progress",
        transcriptIndex: 1,
      },
      {
        id: "reasoning",
        kind: "thinking",
        lines: [],
        lifecycleOnly: true,
        streaming: true,
        transcriptIndex: 2,
      },
    ]);
    expect(
      container.querySelector('[data-testid="task-chat-phase-interstitial"]')
        ?.textContent,
    ).toContain("Old commentary");
    expect(
      container.querySelector('[data-testid="task-chat-phase-summary"]'),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="task-chat-current-activity-label"]',
      )?.textContent,
    ).toBe("Thinking");
  });

  it("keeps the within-turn plan in activity history without rendering a Plan document preview", () => {
    const activity: TaskChatProviderActivityItem = {
      id: "live-plan",
      kind: "protocol",
      surface: "provider_activity",
      family: "plan",
      eventType: "plan.updated",
      status: "running",
      title: "Plan",
      details: [{ label: "Revision", value: "4" }],
      steps: [
        {
          id: "one",
          label: "Extract the shared preview",
          status: "in_progress",
        },
      ],
      links: [],
      children: [],
      transcriptIndex: 1,
    };
    render([activity]);
    expect(
      container.querySelector('[data-testid="task-chat-live-plan-preview"]'),
    ).toBeNull();
    const disclosure = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-phase-summary"]',
    );
    expect(disclosure?.getAttribute("aria-label")).toContain("Expand activity");
    act(() => disclosure?.click());
    const history = container.querySelector(
      '[data-testid="task-chat-runner-activity-list"]',
    );
    expect(history?.textContent).toContain("Updating the plan");
    expect(
      history?.querySelector('[data-activity-family="plan"]'),
    ).not.toBeNull();
    expect(
      history
        ?.querySelector('[data-testid="task-chat-protocol-activity-icon"]')
        ?.parentElement?.classList.contains("w-5"),
    ).toBe(true);
  });

  it("shows canonical web research as the current Codex-style activity", () => {
    render([
      {
        id: "research-1",
        kind: "protocol",
        surface: "provider_activity",
        family: "research",
        eventType: "research.started",
        status: "running",
        title: "Research",
        summary: "site:openai.com model guide GPT-5.4",
        details: [
          { label: "Query", value: "site:openai.com model guide GPT-5.4" },
        ],
        steps: [],
        links: [],
        children: [],
      },
    ]);

    const activity = container.querySelector(
      '[data-testid="task-chat-current-activity"]',
    );
    expect(activity?.textContent).toContain("Searching the web");
    expect(activity?.textContent).toContain(
      "site:openai.com model guide GPT-5.4",
    );
    expect(activity?.getAttribute("data-activity-family")).toBe("research");
  });

  it("has a purpose-built current-activity presentation for every provider family", () => {
    const cases: Array<{
      family: TaskChatProviderActivityFamily;
      eventType: string;
      status: TaskChatProviderActivityItem["status"];
      expected: string;
      details?: TaskChatProviderActivityItem["details"];
    }> = [
      {
        family: "plan",
        eventType: "plan.updated",
        status: "running",
        expected: "Updating the plan",
      },
      {
        family: "tool_execution",
        eventType: "tool.execution.started",
        status: "running",
        expected: "Running an unnamed tool",
      },
      {
        family: "research",
        eventType: "research.started",
        status: "running",
        expected: "Searching the web",
        details: [{ label: "Action", value: "search" }],
      },
      {
        family: "delegation",
        eventType: "delegation.started",
        status: "running",
        expected: "Starting a subagent",
        details: [{ label: "Action", value: "spawn" }],
      },
      {
        family: "model_identity",
        eventType: "model.route.changed",
        status: "informational",
        expected: "Switched models",
      },
      {
        family: "context",
        eventType: "context.compacted",
        status: "completed",
        expected: "Compacted context",
      },
      {
        family: "artifact",
        eventType: "artifact.generated",
        status: "running",
        expected: "Generating an artifact",
      },
      {
        family: "review",
        eventType: "review.mode.changed",
        status: "informational",
        expected: "Entered review mode",
        details: [{ label: "State", value: "entered" }],
      },
      {
        family: "hook",
        eventType: "hook.started",
        status: "running",
        expected: "Running a hook",
      },
      {
        family: "memory",
        eventType: "memory.citation.referenced",
        status: "informational",
        expected: "Referenced memory",
      },
      {
        family: "safety",
        eventType: "safety.review.started",
        status: "running",
        expected: "Reviewing safety",
      },
      {
        family: "terminal",
        eventType: "terminal.input.sent",
        status: "informational",
        expected: "Sent terminal input",
      },
      {
        family: "wait",
        eventType: "wait.started",
        status: "running",
        expected: "Waiting",
      },
      {
        family: "provider_notice",
        eventType: "provider.notice.recorded",
        status: "informational",
        expected: "Provider notice",
      },
    ];

    expect(cases.map((entry) => entry.family)).toEqual([
      "plan",
      "tool_execution",
      "research",
      "delegation",
      "model_identity",
      "context",
      "artifact",
      "review",
      "hook",
      "memory",
      "safety",
      "terminal",
      "wait",
      "provider_notice",
    ] satisfies TaskChatProviderActivityFamily[]);

    for (const entry of cases) {
      render([
        {
          id: `provider-${entry.family}`,
          kind: "protocol",
          surface: "provider_activity",
          family: entry.family,
          eventType: entry.eventType,
          status: entry.status,
          title: entry.family,
          details: entry.details ?? [],
          steps: [],
          links: [],
          children: [],
        },
      ]);
      const activity = container.querySelector(
        '[data-testid="task-chat-current-activity"]',
      );
      expect(activity?.getAttribute("data-activity-family"), entry.family).toBe(
        entry.family,
      );
      expect(activity?.textContent, entry.family).toContain(entry.expected);
    }
  });

  it("shows provider failures and interruptions instead of a successful past-tense label", () => {
    const provider = (
      status: "failed" | "interrupted",
    ): TaskChatProviderActivityItem => ({
      id: `research-${status}`,
      kind: "protocol",
      surface: "provider_activity",
      family: "research",
      eventType: "research.completed",
      status,
      title: "Research",
      details: [],
      steps: [],
      links: [],
      children: [],
    });
    render([provider("failed")]);
    expect(
      container.querySelector('[data-testid="task-chat-current-activity"]')
        ?.textContent,
    ).toContain("Web search failed");
    render([provider("interrupted")]);
    expect(
      container.querySelector('[data-testid="task-chat-current-activity"]')
        ?.textContent,
    ).toContain("Web search stopped");
  });

  it("surfaces workspace changes and file references as current activity", () => {
    render([
      {
        id: "workspace-change",
        kind: "protocol",
        surface: "workspace_change",
        changeSetId: "change-1",
        revision: 1,
        source: "harness_reported",
        complete: false,
        files: [],
        totals: { files: 2, additions: 3, deletions: 1 },
        patchArtifactRef: null,
      },
    ]);
    expect(
      container.querySelector('[data-testid="task-chat-current-activity"]')
        ?.textContent,
    ).toContain("Editing files");
    expect(
      container.querySelector('[data-testid="task-chat-current-activity"]')
        ?.textContent,
    ).toContain("2 files");
    const card = container.querySelector(
      '[data-testid="task-chat-workspace-change"]',
    );
    expect(card).not.toBeNull();
    expect(
      card?.closest('[data-testid="task-chat-activity-phase"]'),
    ).toBeNull();

    render([
      {
        id: "workspace-file",
        kind: "protocol",
        surface: "workspace_file",
        referenceId: "file-1",
        source: "runner_verified",
        path: "ui/src/App.tsx",
        displayName: "App.tsx",
        mediaType: "text/typescript",
        presentation: "code",
        line: 42,
        preview: null,
        previewTruncated: false,
      },
    ]);
    const activity = container.querySelector(
      '[data-testid="task-chat-current-activity"]',
    );
    expect(activity?.textContent).toContain("Referenced a file");
    expect(activity?.textContent).toContain("ui/src/App.tsx:42");
    expect(activity?.classList.contains("px-1")).toBe(true);
    const icon = activity?.querySelector(
      '[data-testid="task-chat-current-activity-icon"]',
    );
    expect(icon).not.toBeNull();
    expect(icon?.parentElement?.classList.contains("w-5")).toBe(true);
    expect(icon?.parentElement?.classList.contains("justify-center")).toBe(
      true,
    );
  });

  it("streams the final response in its durable slot and settles the disclosure", () => {
    render(
      [
        {
          id: "p1",
          kind: "message",
          author: "agent",
          text: "Checking.",
          interstitial: true,
          channel: "progress",
        },
        {
          id: "f1",
          kind: "message",
          author: "agent",
          authorName: "Runner",
          text: "Completed successfully.",
          channel: "final",
          streaming: true,
        },
      ],
      "succeeded",
    );
    expect(
      container.querySelector('[data-testid="task-chat-final-response"]')
        ?.textContent,
    ).toContain("Completed successfully.");
    expect(
      container.querySelectorAll('[data-testid="task-chat-agent-avatar"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="task-chat-turn-status-header"]')
        ?.textContent,
    ).toContain("Worked for");
    expect(
      container.querySelector('[data-testid="task-chat-phase-interstitial"]')
        ?.textContent,
    ).toContain("Checking.");
  });

  it("clears provider wait prose when the run is accepted as yielded", () => {
    const providerWait: TaskChatItem = {
      id: "provider-wait",
      kind: "message",
      author: "agent",
      authorName: "Runner",
      text: "Waiting for Review browser RTS plan.",
      channel: "final",
      streaming: false,
    };
    render([providerWait], "succeeded");
    expect(
      container.querySelector('[data-testid="task-chat-final-response"]'),
    ).not.toBeNull();

    render(
      [
        providerWait,
        {
          id: "result",
          kind: "protocol",
          surface: "run_result",
          disposition: "yielded",
          summary: "Waiting for Review browser RTS plan.",
          objectiveSatisfied: false,
          verification: [],
          remainingWork: [],
          blocker: null,
          artifacts: [],
        },
      ],
      "succeeded",
    );

    expect(
      container.querySelector('[data-testid="task-chat-final-response"]'),
    ).toBeNull();
  });

  it("clears provider wait prose as soon as interaction authority is known", () => {
    const providerWait: TaskChatItem = {
      id: "provider-wait-before-result",
      kind: "message",
      author: "agent",
      authorName: "Runner",
      text: "Waiting for structured input.",
      channel: "final",
      streaming: false,
    };
    render([providerWait], "running");
    expect(
      container.querySelector('[data-testid="task-chat-final-response"]'),
    ).not.toBeNull();

    render([providerWait], "running", "run-1", undefined, true);
    expect(
      container.querySelector('[data-testid="task-chat-final-response"]'),
    ).toBeNull();
  });

  it("waits for settlement before using a structured result fallback", () => {
    const items: TaskChatItem[] = [
      {
        id: "result",
        kind: "protocol",
        surface: "run_result",
        disposition: "done",
        summary: "Structured fallback.",
        objectiveSatisfied: true,
        verification: [],
        remainingWork: [],
        blocker: null,
        artifacts: [],
      },
    ];

    render(items, "running");

    expect(
      container.querySelector('[data-testid="task-chat-final-response"]'),
    ).toBeNull();
  });

  it("lets a shorter provider final replace a structured result fallback", () => {
    const result: TaskChatItem = {
      id: "result",
      kind: "protocol",
      surface: "run_result",
      disposition: "done",
      summary: "A much longer structured summary fallback.",
      objectiveSatisfied: true,
      verification: [],
      remainingWork: [],
      blocker: null,
      artifacts: [],
    };

    render([result], "succeeded");
    expect(container.textContent).toContain(
      "A much longer structured summary fallback.",
    );

    render(
      [
        result,
        {
          id: "provider-final",
          kind: "message",
          author: "agent",
          text: "Done.",
          channel: "final",
          streaming: false,
        },
      ],
      "succeeded",
    );

    expect(
      container.querySelector('[data-testid="task-chat-final-response"]')
        ?.textContent,
    ).toContain("Done.");
    expect(container.textContent).not.toContain(
      "A much longer structured summary fallback.",
    );
  });

  it("collapses terminal reasoning to the existing Worked summary", () => {
    render(
      [
        {
          id: "reasoning",
          kind: "thinking",
          lines: ["Provider-authored trace"],
          channel: "summary",
          transcriptIndex: 1,
        },
      ],
      "succeeded",
    );
    expect(
      container.querySelector('[data-testid="task-chat-live-narration"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="task-chat-turn-status-header"]')
        ?.textContent,
    ).toContain("Worked for");
    expect(
      container.querySelector('[data-testid="task-chat-phase-summary"]')
        ?.textContent,
    ).toContain("Reasoning");
  });

  it("keeps final text mounted through a transient replay gap", () => {
    render([
      {
        id: "f1",
        kind: "message",
        author: "agent",
        authorName: "Runner",
        text: "Completed successfully.",
        channel: "final",
        streaming: true,
      },
    ]);
    render([
      { id: "t1", kind: "tool", name: "Paperclip_finish", status: "completed" },
    ]);

    expect(
      container.querySelector('[data-testid="task-chat-final-response"]')
        ?.textContent,
    ).toContain("Completed successfully.");
    expect(
      container.querySelectorAll('[data-testid="task-chat-final-response"]'),
    ).toHaveLength(1);
  });

  it("clears replay-latched final text when the next run takes over the lane", () => {
    render(
      [
        {
          id: "f1",
          kind: "message",
          author: "agent",
          authorName: "Runner",
          text: "First answer.",
          channel: "final",
        },
      ],
      "running",
      "run-1",
    );
    render([], "running", "run-2");

    expect(container.textContent).not.toContain("First answer.");
    expect(
      container.querySelector('[data-testid="task-chat-current-activity"]')
        ?.textContent,
    ).toContain("Thinking");
  });

  it("omits runner lifecycle and token noise while preserving useful history", () => {
    render([
      {
        id: "session",
        kind: "marker",
        variant: "session_start",
        label: "Session started",
        detail: "session-id",
      },
      {
        id: "start",
        kind: "marker",
        variant: "turn_boundary",
        label: "Turn started",
      },
      {
        id: "usage",
        kind: "usage",
        usage: {
          used: 10_520,
          size: 0,
          inputTokens: 10_254,
          outputTokens: 266,
        },
      },
      {
        id: "tool",
        kind: "tool",
        name: "Paperclip_finish",
        rawName: "paperclip_finish",
        target: "reportedWorkDisposition: done",
        status: "completed",
      },
      {
        id: "interrupt",
        kind: "marker",
        variant: "interrupted",
        label: "Interrupted",
      },
      {
        id: "complete",
        kind: "marker",
        variant: "turn_boundary",
        label: "Turn completed",
      },
    ]);

    expect(container.textContent).not.toContain("Paperclip_finish");
    expect(container.textContent).toContain("Interrupted");
    expect(container.textContent).not.toContain("Session started");
    expect(container.textContent).not.toContain("Turn started");
    expect(container.textContent).not.toContain("Turn completed");
    expect(container.textContent).not.toContain("10,520");
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-phase-summary"]',
        )
        ?.click(),
    );
    expect(
      container
        .querySelector('[data-testid="task-chat-marker-icon"]')
        ?.parentElement?.classList.contains("w-5"),
    ).toBe(true);
  });

  it("does not leave a pending runtime marker after action moves to the composer", async () => {
    const onDecision = vi.fn();
    render(
      [
        {
          id: "request",
          kind: "protocol",
          surface: "runtime_request",
          runId: "run-1",
          requestId: "request-1",
          requestKind: "command_approval",
          turnId: "turn-1",
          requestType: "permission",
          status: "pending",
          prompt: "Allow command?",
          choices: [{ key: "accept", label: "Allow once" }],
          fields: [],
        },
      ],
      "running",
      "run-1",
      onDecision,
    );

    expect(
      container.querySelector(
        '[data-testid="task-chat-runtime-request-marker"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="task-chat-runtime-request"]'),
    ).toBeNull();
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("keeps a resolved question as a compact expandable receipt outside folded activity", () => {
    render(
      [
        {
          id: "resolved-request",
          kind: "protocol",
          surface: "runtime_request",
          runId: "run-1",
          requestId: "request-1",
          requestKind: "runtime",
          turnId: "turn-1",
          requestType: "input",
          status: "resolved",
          prompt: "Codex needs your input.",
          choices: [],
          fields: [],
          questionSet: {
            schema: "paperclip.question_set.v1",
            questions: [
              {
                id: "goal",
                prompt: "What should the server do?",
                required: true,
                answerMode: "text",
              },
            ],
          },
          response: {
            schema: "paperclip.question_response.v1",
            answers: { goal: { text: "Serve a small JSON API." } },
          },
        },
      ],
      "succeeded",
    );

    const receipt = container.querySelector<HTMLDetailsElement>(
      '[data-testid="task-chat-runtime-request"]',
    );
    const history = receipt?.querySelector(
      '[data-testid="task-chat-runtime-request-history"]',
    );
    expect(receipt?.open).toBe(false);
    expect(receipt?.querySelector("summary")?.textContent).toBe(
      "Questions answered",
    );
    expect(history?.closest(".tc-turn-fold")).toBeNull();
    expect(history?.textContent).toContain("What should the server do?");
    expect(history?.textContent).toContain("Serve a small JSON API.");
  });

  it("renders the DOT-217 mixed turn in exact transcript order", () => {
    render(
      [
        {
          id: "commentary-1",
          kind: "message",
          author: "agent",
          text: "I’ll inspect the workspace first.",
          interstitial: true,
          channel: "progress",
        },
        {
          id: "tool-1",
          kind: "tool",
          name: "Read",
          rawName: "read_file",
          status: "completed",
        },
        {
          id: "tool-2",
          kind: "tool",
          name: "Read",
          rawName: "read_file",
          status: "completed",
        },
        {
          id: "commentary-2",
          kind: "message",
          author: "agent",
          text: "I need the first product choices.",
          interstitial: true,
          channel: "progress",
        },
        resolvedQuestion("questions-1", "Which core loop?"),
        {
          id: "commentary-3",
          kind: "message",
          author: "agent",
          text: "Now I’ll pin down the simulation.",
          interstitial: true,
          channel: "progress",
        },
        {
          id: "tool-3",
          kind: "tool",
          name: "Search",
          rawName: "web_search",
          status: "completed",
        },
        resolvedQuestion("questions-2", "How should time work?"),
        {
          id: "commentary-4",
          kind: "message",
          author: "agent",
          text: "The final implementation shape is clear.",
          interstitial: true,
          channel: "progress",
        },
        {
          id: "tool-4",
          kind: "tool",
          name: "Bash",
          rawName: "bash",
          status: "completed",
        },
        {
          id: "final",
          kind: "message",
          author: "agent",
          text: "The plan is ready.",
          channel: "final",
        },
      ],
      "succeeded",
    );

    const timeline = container.querySelector(
      '[data-testid="task-chat-turn-timeline"]',
    );
    const rows = Array.from(
      timeline?.querySelectorAll(
        '[data-testid="task-chat-turn-timeline-row"]',
      ) ?? [],
    );
    expect(rows.map((row) => row.getAttribute("data-timeline-row-id"))).toEqual(
      [
        "commentary-1:phase",
        "commentary-2:phase",
        "questions-1",
        "commentary-3:phase",
        "questions-2",
        "commentary-4:phase",
      ],
    );
    expect(rows[0]?.textContent).toContain("Read 2 files");
    expect(rows[2]?.textContent).toContain("Questions answered");
    expect(rows[3]?.textContent).toContain("Used a tool");
    expect(rows[5]?.textContent).toContain("Ran a command");
    const worked = container.querySelector(
      '[data-testid="task-chat-turn-status-header"]',
    );
    const identityRow = container.querySelector(
      '[data-testid="task-chat-runner-identity-row"]',
    );
    const identity = container.querySelector(
      '[data-testid="task-chat-agent-identity"]',
    );
    const final = container.querySelector(
      '[data-testid="task-chat-final-response"]',
    );
    expect(worked?.getAttribute("data-turn-position")).toBe("identity");
    expect(worked?.parentElement).toBe(identityRow);
    expect(identity?.parentElement).toBe(identityRow);
    expect(identityRow?.classList.contains("items-center")).toBe(true);
    expect(worked?.classList.contains("border-b")).toBe(false);
    expect(worked?.compareDocumentPosition(timeline!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(timeline?.compareDocumentPosition(final!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("expands a grouped live phase without hiding its commentary", () => {
    render([
      {
        id: "thinking-empty",
        kind: "thinking",
        lines: [],
        streaming: false,
        lifecycleOnly: true,
      },
      {
        id: "commentary",
        kind: "message",
        author: "agent",
        text: "Checking the current implementation.",
        interstitial: true,
        channel: "progress",
      },
      {
        id: "tool",
        kind: "tool",
        name: "Read",
        rawName: "read_file",
        target: "ui/src/App.tsx",
        status: "completed",
        detail: "export function App() {}",
      },
    ]);

    const disclosure = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-phase-summary"]',
    );
    expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
    expect(
      container.querySelectorAll('[data-testid="task-chat-thinking"]'),
    ).toHaveLength(0);

    act(() => disclosure?.click());

    expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelector('[data-testid="task-chat-runner-activity-list"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="task-chat-phase-interstitial"]')
        ?.textContent,
    ).toContain("Checking the current implementation.");
    expect(container.textContent).toContain("ui/src/App.tsx");
  });

  it("preserves an open phase while the live run becomes terminal", () => {
    const items: TaskChatItem[] = [
      {
        id: "tool",
        kind: "tool",
        name: "Search",
        rawName: "web_search",
        target: "smoked pork shoulder",
        status: "in_progress",
      },
    ];
    render(items);
    const disclosure = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-phase-summary"]',
    );
    act(() => disclosure?.click());
    expect(disclosure?.getAttribute("aria-expanded")).toBe("true");

    render(
      [{ ...items[0], kind: "tool", status: "completed" } as TaskChatItem],
      "succeeded",
    );

    const settled = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-phase-summary"]',
    );
    expect(settled?.getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelector('[data-testid="task-chat-turn-status-header"]')
        ?.textContent,
    ).toContain("Worked for");
  });

  it("resets phase disclosure state when a different run takes over", () => {
    const items: TaskChatItem[] = [
      {
        id: "tool",
        kind: "tool",
        name: "Read",
        rawName: "read_file",
        target: "ui/src/App.tsx",
        status: "completed",
      },
    ];
    render(items, "running", "run-1");
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-phase-summary"]',
        )
        ?.click(),
    );
    expect(
      container
        .querySelector('[data-testid="task-chat-phase-summary"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");

    render(items, "running", "run-2");

    expect(
      container
        .querySelector('[data-testid="task-chat-phase-summary"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("renders a failed terminal disclosure without treating prose as status authority", () => {
    render(
      [
        {
          id: "final",
          kind: "message",
          author: "agent",
          text: "I finished the draft.",
          channel: "final",
        },
        {
          id: "tool",
          kind: "tool",
          name: "Command",
          rawName: "bash",
          target: "pnpm test",
          status: "failed",
        },
      ],
      "failed",
    );

    expect(
      container.querySelector('[data-testid="task-chat-turn-status-header"]')
        ?.textContent,
    ).toContain("Stopped after");
    expect(
      container.querySelector('[data-testid="task-chat-final-response"]')
        ?.textContent,
    ).toContain("I finished the draft.");
  });
});
