// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProductAnalyticsForTest } from "@/lib/analytics/product-analytics";
import { ProductAnalyticsGate } from "./ProductAnalyticsGate";

const getSessionMock = vi.hoisted(() => vi.fn());
const posthogImported = vi.hoisted(() => vi.fn());
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

vi.mock("posthog-js", () => {
  posthogImported();
  return { default: posthogMock };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const user = { id: "user-1", email: "jane@example.com", name: "Jane", image: null };

function session(browserAnalytics: unknown) {
  return {
    session: { id: "paperclip:session:user-1", userId: "user-1" },
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

  it("imports nothing and does nothing when the session has no analytics config (self-hosted)", async () => {
    getSessionMock.mockResolvedValue(session(null));
    const root = await renderGate();
    expect(posthogImported).not.toHaveBeenCalled();
    expect(posthogMock.init).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("imports nothing when signed out", async () => {
    getSessionMock.mockResolvedValue(null);
    const root = await renderGate();
    expect(posthogImported).not.toHaveBeenCalled();
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
    expect(posthogMock.init).toHaveBeenCalledWith("phc_test", expect.objectContaining({ disable_session_recording: true }));
    expect(posthogMock.identify).toHaveBeenCalledWith("user-1", { email: "jane@example.com", name: "Jane" });
    expect(posthogMock.group).toHaveBeenCalledWith("workspace", "stack-1");
    expect(posthogMock.register).toHaveBeenCalledWith({ deployment_source: "cloud", environment: "production" });
    act(() => root.unmount());
  });
});
