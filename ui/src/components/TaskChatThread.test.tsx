// @vitest-environment jsdom

import type { ReactElement } from "react";
import { forwardRef, useImperativeHandle, type ForwardedRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatThread } from "./TaskChatThread";

const transcriptState = vi.hoisted(() => ({ transcriptByRun: new Map() }));
const sidebarState = vi.hoisted(() => ({ isMobile: false }));

vi.mock("@/components/transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => transcriptState,
}));
vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: sidebarState.isMobile }),
}));
vi.mock("@/hooks/useIssuePlanDocument", () => ({
  useIssuePlanDocument: () => ({ data: null }),
}));
vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(function MockMarkdownEditor(
    { value }: { value: string },
    ref: ForwardedRef<unknown>,
  ) {
    useImperativeHandle(ref, () => ({ insertMarkdown: () => {}, focus: () => {} }));
    return <div data-testid="mock-editor">{value}</div>;
  }),
}));

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
  transcriptState.transcriptByRun.clear();
  sidebarState.isMobile = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  container.remove();
  localStorage.clear();
});

function render(ui: ReactElement) {
  flushSync(() => root!.render(<ThemeProvider>{ui}</ThemeProvider>));
}

describe("TaskChatThread draft pass-through", () => {
  it("keeps the composer dock aligned with the thread's horizontal padding", () => {
    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
      />,
    );

    const dock = container.querySelector('[data-testid="task-chat-composer-dock"]');
    expect(dock?.classList).toContain("px-4");
    expect(dock?.classList).not.toContain("px-1");
  });

  it("forwards draftKey so the composer restores a task's saved draft", () => {
    localStorage.setItem("task-chat-draft:issue-1", "half-written thought");

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        draftKey="task-chat-draft:issue-1"
      />,
    );

    expect(container.querySelector('[data-testid="mock-editor"]')?.textContent)
      .toBe("half-written thought");
  });
});

describe("TaskChatThread composer alignment (PAP-498)", () => {
  it("matches the thread width on mobile and stays narrower on larger screens", () => {
    render(<TaskChatThread comments={[]} onAdd={async () => {}} />);

    const dock = container
      .querySelector('[data-testid="mock-editor"]')
      ?.closest("div.sticky") as HTMLElement | null;

    expect(dock?.className).toContain("w-full");
    expect(dock?.className).toContain("md:w-(--pct-80)");
  });
});

describe("TaskChatThread queued message actions", () => {
  it("interrupts the exact run that a persisted queued message is waiting behind", () => {
    const onInterruptQueued = vi.fn(async () => {});
    const queuedComment = {
      id: "comment-queued",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "user" as const,
      authorAgentId: null,
      authorUserId: "user-1",
      body: "Use the latest requirements instead.",
      presentation: null,
      metadata: null,
      queueState: "queued" as const,
      queueTargetRunId: "run-active",
      createdAt: new Date("2026-08-14T12:00:00.000Z"),
      updatedAt: new Date("2026-08-14T12:00:00.000Z"),
    };

    render(
      <TaskChatThread
        comments={[queuedComment]}
        onAdd={async () => {}}
        onInterruptQueued={onInterruptQueued}
      />,
    );

    const interrupt = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Interrupt",
    );
    expect(container.textContent).toContain("Queued");
    expect(interrupt).not.toBeUndefined();

    flushSync(() => interrupt!.click());
    expect(onInterruptQueued).toHaveBeenCalledOnce();
    expect(onInterruptQueued).toHaveBeenCalledWith("run-active");
  });

  it("disables the action while the queued run is being interrupted", () => {
    render(
      <TaskChatThread
        comments={[{
          id: "comment-queued",
          companyId: "company-1",
          issueId: "issue-1",
          authorType: "user",
          authorAgentId: null,
          authorUserId: "user-1",
          body: "Use the latest requirements instead.",
          presentation: null,
          metadata: null,
          clientStatus: "queued",
          queueTargetRunId: "run-active",
          createdAt: new Date("2026-08-14T12:00:00.000Z"),
          updatedAt: new Date("2026-08-14T12:00:00.000Z"),
        }]}
        onAdd={async () => {}}
        onInterruptQueued={async () => {}}
        interruptingQueuedRunId="run-active"
      />,
    );

    const interrupting = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Interrupting…",
    );
    expect(interrupting).not.toBeUndefined();
    expect(interrupting?.disabled).toBe(true);
  });
});

describe("TaskChatThread mobile composer dock (PAP-495)", () => {
  it("pins the composer to the nav-aware bottom offset so its action row clears the auto-hiding bottom nav", () => {
    sidebarState.isMobile = true;

    render(<TaskChatThread comments={[]} onAdd={async () => {}} draftKey="task-chat-draft:issue-mobile" />);

    const dock = container
      .querySelector('[data-testid="mock-editor"]')
      ?.closest("div.sticky") as HTMLElement | null;

    expect(dock).not.toBeNull();
    // Bottom offset comes from --tc-composer-bottom (Layout raises it to the nav
    // height while the nav is on screen) — NOT the raw safe-area dock, which is
    // what let the nav occlude the action row before PAP-495.
    expect(dock?.className).toContain("bottom-(--tc-composer-bottom)");
    expect(dock?.className).not.toContain("bottom-(--sz-calc-8)");
  });
});

describe("TaskChatThread live transcript", () => {
  it("renders in-flight output through TaskChatLiveTail, dropping the debug plumbing (PAP-463 C1)", () => {
    // Interleave the exact noise the old RunTranscriptView tail surfaced (init
    // row, stdout/stderr/system dumps) with real content. Only the streamed
    // reply markdown and the tool row may reach the thread.
    transcriptState.transcriptByRun.set("run-1", [
      { kind: "init", ts: "2026-08-07T00:00:00.000Z", model: "claude", sessionId: "sess-INITMARKER" },
      { kind: "system", ts: "2026-08-07T00:00:00.000Z", text: "SYSTEMNOISE environment hint" },
      { kind: "stdout", ts: "2026-08-07T00:00:00.000Z", text: "STDOUTNOISE raw json dump" },
      { kind: "stderr", ts: "2026-08-07T00:00:00.000Z", text: "STDERRNOISE adapter timeout note" },
      {
        kind: "assistant",
        ts: "2026-08-07T00:00:00.000Z",
        text: "Streaming through the shared renderer",
      },
      { kind: "tool_call", ts: "2026-08-07T00:00:00.000Z", name: "Read", toolUseId: "t1", input: { file_path: "src/app.ts" } },
    ]);

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={{
          id: "run-1",
          status: "running",
          invocationSource: "issue",
          triggerDetail: null,
          startedAt: "2026-08-07T00:00:00.000Z",
          finishedAt: null,
          createdAt: "2026-08-07T00:00:00.000Z",
          agentId: "agent-1",
          agentName: "Coder",
          adapterType: "codex_local",
        }}
      />,
    );

    const tail = container.querySelector('[data-testid="task-chat-live-transcript"]');
    expect(tail).not.toBeNull();
    // Clean content survives: streamed reply markdown + compact phase summary.
    expect(tail!.textContent).toContain("Streaming through the shared renderer");
    const phaseSummary = tail!.querySelector<HTMLButtonElement>('[data-testid="task-chat-phase-summary"]');
    expect(phaseSummary?.getAttribute("aria-expanded")).toBe("false");
    flushSync(() => phaseSummary!.click());
    expect(tail!.textContent).toContain("src/app.ts");
    // None of the debug plumbing reaches the thread.
    for (const noise of ["INITMARKER", "SYSTEMNOISE", "STDOUTNOISE", "STDERRNOISE"]) {
      expect(container.textContent).not.toContain(noise);
    }
  });

  it("keeps the transcript mounted through run settle until the settled turn renders (PAP-462 B4)", () => {
    transcriptState.transcriptByRun.set("run-1", [
      {
        kind: "assistant",
        ts: "2026-08-07T00:00:00.000Z",
        text: "Last words before the run stops",
      },
    ]);

    const liveProps = {
      comments: [] as never[],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: {
        id: "run-1",
        status: "running",
        invocationSource: "issue" as const,
        triggerDetail: null,
        startedAt: "2026-08-07T00:00:00.000Z",
        finishedAt: null,
        createdAt: "2026-08-07T00:00:00.000Z",
        agentId: "agent-1",
        agentName: "Coder",
        adapterType: "codex_local",
      },
    };

    render(<TaskChatThread {...liveProps} />);
    expect(
      container.querySelector('[data-testid="task-chat-live-transcript"]'),
    ).not.toBeNull();

    // The run settles: the issue goes terminal and the run reports succeeded, so
    // `liveRun` flips to null — but no reply comment has landed yet. The
    // transcript must NOT vanish; it stays mounted (now as a settled tail) until
    // its settled turn/comment renders.
    render(
      <TaskChatThread
        {...liveProps}
        issueStatus="done"
        activeRun={{
          ...liveProps.activeRun,
          status: "succeeded",
          finishedAt: "2026-08-07T00:01:00.000Z",
        }}
      />,
    );

    expect(
      container.querySelector('[data-testid="task-chat-live-transcript"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Last words before the run stops");
    // The pill has settled to its "Worked" state rather than flipping back to a
    // spinner while it waits for the reply comment.
    expect(container.textContent).toContain("Worked");
  });
});
