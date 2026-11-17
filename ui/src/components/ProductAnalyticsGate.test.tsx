// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProductAnalyticsForTest } from "@/lib/analytics/product-analytics";
import { ProductAnalyticsGate } from "./ProductAnalyticsGate";

const getSessionMock = vi.hoisted(() => vi.fn());
const posthogMock = vi.hoisted(() => ({
  init: vi.fn(),
  register: vi.fn(),
  identify: vi.fn(),
  group: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("@/api/auth", () => ({
  authApi: { getSession: () => getSessionMock() },
}));

/** PostHog script elements the module adds to the page. */
function injectedScripts() {
  return [...document.querySelectorAll("script")].filter((script) => script.src.includes("/static/array.js"));
}

// jsdom does not fetch scripts: when the module adds PostHog's script, act as
// the browser would after it loads (the script sets `window.posthog`).
const appendChild = document.head.appendChild.bind(document.head);
vi.spyOn(document.head, "appendChild").mockImplementation(<T extends Node>(node: T): T => {
  const result = appendChild(node);
  if (node instanceof HTMLScriptElement && node.src.includes("/static/array.js")) {
    (window as unknown as { posthog: typeof posthogMock }).posthog = posthogMock;
    queueMicrotask(() => node.onload?.(new Event("load")));
  }
  return result;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ACTOR_ID = "paperclip-id:uf2X8Ha4H9hNdAMnc1rOy91VIRos5pch";
const user = { id: ACTOR_ID, email: "jane@example.com", name: "Jane", image: null };

function session(browserAnalytics: unknown) {
  return {
    session: { id: `paperclip:session:${ACTOR_ID}`, userId: ACTOR_ID },
    user,
    sentryDsn: null,
    browserAnalytics,
  };
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
}

describe("ProductAnalyticsGate", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
    resetProductAnalyticsForTest();
    for (const script of injectedScripts()) script.remove();
    delete (window as unknown as { posthog?: unknown }).posthog;
    vi.clearAllMocks();
  });

  async function renderGate() {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProductAnalyticsGate />
        </QueryClientProvider>,
      );
    });
    await settle();
    return root;
  }

  it("loads nothing and does nothing when the session has no analytics config (self-hosted)", async () => {
    getSessionMock.mockResolvedValue(session(null));
    const root = await renderGate();
    expect(injectedScripts()).toHaveLength(0);
    expect(posthogMock.init).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("loads nothing when signed out", async () => {
    getSessionMock.mockResolvedValue(null);
    const root = await renderGate();
    expect(injectedScripts()).toHaveLength(0);
    act(() => root.unmount());
  });

  it("loads posthog-js and identifies the user when the session carries a config", async () => {
    getSessionMock.mockResolvedValue(session({
      token: "phc_test",
      apiHost: "/_ph",
      uiHost: null,
      environment: "production",
      stackId: "stack-1",
      replayEnabled: false,
    }));
    const root = await renderGate();
    // PostHog's script comes through the same-origin proxy, never from PostHog directly.
    expect(injectedScripts().map((script) => new URL(script.src).pathname)).toEqual(["/_ph/static/array.js"]);
    expect(posthogMock.init).toHaveBeenCalledWith("phc_test", expect.objectContaining({ disable_session_recording: true }));
    // Same id, same format, as the server's actor id (its events' distinct_id).
    expect(posthogMock.identify).toHaveBeenCalledWith(ACTOR_ID, { email: "jane@example.com", name: "Jane" });
    expect(posthogMock.group).toHaveBeenCalledWith("workspace", "stack-1");
    expect(posthogMock.register).toHaveBeenCalledWith({ deployment_source: "cloud", environment: "production" });
    act(() => root.unmount());
  });
});
