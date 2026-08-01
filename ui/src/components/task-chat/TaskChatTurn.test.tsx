// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskChatTurn, turnSummaryText } from "./TaskChatTurn";
import { buildTurnSummary } from "./transcript-adapter";
import type { TranscriptEntry } from "@/adapters";
import type { TaskChatTurnItem } from "./task-chat-model";

const SETTLED: TaskChatTurnItem = {
  id: "t1",
  kind: "turn",
  settled: true,
  summary: { durationLabel: "38s", toolCount: 3, added: 34, removed: 3, tokensLabel: "12.3k tokens" },
  items: [{ id: "c1", kind: "tool", name: "read auth.ts", status: "completed" }],
};

describe("turnSummaryText", () => {
  it("joins the known parts with dots", () => {
    expect(turnSummaryText(SETTLED.summary)).toBe("Worked · 38s · 3 tools · +34 −3 · 12.3k tokens");
  });

  it("omits unknown parts and singularizes one tool", () => {
    expect(turnSummaryText({ toolCount: 1, added: 0, removed: 0 })).toBe("Worked · 1 tool");
  });

  it("labels failed turns Stopped", () => {
    expect(turnSummaryText({ toolCount: 0, added: 0, removed: 0, failed: true })).toBe("Stopped");
  });
});

describe("buildTurnSummary", () => {
  it("counts tools, diff lines and result tokens from a transcript", () => {
    const entries: TranscriptEntry[] = [
      { kind: "tool_call", ts: "2026-07-29T10:00:00Z", name: "edit", input: {} },
      { kind: "diff", ts: "2026-07-29T10:00:05Z", changeType: "add", text: "+a" },
      { kind: "diff", ts: "2026-07-29T10:00:05Z", changeType: "remove", text: "-b" },
      {
        kind: "result", ts: "2026-07-29T10:00:38Z", text: "done", inputTokens: 12000,
        outputTokens: 300, cachedTokens: 0, costUsd: 0.01, subtype: "success", isError: false, errors: [],
      },
    ];
    const summary = buildTurnSummary(entries);
    expect(summary.toolCount).toBe(1);
    expect(summary.added).toBe(1);
    expect(summary.removed).toBe(1);
    expect(summary.tokensLabel).toBe("12.3k tokens");
    expect(summary.durationLabel).toBe("38s");
  });

  it("prefers an explicit duration and flags failure", () => {
    const summary = buildTurnSummary([], { durationMs: 95_000, failed: true });
    expect(summary.durationLabel).toBe("1m 35s");
    expect(summary.failed).toBe(true);
  });
});

describe("TaskChatTurn", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  const renderTurn = (item: TaskChatTurnItem) => {
    flushSync(() => {
      root.render(<TaskChatTurn item={item} renderChild={(c) => <span>{c.id}</span>} />);
    });
  };

  const fold = () => container.querySelector(".tc-turn-fold");
  const summaryBtn = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="task-chat-turn-summary"]');

  it("renders a settled turn folded with its summary line", () => {
    renderTurn(SETTLED);
    // Label and mono metrics are adjacent spans (v7 runsum grammar).
    expect(summaryBtn()?.textContent).toContain("Worked");
    expect(summaryBtn()?.textContent).toContain("38s · 3 tools · +34 −3 · 12.3k tokens");
    expect(fold()?.getAttribute("data-folded")).toBe("true");
  });

  it("toggles open on summary click", () => {
    renderTurn(SETTLED);
    flushSync(() => summaryBtn()!.click());
    expect(fold()?.getAttribute("data-folded")).toBe("false");
  });

  it("renders a live turn expanded with no summary line", () => {
    renderTurn({ ...SETTLED, settled: false });
    expect(summaryBtn()).toBeNull();
    expect(fold()?.getAttribute("data-folded")).toBe("false");
  });

  it("folds when the item settles while mounted", () => {
    renderTurn({ ...SETTLED, settled: false });
    renderTurn({ ...SETTLED, animateFold: true });
    expect(fold()?.getAttribute("data-folded")).toBe("true");
  });
});
