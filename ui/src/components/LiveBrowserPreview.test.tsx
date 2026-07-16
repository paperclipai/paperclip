// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveBrowserPreview } from "./LiveBrowserPreview";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("LiveBrowserPreview", () => {
  it("shows an explicit disconnected preview when EventSource is unavailable", () => {
    vi.stubGlobal("EventSource", undefined);

    expect(() => {
      act(() => {
        root.render(<LiveBrowserPreview runId="run-1" agentName="Browser agent" />);
      });
    }).not.toThrow();

    expect(container.querySelector("[data-testid=live-browser-preview]")).not.toBeNull();
    expect(container.textContent).toContain("Reconnecting to the Camoufox preview");
  });
});
