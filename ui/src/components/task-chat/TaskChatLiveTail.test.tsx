// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@/adapters";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatLiveTail } from "./TaskChatLiveTail";
import { transcriptToTaskChatItems } from "./transcript-adapter";
import type { TaskChatItem } from "./task-chat-model";

const TS = "2026-08-08T12:00:00.000Z";

describe("TaskChatLiveTail", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  function render(items: TaskChatItem[], emptyMessage?: string) {
    flushSync(() =>
      root!.render(
        <ThemeProvider>
          <TaskChatLiveTail items={items} emptyMessage={emptyMessage} />
        </ThemeProvider>,
      ),
    );
  }

  function parse(entries: TranscriptEntry[], running = true) {
    return transcriptToTaskChatItems(entries, { runId: "run-1", running });
  }

  it("renders streamed reply markdown and tool cards from a live transcript", () => {
    const items = parse([
      { kind: "assistant", ts: TS, text: "Looking into the failing test." },
      { kind: "tool_call", ts: TS, name: "Read", toolUseId: "t1", input: { file_path: "src/app.ts" } },
      { kind: "tool_result", ts: TS, toolUseId: "t1", content: "ok", isError: false },
    ]);
    render(items);

    expect(container.querySelector('[data-testid="task-chat-phase-interstitial"]')?.textContent).toContain(
      "Looking into the failing test.",
    );
    const phaseSummary = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-phase-summary"]');
    expect(phaseSummary?.getAttribute("aria-expanded")).toBe("false");
    flushSync(() => phaseSummary!.click());
    // Tool row renders with its name + mono target.
    expect(container.textContent).toContain("Read");
    expect(container.textContent).toContain("src/app.ts");
  });

  it("renders a tool's diff inset", () => {
    const items = parse([
      { kind: "tool_call", ts: TS, name: "Edit", toolUseId: "t1", input: { file_path: "a.ts" } },
      { kind: "diff", ts: TS, changeType: "add", text: "const x = 1;" },
      { kind: "diff", ts: TS, changeType: "remove", text: "const x = 0;" },
    ]);
    render(items);

    const phaseSummary = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-phase-summary"]');
    expect(phaseSummary?.getAttribute("aria-expanded")).toBe("false");
    flushSync(() => phaseSummary!.click());
    expect(container.textContent).toContain("const x = 1;");
    expect(container.textContent).toContain("+1 −1");
  });

  it("drops the debug plumbing kinds RunTranscriptView surfaced", () => {
    // Feed the exact noise the board flagged: init row, stdout/stderr/system
    // dumps, and a result line — interleaved with real content. None of the
    // noise may reach the DOM; only the assistant text + tool row survive.
    const items = parse([
      { kind: "init", ts: TS, model: "claude-opus", sessionId: "sess-INITMARKER" },
      { kind: "system", ts: TS, text: "SYSTEMNOISE hint about the environment" },
      { kind: "stdout", ts: TS, text: "STDOUTNOISE raw log line" },
      { kind: "stderr", ts: TS, text: "STDERRNOISE warning" },
      { kind: "assistant", ts: TS, text: "Here is the real reply." },
      { kind: "tool_call", ts: TS, name: "Bash", toolUseId: "t1", input: { command: "pnpm test" } },
      {
        kind: "result",
        ts: TS,
        text: "RESULTNOISE",
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 0,
        costUsd: 0.01,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ]);
    render(items);

    expect(container.querySelector('[data-testid="task-chat-phase-interstitial"]')?.textContent).toContain(
      "Here is the real reply.",
    );
    const phaseSummary = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-phase-summary"]');
    expect(phaseSummary?.getAttribute("aria-expanded")).toBe("false");
    flushSync(() => phaseSummary!.click());
    const text = container.textContent ?? "";
    expect(text).toContain("Here is the real reply.");
    expect(text).toContain("pnpm test");
    // No debug plumbing, no RunTranscriptView chrome.
    for (const noise of [
      "INITMARKER",
      "SYSTEMNOISE",
      "STDOUTNOISE",
      "STDERRNOISE",
      "RESULTNOISE",
      "Streaming",
      "LOG LINES",
      "SYSTEM MESSAGES",
    ]) {
      expect(text).not.toContain(noise);
    }
  });

  it("does not render a thinking row (its signal is the status pill)", () => {
    const items = parse([
      { kind: "thinking", ts: TS, text: "SECRET internal reasoning" },
      { kind: "assistant", ts: TS, text: "Visible answer." },
    ]);
    render(items);

    expect(container.textContent).toContain("Visible answer.");
    expect(container.textContent).not.toContain("SECRET internal reasoning");
  });

  it("shows the empty message when nothing renderable has streamed yet", () => {
    render([], "Waiting to start...");
    expect(container.textContent).toContain("Waiting to start...");
  });

  it("renders nothing (not even the empty message) once content exists", () => {
    const items = parse([{ kind: "assistant", ts: TS, text: "streaming…" }]);
    render(items, "Waiting to start...");
    expect(container.textContent).not.toContain("Waiting to start...");
    expect(container.textContent).toContain("streaming…");
  });
});
