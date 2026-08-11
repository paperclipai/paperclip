// @vitest-environment jsdom

import type { ReactElement } from "react";
import { forwardRef, useImperativeHandle, type ForwardedRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatThread } from "./TaskChatThread";

const transcriptState = vi.hoisted(() => ({ transcriptByRun: new Map() }));

vi.mock("@/components/transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => transcriptState,
}));
vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
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
    // Clean content survives: streamed reply markdown + tool row.
    expect(tail!.textContent).toContain("Streaming through the shared renderer");
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
