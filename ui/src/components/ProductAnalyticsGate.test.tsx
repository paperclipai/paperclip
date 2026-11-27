// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProductAnalyticsForTest } from "@/lib/analytics/product-analytics";
import {
  ANALYTICS_CONSENT_STORAGE_KEY,
  resetAnalyticsConsentForTest,
  storeAnalyticsChoice,
} from "@/lib/analytics/consent";
import { queryKeys } from "@/lib/queryKeys";
import { ProductAnalyticsGate } from "./ProductAnalyticsGate";

const getSessionMock = vi.hoisted(() => vi.fn());
const posthogMock = vi.hoisted(() => ({
  init: vi.fn(),
  register: vi.fn(),
  identify: vi.fn(),
  group: vi.fn(),
  reset: vi.fn(),
  opt_out_capturing: vi.fn(),
  opt_in_capturing: vi.fn(),
  has_opted_out_capturing: vi.fn(() => false),
  startSessionRecording: vi.fn(),
  stopSessionRecording: vi.fn(),
}));

vi.mock("@/api/auth", () => ({
  authApi: { getSession: () => getSessionMock() },
}));

const scriptDownload: { hold: boolean; pending: Array<() => void> } = { hold: false, pending: [] };

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
    const finish = () => node.onload?.(new Event("load"));
    if (scriptDownload.hold) scriptDownload.pending.push(finish);
    else queueMicrotask(finish);
  }
  return result;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ACTOR_ID = "paperclip-id:uf2X8Ha4H9hNdAMnc1rOy91VIRos5pch";
const user = { id: ACTOR_ID, email: "jane@example.com", name: "Jane", image: null };

function analyticsConfig(overrides: Record<string, unknown> = {}) {
  return {
    token: "phc_test",
    apiHost: "/_ph",
    uiHost: null,
    environment: "production",
    stackId: "stack-1",
    replayEnabled: false,
    ...overrides,
  };
}

function banner() {
  return document.querySelector<HTMLElement>('section[aria-label="Analytics choice"]');
}

function bannerButton(name: string) {
  return [...(banner()?.querySelectorAll("button") ?? [])].find((button) => button.textContent === name)!;
}

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
    resetAnalyticsConsentForTest();
    window.localStorage.clear();
    scriptDownload.hold = false;
    scriptDownload.pending = [];
    Object.defineProperty(navigator, "globalPrivacyControl", { value: undefined, configurable: true });
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
    getSessionMock.mockResolvedValue(session(analyticsConfig({ consentRequired: false })));
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

  it("asks first and loads nothing for a visitor who must consent", async () => {
    getSessionMock.mockResolvedValue(session(analyticsConfig({ consentRequired: true })));
    const root = await renderGate();
    expect(banner()).not.toBeNull();
    expect(banner()?.textContent).toContain("Paperclip uses analytics to improve the product.");
    expect(banner()?.querySelector("a")?.getAttribute("href")).toBe("https://paperclip.ing/privacy/");
    expect(injectedScripts()).toHaveLength(0);
    expect(posthogMock.init).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("loads analytics at once when the visitor accepts, and remembers the choice", async () => {
    getSessionMock.mockResolvedValue(session(analyticsConfig({ consentRequired: true, replayEnabled: true })));
    const root = await renderGate();
    await act(async () => {
      bannerButton("Accept").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.localStorage.getItem(ANALYTICS_CONSENT_STORAGE_KEY)).toBe("granted");
    expect(banner()).toBeNull();
    expect(injectedScripts()).toHaveLength(1);
    expect(posthogMock.init).toHaveBeenCalledWith("phc_test", expect.objectContaining({ disable_session_recording: false }));
    act(() => root.unmount());
  });

  it("keeps analytics off when the visitor declines", async () => {
    getSessionMock.mockResolvedValue(session(analyticsConfig({ consentRequired: true })));
    const root = await renderGate();
    await act(async () => {
      bannerButton("Decline").click();
    });
    await settle();
    expect(window.localStorage.getItem(ANALYTICS_CONSENT_STORAGE_KEY)).toBe("denied");
    expect(banner()).toBeNull();
    expect(injectedScripts()).toHaveLength(0);
    act(() => root.unmount());
  });

  it("treats Global Privacy Control as a decline for a visitor who must consent", async () => {
    Object.defineProperty(navigator, "globalPrivacyControl", { value: true, configurable: true });
    getSessionMock.mockResolvedValue(session(analyticsConfig({ consentRequired: true })));
    const root = await renderGate();
    expect(banner()).toBeNull();
    expect(injectedScripts()).toHaveLength(0);
    act(() => root.unmount());
  });

  it("keeps a stored decline across page loads", async () => {
    window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, "denied");
    getSessionMock.mockResolvedValue(session(analyticsConfig({ consentRequired: false })));
    const root = await renderGate();
    expect(banner()).toBeNull();
    expect(injectedScripts()).toHaveLength(0);
    act(() => root.unmount());
  });

  it("opts out and stops recording now when the choice changes to off, and opts back in", async () => {
    getSessionMock.mockResolvedValue(session(analyticsConfig({ consentRequired: false, replayEnabled: true })));
    const root = await renderGate();
    expect(posthogMock.init).toHaveBeenCalledTimes(1);
    act(() => storeAnalyticsChoice("denied"));
    expect(posthogMock.opt_out_capturing).toHaveBeenCalledTimes(1);
    expect(posthogMock.stopSessionRecording).toHaveBeenCalledTimes(1);
    act(() => storeAnalyticsChoice("granted"));
    expect(posthogMock.opt_in_capturing).toHaveBeenCalledTimes(1);
    expect(posthogMock.startSessionRecording).toHaveBeenCalledTimes(1);
    expect(posthogMock.init).toHaveBeenCalledTimes(1);
    expect(injectedScripts()).toHaveLength(1);
    act(() => root.unmount());
  });

  it("clears an earlier PostHog opt-out when the stored choice is on", async () => {
    posthogMock.has_opted_out_capturing.mockReturnValueOnce(true);
    window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, "granted");
    getSessionMock.mockResolvedValue(session(analyticsConfig({ consentRequired: true })));
    const root = await renderGate();
    expect(posthogMock.opt_in_capturing).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("never initializes PostHog when the visitor turns analytics off while its script is downloading", async () => {
    scriptDownload.hold = true;
    getSessionMock.mockResolvedValue(session(analyticsConfig({ consentRequired: false, replayEnabled: true })));
    const root = await renderGate();
    expect(injectedScripts()).toHaveLength(1);
    act(() => storeAnalyticsChoice("denied"));
    await act(async () => {
      for (const finish of scriptDownload.pending.splice(0)) finish();
      await Promise.resolve();
    });
    expect(posthogMock.init).not.toHaveBeenCalled();
    act(() => storeAnalyticsChoice("granted"));
    expect(posthogMock.init).toHaveBeenCalledTimes(1);
    expect(injectedScripts()).toHaveLength(1);
    act(() => root.unmount());
  });

  it("stops analytics when another tab clears the choice and the visitor must be asked again", async () => {
    window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, "granted");
    getSessionMock.mockResolvedValue(session(analyticsConfig({ consentRequired: true, replayEnabled: true })));
    const root = await renderGate();
    expect(posthogMock.init).toHaveBeenCalledTimes(1);
    act(() => {
      window.localStorage.removeItem(ANALYTICS_CONSENT_STORAGE_KEY);
      window.dispatchEvent(new StorageEvent("storage", { key: ANALYTICS_CONSENT_STORAGE_KEY }));
    });
    expect(banner()).not.toBeNull();
    expect(posthogMock.opt_out_capturing).toHaveBeenCalledTimes(1);
    expect(posthogMock.stopSessionRecording).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("stops analytics when a session refresh says the visitor must consent", async () => {
    getSessionMock.mockResolvedValue(session(analyticsConfig({ consentRequired: false })));
    const root = await renderGate();
    expect(posthogMock.init).toHaveBeenCalledTimes(1);
    await act(async () => {
      queryClient.setQueryData(queryKeys.auth.session, session(analyticsConfig({ consentRequired: true })));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(banner()).not.toBeNull();
    expect(posthogMock.opt_out_capturing).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
