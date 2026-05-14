// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DocumentOpenerProvider,
  useDocumentOpenerStatus,
} from "./DocumentOpenerContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function StatusProbe({ container }: { container: HTMLElement }) {
  return null; // unused — probe logic is inline below
}
void StatusProbe; // silence unused warning

describe("DocumentOpenerProvider", () => {
  const fetchMock = vi.fn();
  let container: HTMLDivElement;
  let root: Root;

  // Helper: render provider + a status div
  let currentStatus: string | null = null;

  function StatusDisplay() {
    const status = useDocumentOpenerStatus();
    currentStatus = status;
    return <div data-testid="status">{status}</div>;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    currentStatus = null;
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("starts in 'unavailable' before first health response", () => {
    // fetch never resolves during this test — status must stay "unavailable"
    fetchMock.mockReturnValue(new Promise(() => {}));
    act(() => {
      root.render(
        <DocumentOpenerProvider>
          <StatusDisplay />
        </DocumentOpenerProvider>,
      );
    });
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe("unavailable");
  });

  it("becomes 'ready' after first 200 from /health", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    act(() => {
      root.render(
        <DocumentOpenerProvider>
          <StatusDisplay />
        </DocumentOpenerProvider>,
      );
    });
    // Drain microtasks so the fetch promise resolves and setState fires
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe("ready");
  });

  it("flips back to 'unavailable' if health starts failing", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    act(() => {
      root.render(
        <DocumentOpenerProvider>
          <StatusDisplay />
        </DocumentOpenerProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe("ready");

    fetchMock.mockResolvedValue(new Response("{}", { status: 503 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe("unavailable");
  });
});
