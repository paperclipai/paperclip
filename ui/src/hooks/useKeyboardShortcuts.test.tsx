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
}: {
  onNewIssue: () => void;
  onSearch?: () => void;
}) {
  useKeyboardShortcuts({
    enabled: true,
    onNewIssue,
    onSearch,
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
});
