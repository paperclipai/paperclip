// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lineScrollOffset, TaskChatStatusPill } from "./TaskChatStatusPill";
import { whimsyWord, WHIMSY_ROTATE_MS } from "./status-whimsy";
import type { TaskChatStatusItem } from "./task-chat-model";

function liveStatus(overrides: Partial<TaskChatStatusItem> = {}): TaskChatStatusItem {
  return {
    id: "run-42:status",
    kind: "status",
    status: "running",
    label: "Running",
    startedAtMs: Date.now(),
    ...overrides,
  };
}

describe("TaskChatStatusPill whimsy", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.documentElement.style.removeProperty("--motion-interstitial-dwell");
    document.documentElement.style.removeProperty("--motion-line-scroll");
    vi.useRealTimers();
  });

  const render = (item: TaskChatStatusItem) => {
    act(() => {
      root.render(<TaskChatStatusPill item={item} />);
    });
  };

  it("swaps the generic Running label for a deterministic whimsical word", () => {
    const item = liveStatus();
    render(item);
    const expected = whimsyWord(item.id, 0);
    expect(container.textContent).toContain(`${expected}…`);
    expect(container.textContent).not.toContain("Running…");
  });

  it("rotates the word roughly every 10s while live", () => {
    const item = liveStatus();
    render(item);
    const first = whimsyWord(item.id, 0);
    expect(container.textContent).toContain(`${first}…`);
    act(() => {
      vi.advanceTimersByTime(WHIMSY_ROTATE_MS + 100);
    });
    const second = whimsyWord(item.id, WHIMSY_ROTATE_MS + 100);
    expect(second).not.toBe(first);
    expect(container.textContent).toContain(`${second}…`);
    expect(container.textContent).not.toContain(`${first}…`);
  });

  it("keeps the informative taxonomy verb when the tail identifies a real tool", () => {
    render(
      liveStatus({
        label: "Running a command",
        detail: "Terminal · ls -la",
        toolName: "Bash",
      }),
    );
    expect(container.textContent).toContain("Running a command…");
    expect(container.textContent).toContain("Terminal · ls -la");
  });

  it("keeps Queued copy untouched", () => {
    render(liveStatus({ label: "Queued", detail: "Waiting to start" }));
    expect(container.textContent).toContain("Queued…");
  });

  it("keeps elapsed and token readouts alongside the whimsical word", () => {
    const item = liveStatus({ tokens: { used: 18240, size: 200000 } });
    render(item);
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(container.textContent).toContain("1.2s");
    expect(container.textContent).toContain("18,240/200,000 ctx");
  });

  it("permanently reserves the interstitial row while live so layout never jumps (round 9)", () => {
    const item = liveStatus({ tokens: { used: 18240, size: 200000 } });
    render(item);
    // No message streaming: the row is still mounted as an empty one-line
    // slot (same height as when text occupies it) — nothing above shifts when
    // a message later appears.
    const row = container.querySelector('[data-testid="task-chat-interstitial-row"]');
    expect(row).not.toBeNull();
    expect(container.querySelector('[data-testid="task-chat-live-self-talk"]')).toBeNull();
    // The empty slot keeps the 1lh viewport height.
    expect(row?.querySelector(".tc-line-scroll")).not.toBeNull();
  });

  it("mounts a streaming interstitial as its own row above the status line (PAP-361 amended)", () => {
    const item = liveStatus({
      label: "Responding",
      selfTalk: "I'll extend the ipRateLimit helper with a per-account bucket.",
      tokens: { used: 18240, size: 200000 },
    });
    render(item);
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    const row = container.querySelector('[data-testid="task-chat-interstitial-row"]');
    const line = container.querySelector('[data-testid="task-chat-live-self-talk"]');
    expect(row).not.toBeNull();
    expect(line?.textContent).toBe("I'll extend the ipRateLimit helper with a per-account bucket.");
    // The row sits DIRECTLY ABOVE the status line — never sharing it: the
    // gerund rotation runs uninterrupted below (no "Responding…" copy), with
    // meta and pulse dot in place.
    expect(row?.nextElementSibling?.textContent).toContain(`${whimsyWord(item.id, 1200)}…`);
    expect(row?.contains(line)).toBe(true);
    expect(container.textContent).not.toContain("Responding…");
    expect(container.textContent).toContain("1.2s");
    expect(container.textContent).toContain("18,240/200,000 ctx");
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    // Viewport + transition classes: 1lh clip outside, transform-only inner.
    expect(line?.className).toContain("tc-line-scroll");
    expect(line?.firstElementChild?.className).toContain("tc-line-scroll-inner");
  });

  it("holds the finished update through the dwell, then slides it away (PAP-376)", () => {
    document.documentElement.style.setProperty("--motion-interstitial-dwell", "4000ms");
    document.documentElement.style.setProperty("--motion-line-scroll", "240ms");
    render(liveStatus({ label: "Responding", selfTalk: "Almost there." }));
    render(liveStatus({}));
    // selfTalk gone → held as a static single-line readout while the dwell
    // runs.
    act(() => {
      vi.advanceTimersByTime(3900);
    });
    let line = container.querySelector('[data-testid="task-chat-live-self-talk"]');
    expect(line?.textContent).toBe("Almost there.");
    expect(line?.getAttribute("data-streaming")).toBeNull();
    expect(line?.getAttribute("data-leaving")).toBeNull();
    expect(line?.firstElementChild?.className).toContain("truncate");
    // Dwell expired with no successor: the line slides up out of the 1lh
    // viewport with the transition re-enabled…
    act(() => {
      vi.advanceTimersByTime(200);
    });
    line = container.querySelector('[data-testid="task-chat-live-self-talk"]');
    expect(line?.getAttribute("data-leaving")).toBe("true");
    const inner = line?.firstElementChild as HTMLElement;
    expect(inner.style.transform).toContain("-1");
    expect(inner.style.transition).toBe("");
    // …and unmounts back to the reserved empty slot; gerund + dot carry on.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(container.querySelector('[data-testid="task-chat-live-self-talk"]')).toBeNull();
    const row = container.querySelector('[data-testid="task-chat-interstitial-row"]');
    expect(row).not.toBeNull();
    expect(row?.querySelector(".tc-line-scroll")).not.toBeNull();
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("swaps a new update straight in after the held line has slid away", () => {
    document.documentElement.style.setProperty("--motion-interstitial-dwell", "4000ms");
    render(liveStatus({ label: "Responding", selfTalk: "First." }));
    render(liveStatus({}));
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(container.querySelector('[data-testid="task-chat-live-self-talk"]')).toBeNull();
    render(liveStatus({ label: "Responding", selfTalk: "Second." }));
    const line = container.querySelector('[data-testid="task-chat-live-self-talk"]');
    expect(line?.textContent).toBe("Second.");
    expect(line?.getAttribute("data-streaming")).toBe("true");
  });

  it("renders the interstitial text without a leading icon (PAP-376)", () => {
    render(liveStatus({ label: "Responding", selfTalk: "No icon on this row." }));
    const row = container.querySelector('[data-testid="task-chat-interstitial-row"]');
    expect(row?.textContent).toBe("No icon on this row.");
    expect(row?.querySelector("svg")).toBeNull();
    // The empty lead slot still column-aligns the text with the status label.
    expect(row?.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("streams the tail line without a transition once the enter slide settles", () => {
    render(liveStatus({ label: "Responding", selfTalk: "Streaming along nicely." }));
    act(() => {
      vi.advanceTimersByTime(50);
    });
    const line = container.querySelector('[data-testid="task-chat-live-self-talk"]');
    expect(line?.getAttribute("data-streaming")).toBe("true");
    // Post-enter (--motion-line-scroll reads 0ms in jsdom) the inline
    // transition is disabled: mid-stream wraps snap instead of gliding.
    const inner = line?.firstElementChild as HTMLElement;
    expect(inner.style.transition).toBe("none");
    expect(inner.className).not.toContain("truncate");
  });

  it("respects the minimum dwell between swaps and collapses bursts latest-wins", () => {
    document.documentElement.style.setProperty("--motion-interstitial-dwell", "4000ms");
    // Update A streams and finishes → held.
    render(liveStatus({ label: "Responding", selfTalk: "Update A." }));
    render(liveStatus({}));
    const innerBefore = container.querySelector(".tc-line-scroll-inner");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // Update B arrives 1s after A swapped in: inside the dwell → queued.
    render(liveStatus({ label: "Responding", selfTalk: "Update B." }));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(container.textContent).toContain("Update A.");
    // Update C supersedes B while still queued (latest-wins queue of one).
    render(liveStatus({ label: "Responding", selfTalk: "Update C." }));
    act(() => {
      vi.advanceTimersByTime(900);
    });
    // 3.9s since A swapped in — still inside the dwell.
    expect(container.textContent).toContain("Update A.");
    expect(container.textContent).not.toContain("Update B.");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    // Dwell expired → only the NEWEST pending update swaps in; B never shows.
    const line = container.querySelector('[data-testid="task-chat-live-self-talk"]');
    expect(line?.textContent).toBe("Update C.");
    expect(container.textContent).not.toContain("Update A.");
    expect(container.textContent).not.toContain("Update B.");
    // The swap remounts the line (new key) so the slide plays exactly then.
    expect(container.querySelector(".tc-line-scroll-inner")).not.toBe(innerBefore);
    // C was still streaming at swap time → it keeps tracking the tail.
    expect(line?.getAttribute("data-streaming")).toBe("true");
  });

  it("swaps a queued update in as held when its stream already ended", () => {
    document.documentElement.style.setProperty("--motion-interstitial-dwell", "4000ms");
    render(liveStatus({ label: "Responding", selfTalk: "Update A." }));
    render(liveStatus({}));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // B streams and ENDS while A's dwell is still running.
    render(liveStatus({ label: "Responding", selfTalk: "Update B, done already." }));
    render(liveStatus({}));
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    const line = container.querySelector('[data-testid="task-chat-live-self-talk"]');
    expect(line?.textContent).toBe("Update B, done already.");
    expect(line?.getAttribute("data-streaming")).toBeNull();
    expect(line?.firstElementChild?.className).toContain("truncate");
  });

  it("clears the held line when the turn ends", () => {
    render(liveStatus({ label: "Responding", selfTalk: "Held across the turn?" }));
    render(liveStatus({}));
    expect(container.textContent).toContain("Held across the turn?");
    // Turn settles into a non-live status: the row (and held text) is gone;
    // a later live turn must not resurrect the old update.
    render(liveStatus({ status: "interrupted", label: "Interrupted" }));
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(container.querySelector('[data-testid="task-chat-interstitial-row"]')).toBeNull();
    render(liveStatus({}));
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(container.textContent).not.toContain("Held across the turn?");
    expect(container.querySelector('[data-testid="task-chat-live-self-talk"]')).toBeNull();
  });
});

describe("lineScrollOffset", () => {
  it("translates up one line-height per wrapped line", () => {
    expect(lineScrollOffset(16, 16)).toBe(0); // one line — no shift
    expect(lineScrollOffset(32, 16)).toBe(1);
    expect(lineScrollOffset(48.5, 16)).toBe(2); // sub-pixel scrollHeight rounds
  });

  it("never goes negative and guards bad measurements", () => {
    expect(lineScrollOffset(0, 16)).toBe(0);
    expect(lineScrollOffset(32, 0)).toBe(0);
    expect(lineScrollOffset(Number.NaN, 16)).toBe(0);
  });
});
