// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginRouteSuspense,
  getActivitySnapshot,
  notifyRouteChange,
  recordUserInteraction,
  shouldTrackFetchRequest,
  startGlobalActivityTracker,
} from "./activity-loader";

describe("shouldTrackFetchRequest", () => {
  const origin = "http://localhost:3100";

  it("always tracks interactive non-GET mutations on same origin", () => {
    expect(
      shouldTrackFetchRequest("/api/issues", { method: "POST" }, {
        origin,
        now: 10_000,
        lastInteractionAt: 0,
        navigationWindowUntil: 0,
      }),
    ).toBe(true);
    expect(
      shouldTrackFetchRequest("/api/agents/123", { method: "PATCH" }, {
        origin,
        now: 10_000,
        lastInteractionAt: 0,
        navigationWindowUntil: 0,
      }),
    ).toBe(true);
  });

  it("ignores silent background GET polling when idle and ignores silent endpoints", () => {
    expect(
      shouldTrackFetchRequest("/api/companies/c1/issues", undefined, {
        origin,
        now: 10_000,
        lastInteractionAt: 2_000,
        navigationWindowUntil: 0,
      }),
    ).toBe(false);
    expect(
      shouldTrackFetchRequest("/api/health", undefined, {
        origin,
        now: 10_000,
        lastInteractionAt: 9_950,
        navigationWindowUntil: 11_000,
      }),
    ).toBe(false);
    expect(
      shouldTrackFetchRequest("/api/issues/issue-1/active-run", undefined, {
        origin,
        now: 10_000,
        lastInteractionAt: 9_950,
        navigationWindowUntil: 11_000,
      }),
    ).toBe(false);
    expect(
      shouldTrackFetchRequest(
        "/api/companies/c1/issues",
        { headers: { "X-Paperclip-Background": "true" } },
        {
          origin,
          now: 10_000,
          lastInteractionAt: 9_950,
          navigationWindowUntil: 11_000,
        },
      ),
    ).toBe(false);
    expect(
      shouldTrackFetchRequest("https://external.example.com/data", { method: "POST" }, {
        origin,
        now: 10_000,
        lastInteractionAt: 9_950,
        navigationWindowUntil: 0,
      }),
    ).toBe(false);
  });

  it("tracks GET requests triggered shortly after a user interaction or navigation", () => {
    expect(
      shouldTrackFetchRequest("/api/companies/c1/issues", undefined, {
        origin,
        now: 10_000,
        lastInteractionAt: 9_400,
        navigationWindowUntil: 0,
      }),
    ).toBe(true);
    expect(
      shouldTrackFetchRequest("/api/companies/c1/projects", undefined, {
        origin,
        now: 10_000,
        lastInteractionAt: 0,
        navigationWindowUntil: 10_500,
      }),
    ).toBe(true);
  });
});

describe("startGlobalActivityTracker", () => {
  let cleanup: (() => void) | null = null;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = window.fetch;
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    window.fetch = originalFetch;
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("marks a clicked button as busy during an initiated fetch and clears it cleanly", async () => {
    vi.useFakeTimers();
    let resolveFetch!: (value: Response) => void;
    const mockFetch = vi.fn(
      () => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    window.fetch = mockFetch as unknown as typeof fetch;

    cleanup = startGlobalActivityTracker(window);

    const btn = document.createElement("button");
    btn.textContent = "Save";
    document.body.appendChild(btn);

    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(btn.getAttribute("data-paperclip-clicked")).toBe("true");

    const promise = window.fetch("/api/projects", { method: "POST", body: "{}" });
    expect(getActivitySnapshot().isLoading).toBe(true);
    expect(btn.getAttribute("data-paperclip-busy")).toBe("true");

    resolveFetch(new Response("{}", { status: 200 }));
    await promise;
    await Promise.resolve();

    expect(getActivitySnapshot().isLoading).toBe(false);
    vi.advanceTimersByTime(300);
    expect(btn.getAttribute("data-paperclip-busy")).toBeNull();
  });

  it("tracks route suspense boundaries and navigation windows cleanly", () => {
    notifyRouteChange(500);
    const endSuspense = beginRouteSuspense();
    expect(getActivitySnapshot().isLoading).toBe(true);
    expect(getActivitySnapshot().activeNavigations).toBe(1);
    endSuspense();
    expect(getActivitySnapshot().activeNavigations).toBe(0);
    expect(getActivitySnapshot().isLoading).toBe(false);
    recordUserInteraction(null);
  });
});
