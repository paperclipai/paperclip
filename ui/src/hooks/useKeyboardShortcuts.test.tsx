// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function TestHarness({
  onNewIssue,
  onSearch,
  onGoToInbox,
}: {
  onNewIssue: () => void;
  onSearch?: () => void;
  onGoToInbox?: () => void;
}) {
  useKeyboardShortcuts({
    enabled: true,
    onNewIssue,
    onSearch,
    onGoToInbox,
  });

  return <div>keyboard shortcuts test</div>;
}

describe("useKeyboardShortcuts", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("ignores events already claimed by another handler", () => {
    const root = createRoot(container);
    const onNewIssue = vi.fn();

    act(() => {
      root.render(<TestHarness onNewIssue={onNewIssue} />);
    });

    const event = new KeyboardEvent("keydown", {
      key: "c",
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    document.dispatchEvent(event);

    expect(onNewIssue).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("focuses the current page search target on slash", () => {
    const root = createRoot(container);
    const onSearch = vi.fn();
    const input = document.createElement("input");
    input.setAttribute("data-page-search-target", "true");
    vi.spyOn(input, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    document.body.appendChild(input);

    act(() => {
      root.render(<TestHarness onNewIssue={vi.fn()} onSearch={onSearch} />);
    });

    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "/",
      bubbles: true,
      cancelable: true,
    }));

    expect(document.activeElement).toBe(input);
    expect(onSearch).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    input.remove();
  });

  it("falls back to quick search when the page has no search target", () => {
    const root = createRoot(container);
    const onSearch = vi.fn();

    act(() => {
      root.render(<TestHarness onNewIssue={vi.fn()} onSearch={onSearch} />);
    });

    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "/",
      bubbles: true,
      cancelable: true,
    }));

    expect(onSearch).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it("does not intercept the retired Cmd/Ctrl+B collapse shortcut", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<TestHarness onNewIssue={vi.fn()} />);
    });

    const metaEvent = new KeyboardEvent("keydown", {
      key: "b",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(metaEvent);
    expect(metaEvent.defaultPrevented).toBe(false);

    const ctrlEvent = new KeyboardEvent("keydown", {
      key: "b",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(ctrlEvent);
    expect(ctrlEvent.defaultPrevented).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  const pressKey = (key: string) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event;
  };

  it("navigates to the inbox on the g \u2192 i chord", () => {
    const root = createRoot(container);
    const onGoToInbox = vi.fn();
    const onNewIssue = vi.fn();

    act(() => {
      root.render(<TestHarness onNewIssue={onNewIssue} onGoToInbox={onGoToInbox} />);
    });

    // Bare "i" does nothing.
    pressKey("i");
    expect(onGoToInbox).not.toHaveBeenCalled();

    pressKey("g");
    const chordEvent = pressKey("i");
    expect(onGoToInbox).toHaveBeenCalledTimes(1);
    expect(chordEvent.defaultPrevented).toBe(true);

    // Chord disarms after firing.
    pressKey("i");
    expect(onGoToInbox).toHaveBeenCalledTimes(1);
    expect(onNewIssue).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("swallows armed chord keys instead of firing bare shortcuts", () => {
    const root = createRoot(container);
    const onGoToInbox = vi.fn();
    const onNewIssue = vi.fn();

    act(() => {
      root.render(<TestHarness onNewIssue={onNewIssue} onGoToInbox={onGoToInbox} />);
    });

    // g \u2192 c is the issue-detail focus-comment chord; globally it must not
    // open the new-issue dialog.
    pressKey("g");
    pressKey("c");
    expect(onNewIssue).not.toHaveBeenCalled();
    expect(onGoToInbox).not.toHaveBeenCalled();

    // Bare "c" still creates.
    pressKey("c");
    expect(onNewIssue).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

});
