// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { ConnectivityProvider, createConnectivityStore, type ConnectivityStore } from "@/lib/connectivity";
import { hashFetchKey, useResilientFetch, type ResilientFetchOptions, type ResilientFetchResult } from "./useResilientFetch";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const unavailable = () => new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" });
const forbidden = () => new ApiError("Forbidden", 403, { error: "Forbidden" });
const notFound = () => new ApiError("Browser not found", 404, { error: "Browser not found" });
const busy = () => new ApiError("Too many requests", 429, { error: "rate_limited" });

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void; signal: AbortSignal };

describe("hashFetchKey", () => {
  it("ignores object key order and distinguishes values", () => {
    expect(hashFetchKey(["a", { x: 1, y: 2 }])).toBe(hashFetchKey(["a", { y: 2, x: 1 }]));
    expect(hashFetchKey(["a", 1])).not.toBe(hashFetchKey(["a", 2]));
    expect(hashFetchKey(["a", null])).not.toBe(hashFetchKey(["a", "null"]));
  });
});

describe("useResilientFetch", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ConnectivityStore;
  let probe: ReturnType<typeof vi.fn<() => Promise<{ reachable: boolean; retryAfterMs: number | null }>>>;
  let attempts: Deferred<{ title: string }>[];
  let results: ResilientFetchResult<{ title: string }>[];
  let successes: { title: string }[];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    probe = vi.fn(async () => ({ reachable: true, retryAfterMs: null }));
    store = createConnectivityStore({ probe: probe as never, browserOnline: true });
    attempts = [];
    results = [];
    successes = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.dispose();
    vi.useRealTimers();
  });

  type HarnessProps = Partial<Omit<ResilientFetchOptions<{ title: string }>, "fetcher" | "key">> & { fetchKey?: readonly unknown[] };

  function Harness({ fetchKey = ["thing"], ...rest }: HarnessProps) {
    const result = useResilientFetch<{ title: string }>({
      key: fetchKey,
      fetcher: (signal) => {
        let resolve!: (value: { title: string }) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<{ title: string }>((nextResolve, nextReject) => {
          resolve = nextResolve;
          reject = nextReject;
        });
        attempts.push({ promise, resolve, reject, signal });
        return promise;
      },
      onSuccess: (data) => successes.push(data),
      ...rest,
    });
    results.push(result);
    return <p data-testid="data">{result.data?.title ?? ""}</p>;
  }

  function mount(props: HarnessProps = {}) {
    act(() => {
      root.render(
        <ConnectivityProvider store={store}>
          <Harness {...props} />
        </ConnectivityProvider>,
      );
    });
  }

  const last = () => results[results.length - 1]!;
  const settle = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const outage = async () => {
    probe.mockResolvedValue({ reachable: false, retryAfterMs: null });
    store.reportError(unavailable());
    await settle();
    await settle();
    expect(store.getSnapshot().status).toBe("reconnecting");
  };

  it("loads, then is ready, and reports the success once", async () => {
    mount();
    expect(last().view.kind).toBe("loading");
    expect(last().isFetching).toBe(true);
    expect(attempts).toHaveLength(1);
    act(() => attempts[0]!.resolve({ title: "Loaded" }));
    await settle();
    expect(last().view.kind).toBe("ready");
    expect(last().data).toEqual({ title: "Loaded" });
    expect(last().dataUpdatedAt).toBe(1);
    expect(successes).toEqual([{ title: "Loaded" }]);
    expect(container.textContent).toBe("Loaded");
  });

  it("keeps the last good value through a transient failure and retries with the shared policy", async () => {
    vi.useFakeTimers();
    mount();
    act(() => attempts[0]!.resolve({ title: "Loaded" }));
    await settle();
    act(() => last().refetch());
    expect(attempts).toHaveLength(2);
    act(() => attempts[1]!.reject(busy()));
    await settle();
    // Retrying: the data is still there, the attempt's failure is only a `failureReason`.
    expect(last().data).toEqual({ title: "Loaded" });
    expect(last().error).toBeNull();
    expect(last().failureReason).toBeInstanceOf(ApiError);
    expect(last().view.kind).toBe("stale");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(attempts).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(attempts).toHaveLength(3);
    act(() => attempts[2]!.resolve({ title: "Fresh" }));
    await settle();
    expect(last().view.kind).toBe("ready");
    expect(last().data).toEqual({ title: "Fresh" });
  });

  it("surfaces a transient error that keeps failing while the server is reachable, keeping the data", async () => {
    vi.useFakeTimers();
    mount({ retry: () => false });
    act(() => attempts[0]!.resolve({ title: "Loaded" }));
    await settle();
    act(() => last().refetch());
    act(() => attempts[1]!.reject(busy()));
    await settle();
    expect(last().status).toBe("error");
    expect(last().errorKind).toBe("transient");
    expect(last().data).toEqual({ title: "Loaded" });
    expect(last().view.kind).toBe("stale");
    expect(container.textContent).toBe("Loaded");
  });

  it("waits out an outage quietly on first load and recovers by itself", async () => {
    mount();
    expect(attempts).toHaveLength(1);
    await outage();
    act(() => attempts[0]!.reject(unavailable()));
    await settle();
    // Paused: nothing else would refetch until the store's probe loop recovers.
    expect(last().isPaused).toBe(true);
    expect(last().error).toBeNull();
    expect(last().view.kind).toBe("reconnecting");
    expect(attempts).toHaveLength(1);

    probe.mockResolvedValue({ reachable: true, retryAfterMs: null });
    act(() => store.probeNow());
    await settle();
    await settle();
    expect(store.getSnapshot().status).toBe("online");
    expect(attempts).toHaveLength(2);
    act(() => attempts[1]!.resolve({ title: "Recovered" }));
    await settle();
    expect(last().view.kind).toBe("ready");
    expect(last().data).toEqual({ title: "Recovered" });
  });

  it("does not start a request during an outage and keeps loaded data stale", async () => {
    mount();
    act(() => attempts[0]!.resolve({ title: "Loaded" }));
    await settle();
    await outage();
    expect(last().view.kind).toBe("stale");
    act(() => last().refetch());
    expect(attempts).toHaveLength(1);
    expect(last().isPaused).toBe(true);
    expect(last().data).toEqual({ title: "Loaded" });
  });

  it("reports a real forbidden error without retrying and drops a revocable value", async () => {
    mount({ keepDataOnError: false });
    act(() => attempts[0]!.resolve({ title: "Loaded" }));
    await settle();
    act(() => last().refetch());
    act(() => attempts[1]!.reject(forbidden()));
    await settle();
    expect(attempts).toHaveLength(2);
    expect(last().status).toBe("error");
    expect(last().errorKind).toBe("forbidden");
    expect(last().data).toBeUndefined();
    expect(last().view.kind).toBe("error");
    expect(container.textContent).toBe("");
  });

  it("keeps the value behind a real not-found error by default", async () => {
    mount();
    act(() => attempts[0]!.resolve({ title: "Loaded" }));
    await settle();
    act(() => last().refetch());
    act(() => attempts[1]!.reject(notFound()));
    await settle();
    expect(last().errorKind).toBe("not_found");
    expect(last().view.kind).toBe("error");
    expect(last().view.errorKind).toBe("not_found");
    expect(last().data).toEqual({ title: "Loaded" });
  });

  it("drops the old value at once when the key changes and ignores the old response", async () => {
    mount({ fetchKey: ["thing", "one"] });
    act(() => attempts[0]!.resolve({ title: "One" }));
    await settle();
    expect(container.textContent).toBe("One");

    const before = results.length;
    mount({ fetchKey: ["thing", "two"] });
    // Every render for the new key is empty, including the first one before any effect runs.
    expect(results.slice(before).every((result) => result.data === undefined)).toBe(true);
    expect(container.textContent).toBe("");
    expect(last().view.kind).toBe("loading");
    expect(attempts).toHaveLength(2);

    act(() => attempts[1]!.resolve({ title: "Two" }));
    await settle();
    expect(container.textContent).toBe("Two");
    expect(successes).toEqual([{ title: "One" }, { title: "Two" }]);
  });

  it("ignores a response from a superseded attempt", async () => {
    mount();
    act(() => last().refetch());
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.signal.aborted).toBe(true);
    act(() => attempts[0]!.resolve({ title: "Old" }));
    await settle();
    expect(last().data).toBeUndefined();
    expect(successes).toEqual([]);
    act(() => attempts[1]!.resolve({ title: "New" }));
    await settle();
    expect(last().data).toEqual({ title: "New" });
    expect(successes).toEqual([{ title: "New" }]);
  });

  it("stays idle while disabled, keeps its value, and fetches again when re-enabled", async () => {
    mount({ enabled: false });
    expect(attempts).toHaveLength(0);
    expect(last().view.kind).toBe("loading");
    mount({ enabled: true });
    expect(attempts).toHaveLength(1);
    act(() => attempts[0]!.resolve({ title: "Loaded" }));
    await settle();
    mount({ enabled: false });
    expect(last().data).toEqual({ title: "Loaded" });
    expect(last().isFetching).toBe(false);
    mount({ enabled: true });
    expect(attempts).toHaveLength(2);
    act(() => attempts[1]!.resolve({ title: "Again" }));
    await settle();
    expect(last().data).toEqual({ title: "Again" });
  });

  it("polls on an interval and keeps polling after a settled error", async () => {
    vi.useFakeTimers();
    mount({ refetchInterval: 15_000, retry: () => false });
    act(() => attempts[0]!.resolve({ title: "Loaded" }));
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(attempts).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(attempts).toHaveLength(2);
    act(() => attempts[1]!.reject(busy()));
    await settle();
    expect(last().view.kind).toBe("stale");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(attempts).toHaveLength(3);
    act(() => attempts[2]!.resolve({ title: "Back" }));
    await settle();
    expect(last().view.kind).toBe("ready");
    expect(last().data).toEqual({ title: "Back" });
  });

  it("stops every timer and ignores late results after unmount", async () => {
    vi.useFakeTimers();
    mount({ refetchInterval: 1_000 });
    act(() => attempts[0]!.resolve({ title: "Loaded" }));
    await settle();
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(attempts).toHaveLength(1);
    expect(successes).toEqual([{ title: "Loaded" }]);
  });
});
