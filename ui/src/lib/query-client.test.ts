import { onlineManager, QueryObserver, MutationObserver, type QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { ApiUnavailableError } from "@/api/response";
import { createConnectivityStore, type ConnectivityStore, type ProbeResult } from "./connectivity";
import {
  bindConnectivity,
  createAppQueryClient,
  reconnectDelayFor,
  retryDelayFor,
  shouldReportQueryError,
  shouldRetryRequest,
  TRANSIENT_RETRY_DELAYS_MS,
  type MutationErrorToast,
} from "./query-client";

const gatewayDown = () => new ApiError("Paperclip is restarting", 503, { error: "tenant_app_unavailable" });

describe("retry policy", () => {
  it("retries transient errors for about 30 seconds", () => {
    const error = new ApiUnavailableError(502);
    const retries = TRANSIENT_RETRY_DELAYS_MS.length;
    expect(shouldRetryRequest(retries - 1, error)).toBe(true);
    expect(shouldRetryRequest(retries, error)).toBe(false);
    const total = TRANSIENT_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    expect(total).toBeGreaterThanOrEqual(25_000);
    expect(total).toBeLessThanOrEqual(35_000);
  });

  it.each([400, 401, 403, 404, 409, 422])("never retries a %s", (status) => {
    expect(shouldRetryRequest(0, new ApiError("No", status, null))).toBe(false);
  });

  it("retries the gateway code even when it arrives with a 4xx", () => {
    expect(shouldRetryRequest(0, new ApiError("x", 404, { error: "tenant_app_unavailable" }))).toBe(true);
  });

  it("retries unexpected failures briefly and aborts never", () => {
    expect(shouldRetryRequest(0, new ApiError("boom", 500, null))).toBe(true);
    expect(shouldRetryRequest(2, new ApiError("boom", 500, null))).toBe(false);
    expect(shouldRetryRequest(0, new DOMException("Aborted", "AbortError"))).toBe(false);
  });

  it("backs off and honors Retry-After", () => {
    const error = new ApiUnavailableError(503);
    expect(retryDelayFor(0, error)).toBe(1_000);
    expect(retryDelayFor(4, error)).toBe(15_000);
    expect(retryDelayFor(9, error)).toBe(15_000);
    const throttled = new ApiError("Slow down", 429, null, { retryAfterMs: 6_000 });
    expect(retryDelayFor(0, throttled)).toBe(6_000);
    // A rate-limit window longer than the normal backoff is waited out in full.
    const minuteWindow = new ApiError("Slow down", 429, null, { retryAfterMs: 55_000 });
    expect(retryDelayFor(0, minuteWindow)).toBe(55_000);
    expect(retryDelayFor(0, new ApiUnavailableError(503, 20_000))).toBe(20_000);
    expect(reconnectDelayFor(0, throttled)).toBe(6_000);
    expect(reconnectDelayFor(3, new ApiUnavailableError(503))).toBe(10_000);
  });

  it("reports only unexpected query errors to Sentry", () => {
    expect(shouldReportQueryError(new ApiError("boom", 500, null))).toBe(true);
    expect(shouldReportQueryError(new Error("parse failure"))).toBe(true);
    expect(shouldReportQueryError(gatewayDown())).toBe(false);
    expect(shouldReportQueryError(new TypeError("Failed to fetch"))).toBe(false);
    expect(shouldReportQueryError(new ApiError("Not found", 404, null))).toBe(false);
  });
});

describe("createAppQueryClient", () => {
  let store: ConnectivityStore;
  let probe: ReturnType<typeof vi.fn<() => Promise<ProbeResult>>>;
  let client: QueryClient;
  let unbind: () => void;
  let notifyMutationError: ReturnType<typeof vi.fn<(toast: MutationErrorToast) => void>>;
  let reportError: ReturnType<typeof vi.fn<(error: unknown) => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    probe = vi.fn<() => Promise<ProbeResult>>().mockResolvedValue({ reachable: false, retryAfterMs: null });
    store = createConnectivityStore({ probe, browserOnline: true });
    notifyMutationError = vi.fn<(toast: MutationErrorToast) => void>();
    reportError = vi.fn<(error: unknown) => void>();
    client = createAppQueryClient({ connectivity: store, notifyMutationError, reportError });
    client.mount();
    unbind = bindConnectivity(client, store);
  });

  afterEach(() => {
    unbind();
    store.dispose();
    client.unmount();
    client.clear();
    onlineManager.setOnline(true);
    vi.useRealTimers();
  });

  it("pauses a failing query during an outage and refreshes it on recovery", async () => {
    let down = true;
    const queryFn = vi.fn(async () => {
      if (down) throw gatewayDown();
      return "fresh";
    });
    const observer = new QueryObserver(client, { queryKey: ["issue", "1"], queryFn });
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().status).toBe("reconnecting");
    expect(onlineManager.isOnline()).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    // Paused, not failed, and not hammering the server.
    expect(observer.getCurrentResult()).toMatchObject({ status: "pending", fetchStatus: "paused" });
    expect(queryFn).toHaveBeenCalledTimes(1);

    down = false;
    probe.mockResolvedValue({ reachable: true });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.getSnapshot().status).toBe("online");
    expect(observer.getCurrentResult()).toMatchObject({ status: "success", data: "fresh" });
    unsubscribe();
  });

  it("keeps cached data when a background refetch hits an outage", async () => {
    let down = false;
    const observer = new QueryObserver(client, {
      queryKey: ["issue", "2"],
      queryFn: async () => {
        if (down) throw gatewayDown();
        return "loaded";
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    down = true;
    void observer.refetch();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(observer.getCurrentResult()).toMatchObject({ data: "loaded", error: null });
    unsubscribe();
  });

  it("refreshes active queries once on recovery", async () => {
    const queryFn = vi.fn(async () => "ok");
    const observer = new QueryObserver(client, { queryKey: ["list"], queryFn, staleTime: Infinity });
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(queryFn).toHaveBeenCalledTimes(1);
    store.reportError(gatewayDown());
    await vi.advanceTimersByTimeAsync(0);
    probe.mockResolvedValue({ reachable: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queryFn).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("does not treat setQueryData as proof the server is back", async () => {
    store.reportError(gatewayDown());
    await vi.advanceTimersByTimeAsync(0);
    client.setQueryData(["optimistic"], "local");
    expect(store.getSnapshot().status).toBe("reconnecting");
  });

  it("fails an ordinary mutation fast during an outage", async () => {
    const mutationFn = vi.fn(async () => {
      throw gatewayDown();
    });
    const observer = new MutationObserver(client, { mutationFn });
    await expect(observer.mutate()).rejects.toBeInstanceOf(ApiError);
    expect(mutationFn).toHaveBeenCalledTimes(1);
  });

  it("pauses an idempotent mutation across an outage and resends it on reconnect", async () => {
    let down = true;
    const mutationFn = vi.fn(async (value: string) => {
      if (down) throw gatewayDown();
      return value;
    });
    const observer = new MutationObserver(client, { mutationFn, meta: { replay: "idempotent" } });
    const result = observer.mutate("title");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(observer.getCurrentResult()).toMatchObject({ status: "pending", isPaused: true });
    expect(mutationFn).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().pendingWrites).toBe(1);

    down = false;
    probe.mockResolvedValue({ reachable: true });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toBe("title");
    expect(mutationFn).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().pendingWrites).toBe(0);
  });

  it("toasts readable copy for a failed opted-in mutation without its own handler", async () => {
    const observer = new MutationObserver(client, {
      mutationFn: async () => {
        throw new ApiError("Title is required", 422, { error: "Title is required" });
      },
      meta: { errorToast: true },
    });
    await observer.mutate().catch(() => undefined);
    expect(notifyMutationError).toHaveBeenCalledWith({ title: "Check your input", body: "Title is required" });
  });

  it("toasts a transient failure the banner does not cover", async () => {
    const observer = new MutationObserver(client, {
      mutationFn: async () => {
        throw new ApiError("Slow down", 429, null);
      },
      meta: { errorToast: true },
    });
    await observer.mutate().catch(() => undefined);
    expect(notifyMutationError).toHaveBeenCalledWith({
      title: "Connection interrupted",
      body: "Paperclip is temporarily unavailable. Please try again in a moment.",
    });
  });

  it("does not toast covered transient failures, handled mutations, or mutations that did not opt in", async () => {
    const fail = (error: unknown) => async () => {
      throw error;
    };
    store.reportError(gatewayDown());
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().status).toBe("reconnecting");
    await new MutationObserver(client, {
      mutationFn: fail(gatewayDown()),
      meta: { errorToast: true },
    }).mutate().catch(() => undefined);
    await new MutationObserver(client, {
      mutationFn: fail(new ApiError("No", 403, null)),
      onError: () => undefined,
      meta: { errorToast: true },
    }).mutate().catch(() => undefined);
    // Surfaces that render `mutation.error` inline must not get a second copy.
    await new MutationObserver(client, {
      mutationFn: fail(new ApiError("No", 403, null)),
    }).mutate().catch(() => undefined);
    expect(notifyMutationError).not.toHaveBeenCalled();
  });

  it("reports an unexpected query error to Sentry once per query", async () => {
    const queryFn = vi.fn(async () => {
      throw new ApiError("boom", 500, { error: "boom" });
    });
    const observer = new QueryObserver(client, { queryKey: ["broken"], queryFn, retry: false });
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await observer.refetch();
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
