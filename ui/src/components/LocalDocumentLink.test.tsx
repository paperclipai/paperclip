// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentOpenerProvider } from "../context/DocumentOpenerContext";
import { LocalDocumentLink } from "./LocalDocumentLink";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const toastMock = { pushToast: vi.fn(), dismissToast: vi.fn(), clearToasts: vi.fn() };
vi.mock("../context/ToastContext", () => ({
  useOptionalToastActions: () => toastMock,
}));

describe("LocalDocumentLink", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(() => {
    toastMock.pushToast.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  async function flushEffects() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function renderWithReady(href: string) {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    act(() => {
      root.render(
        <DocumentOpenerProvider>
          <LocalDocumentLink href={href}>Tagesplan</LocalDocumentLink>
        </DocumentOpenerProvider>,
      );
    });
  }

  function openButton() {
    return container.querySelector('button[aria-label="Öffnen"]') as HTMLButtonElement | null;
  }
  function revealButton() {
    return container.querySelector(
      'button[aria-label="Im Finder zeigen"], button[aria-label="Im Explorer zeigen"]',
    ) as HTMLButtonElement | null;
  }

  it("renders link text and two icon buttons", () => {
    renderWithReady("/Users/foo/Tagesplan.md");
    expect(container.textContent).toContain("Tagesplan");
    expect(openButton()).not.toBeNull();
    expect(revealButton()).not.toBeNull();
  });

  it("clicking 'Öffnen' calls /open with the path", async () => {
    renderWithReady("/Users/foo/Tagesplan.md");
    await flushEffects();
    expect(openButton()?.disabled).toBe(false);
    act(() => {
      openButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:19327/open",
      expect.objectContaining({
        body: JSON.stringify({ path: "/Users/foo/Tagesplan.md" }),
      }),
    );
  });

  it("clicking 'Im Finder zeigen' calls /reveal", async () => {
    renderWithReady("/Users/foo/Tagesplan.md");
    await flushEffects();
    expect(revealButton()?.disabled).toBe(false);
    act(() => {
      revealButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:19327/reveal",
      expect.any(Object),
    );
  });

  it("shows error toast on /open failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })); // health
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "path outside allowed roots" }), { status: 403 }),
    );
    act(() => {
      root.render(
        <DocumentOpenerProvider>
          <LocalDocumentLink href="/etc/hosts">hosts</LocalDocumentLink>
        </DocumentOpenerProvider>,
      );
    });
    await flushEffects();
    expect(openButton()?.disabled).toBe(false);
    act(() => {
      openButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();
    expect(toastMock.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        tone: "error",
        title: expect.stringContaining("path outside allowed roots"),
      }),
    );
  });

  it("buttons are disabled when status is 'unavailable'", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 503 }));
    act(() => {
      root.render(
        <DocumentOpenerProvider>
          <LocalDocumentLink href="/Users/foo/x.md">x</LocalDocumentLink>
        </DocumentOpenerProvider>,
      );
    });
    await flushEffects();
    expect(openButton()?.disabled).toBe(true);
    expect(revealButton()?.disabled).toBe(true);
  });
});
