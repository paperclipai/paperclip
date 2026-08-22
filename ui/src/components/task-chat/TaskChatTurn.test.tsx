// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskChatTurn, turnSummaryText } from "./TaskChatTurn";
import { buildTurnSummary } from "./transcript-adapter";
import type { TranscriptEntry } from "@/adapters";
import type {
  TaskChatStatusItem,
  TaskChatToolStatus,
  TaskChatTurnChildItem,
  TaskChatTurnItem,
} from "./task-chat-model";

const tool = (id: string, status: TaskChatToolStatus = "completed"): TaskChatTurnChildItem => ({
  id,
  kind: "tool",
  name: "Read",
  status,
});

const SETTLED: TaskChatTurnItem = {
  id: "t1",
  kind: "turn",
  settled: true,
  summary: { durationLabel: "38s", toolCount: 3, added: 34, removed: 3, tokensLabel: "12.3k tokens" },
  items: [{ id: "c1", kind: "tool", name: "read auth.ts", status: "completed" }],
};

// Non-generic label so the header shows it verbatim (no whimsy substitution).
const LIVE_STATUS: TaskChatStatusItem = {
  id: "t1:status",
  kind: "status",
  status: "working",
  label: "Editing files",
  detail: "Edit · server/src/routes/auth.ts",
  toolName: "Edit",
};

const parentRowTurn = (
  children: TaskChatTurnChildItem[],
  status: TaskChatStatusItem = LIVE_STATUS,
): TaskChatTurnItem => ({
  ...SETTLED,
  settled: false,
  liveStatus: status,
  items: children,
});

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
  const liveHeaderBtn = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="task-chat-live-turn"]');

  it("renders a settled turn folded with its summary line", () => {
    renderTurn(SETTLED);
    // Label and mono metrics are adjacent spans (v7 runsum grammar).
    expect(summaryBtn()?.textContent).toContain("Worked");
    expect(summaryBtn()?.textContent).toContain("38s · 3 tools · +34 −3 · 12.3k tokens");
    expect(fold()?.getAttribute("data-folded")).toBe("true");
    expect(summaryBtn()?.firstElementChild?.tagName).toBe("svg");
    expect(summaryBtn()?.querySelector(".tc-turn-metrics")?.getAttribute("data-visible")).toBe("false");
  });

  it("toggles open on summary click", () => {
    renderTurn(SETTLED);
    flushSync(() => summaryBtn()!.click());
    expect(fold()?.getAttribute("data-folded")).toBe("false");
    expect(summaryBtn()?.querySelector(".tc-turn-metrics")?.getAttribute("data-visible")).toBe("true");
  });

  it("a headerless live turn renders expanded with no summary line", () => {
    renderTurn({ ...SETTLED, settled: false });
    expect(summaryBtn()).toBeNull();
    expect(liveHeaderBtn()).toBeNull();
    expect(fold()?.getAttribute("data-folded")).toBe("false");
  });

  it("a headerless live turn folds when it settles while mounted", () => {
    renderTurn({ ...SETTLED, settled: false });
    renderTurn({ ...SETTLED, animateFold: true });
    expect(fold()?.getAttribute("data-folded")).toBe("true");
  });

  it("collapses a live parent-row turn to its single status line", () => {
    renderTurn(parentRowTurn([tool("a"), tool("b"), tool("c", "in_progress")]));
    const header = liveHeaderBtn();
    expect(header?.textContent).toContain("Editing files…");
    expect(header?.textContent).toContain("Edit · server/src/routes/auth.ts");
    expect(header?.getAttribute("aria-expanded")).toBe("false");
    expect(header?.firstElementChild?.firstElementChild?.tagName).toBe("svg");
    // All activity is folded behind it — no rows visible, no summary line.
    expect(fold()?.getAttribute("data-folded")).toBe("true");
    expect(summaryBtn()).toBeNull();
  });

  it("flashes the in-flight tool state through the header", () => {
    renderTurn(parentRowTurn([tool("a")]));
    expect(liveHeaderBtn()?.textContent).toContain("Editing files…");
    renderTurn(
      parentRowTurn([tool("a")], { ...LIVE_STATUS, label: "Reading a file", detail: "Read · auth.ts", toolName: "Read" }),
    );
    expect(liveHeaderBtn()?.textContent).toContain("Reading a file…");
    expect(liveHeaderBtn()?.textContent).toContain("Read · auth.ts");
  });

  it("expands to the nested chronological history on click", () => {
    renderTurn(parentRowTurn([tool("a"), tool("b")]));
    flushSync(() => liveHeaderBtn()!.click());
    expect(liveHeaderBtn()?.getAttribute("aria-expanded")).toBe("true");
    expect(fold()?.getAttribute("data-folded")).toBe("false");
    expect(fold()?.textContent).toContain("a");
    expect(fold()?.textContent).toContain("b");
  });

  it("appends new rows live while expanded and re-collapses on click", () => {
    renderTurn(parentRowTurn([tool("a")]));
    flushSync(() => liveHeaderBtn()!.click());
    renderTurn(parentRowTurn([tool("a"), tool("b", "in_progress")]));
    expect(fold()?.getAttribute("data-folded")).toBe("false");
    expect(fold()?.textContent).toContain("b");
    flushSync(() => liveHeaderBtn()!.click());
    expect(fold()?.getAttribute("data-folded")).toBe("true");
  });

  it("keeps the interstitial row outside the expand button's hover target (PAP-376)", () => {
    // act() so the held-line effect state (useHeldSelfTalk) flushes.
    act(() => {
      renderTurn(
        parentRowTurn([tool("a")], { ...LIVE_STATUS, selfTalk: "Streaming an update." }),
      );
    });
    const btn = liveHeaderBtn();
    expect(btn).not.toBeNull();
    // The button (hover + click target) wraps ONLY the gerund status line;
    // the interstitial text renders above it, outside the button.
    expect(btn?.querySelector('[data-testid="task-chat-interstitial-row"]')).toBeNull();
    expect(btn?.textContent).not.toContain("Streaming an update.");
    const row = container.querySelector('[data-testid="task-chat-interstitial-row"]');
    expect(row?.textContent).toContain("Streaming an update.");
    // Expanding still works from the status line alone.
    flushSync(() => btn!.click());
    expect(liveHeaderBtn()?.getAttribute("aria-expanded")).toBe("true");
    expect(fold()?.getAttribute("data-folded")).toBe("false");
  });

  it("renders the status line without an expand affordance while there is no activity", () => {
    renderTurn(parentRowTurn([]));
    expect(liveHeaderBtn()).toBeNull();
    expect(container.textContent).toContain("Editing files…");
  });

  it("morphs a collapsed parent row into the settled summary in place", () => {
    renderTurn(parentRowTurn([tool("a")]));
    renderTurn({ ...SETTLED, animateFold: true, items: [tool("a")] });
    expect(liveHeaderBtn()).toBeNull();
    expect(summaryBtn()?.textContent).toContain("Worked");
    expect(fold()?.getAttribute("data-folded")).toBe("true");
  });

  it("keeps the expand state across the settle morph", () => {
    renderTurn(parentRowTurn([tool("a")]));
    flushSync(() => liveHeaderBtn()!.click());
    renderTurn({ ...SETTLED, animateFold: true, items: [tool("a")] });
    expect(summaryBtn()?.getAttribute("aria-expanded")).toBe("true");
    expect(fold()?.getAttribute("data-folded")).toBe("false");
  });

  it("rides the `leading` slot on the header row, anchored above the fold (PAP-413)", () => {
    flushSync(() => {
      root.render(
        <TaskChatTurn
          item={SETTLED}
          leading={<div data-testid="turn-lead">actions</div>}
          renderChild={(c) => <span>{c.id}</span>}
        />,
      );
    });
    const lead = container.querySelector('[data-testid="turn-lead"]');
    expect(lead).not.toBeNull();
    // It sits beside the summary button on the header row — NOT inside the
    // expandable fold — so expanding the tool history can't drag it down.
    expect(fold()?.contains(lead!)).toBe(false);
    expect(summaryBtn()).not.toBeNull();
    // Expanding still works and the leading slot stays put outside the fold.
    flushSync(() => summaryBtn()!.click());
    expect(fold()?.getAttribute("data-folded")).toBe("false");
    expect(fold()?.contains(lead!)).toBe(false);
  });

  it("leads the settled summary with the bubble timestamp when attached (round 9)", () => {
    flushSync(() => {
      root.render(
        <TaskChatTurn item={SETTLED} timestampPrefix="2:34 PM" renderChild={(c) => <span>{c.id}</span>} />,
      );
    });
    // "2:34 PM · ✓ Worked · …" — timestamp first, always visible, and the
    // expand affordance still works from the same line.
    expect(summaryBtn()?.textContent).toMatch(/^2:34 PM·Worked/);
    expect(summaryBtn()?.firstElementChild?.tagName).toBe("svg");
    flushSync(() => summaryBtn()!.click());
    expect(fold()?.getAttribute("data-folded")).toBe("false");
  });
});
