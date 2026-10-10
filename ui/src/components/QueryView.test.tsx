// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { ConnectivityProvider, createConnectivityStore, type ConnectivityStore } from "@/lib/connectivity";
import { QueryErrorState, QueryView, queryViewKind, useQueryView, type QueryViewState } from "./QueryView";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const unavailable = () => new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" });
const notFound = () => new ApiError("Issue not found", 404, { error: "Issue not found" });
const forbidden = () => new ApiError("Forbidden", 403, { error: "Forbidden" });

describe("queryViewKind", () => {
  const base = { data: undefined, error: null, status: "pending" as const, fetchStatus: "fetching" as const };

  it("loads, then is ready", () => {
    expect(queryViewKind(base)).toBe("loading");
    expect(queryViewKind({ ...base, data: 1, status: "success", fetchStatus: "idle" })).toBe("ready");
    expect(queryViewKind({ ...base, data: 1, status: "success", fetchStatus: "fetching" })).toBe("ready");
  });

  it("keeps data through a transient failure (stale) and shows an error only for real failures", () => {
    expect(queryViewKind({ ...base, data: 1, status: "error", error: unavailable() })).toBe("stale");
    expect(queryViewKind({ ...base, data: 1, status: "error", error: notFound() })).toBe("error");
    expect(queryViewKind({ ...base, data: 1, status: "error", error: forbidden() })).toBe("error");
  });

  it("reconnects quietly when nothing has loaded yet", () => {
    expect(queryViewKind({ ...base, status: "error", error: unavailable() })).toBe("reconnecting");
    expect(queryViewKind({ ...base, status: "error", error: new TypeError("Failed to fetch") })).toBe("reconnecting");
    expect(queryViewKind({ ...base, status: "error", error: notFound() })).toBe("error");
    expect(queryViewKind({ ...base, status: "error", error: new Error("boom") })).toBe("error");
  });

  it("shows retryable copy for a route-level blip with no data, but keeps data through it", () => {
    const busy = new ApiError("Too many requests", 429, { error: "rate_limited" });
    const worker = new ApiError("WORKER_UNAVAILABLE", 503, { code: "WORKER_UNAVAILABLE", message: "restarting" });
    expect(queryViewKind({ ...base, status: "error", error: busy })).toBe("error");
    expect(queryViewKind({ ...base, status: "error", error: worker })).toBe("error");
    expect(queryViewKind({ ...base, status: "error", error: busy }, "reconnecting")).toBe("reconnecting");
    expect(queryViewKind({ ...base, data: 1, status: "error", error: busy })).toBe("stale");
    expect(queryViewKind({ ...base, data: 1, status: "error", error: worker })).toBe("stale");
  });

  it("treats a paused fetch and in-flight transient retries as an outage", () => {
    expect(queryViewKind({ ...base, fetchStatus: "paused" })).toBe("reconnecting");
    expect(queryViewKind({ ...base, failureReason: unavailable() })).toBe("reconnecting");
    expect(queryViewKind({ ...base, data: 1, status: "success", fetchStatus: "paused" })).toBe("stale");
    expect(queryViewKind({ ...base, data: 1, status: "success", failureReason: unavailable() })).toBe("stale");
  });

  it("follows the app-wide connectivity state", () => {
    expect(queryViewKind({ ...base, data: 1, status: "success", fetchStatus: "fetching" }, "reconnecting")).toBe("stale");
    expect(queryViewKind({ ...base, data: 1, status: "success", fetchStatus: "idle" }, "reconnecting")).toBe("stale");
    expect(queryViewKind(base, "offline")).toBe("reconnecting");
    // A disabled query is not waiting on the network.
    expect(queryViewKind({ ...base, fetchStatus: "idle" }, "reconnecting")).toBe("loading");
  });

  it("does not treat null data as missing", () => {
    expect(queryViewKind({ ...base, data: null, status: "success", fetchStatus: "idle" })).toBe("ready");
    expect(queryViewKind({ ...base, data: null, status: "error", error: unavailable() })).toBe("stale");
  });
});

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("useQueryView and <QueryView>", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let store: ConnectivityStore;
  let probe: ReturnType<typeof vi.fn<() => Promise<{ reachable: true }>>>;
  let attempts: Deferred<{ title: string }>[];
  let fetchCount: number;
  let views: QueryViewState<{ title: string }>[];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, networkMode: "always" } } });
    probe = vi.fn(async () => ({ reachable: true as const }));
    store = createConnectivityStore({ probe, browserOnline: true });
    attempts = [];
    fetchCount = 0;
    views = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    client.clear();
    store.dispose();
  });

  function Harness({ staleHint = false, notFound }: { staleHint?: boolean; notFound?: React.ReactNode }) {
    const query = useQuery({
      queryKey: ["thing"],
      queryFn: () => {
        const attempt = deferred<{ title: string }>();
        attempts.push(attempt);
        fetchCount += 1;
        return attempt.promise;
      },
    });
    views.push(useQueryView(query));
    return (
      <QueryView query={query} action="load the thing" staleHint={staleHint} notFound={notFound}>
        {(data) => <p data-testid="data">{data.title}</p>}
      </QueryView>
    );
  }

  function mount(props: { staleHint?: boolean; notFound?: React.ReactNode } = {}) {
    act(() => {
      root.render(
        <ConnectivityProvider store={store}>
          <QueryClientProvider client={client}>
            <Harness {...props} />
          </QueryClientProvider>
        </ConnectivityProvider>,
      );
    });
  }

  const last = () => views[views.length - 1]!;
  // React Query batches observer notifications on a timer, so flush macrotasks.
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  it("shows a placeholder, then the data", async () => {
    mount();
    expect(last().kind).toBe("loading");
    expect(container.querySelector('[data-query-view="placeholder"]')).not.toBeNull();
    attempts[0]!.resolve({ title: "Loaded" });
    await settle();
    expect(last().kind).toBe("ready");
    expect(container.querySelector('[data-testid="data"]')?.textContent).toBe("Loaded");
  });

  it("keeps loaded data on screen when a refetch fails with a transient error", async () => {
    mount({ staleHint: true });
    attempts[0]!.resolve({ title: "Loaded" });
    await settle();
    await act(async () => {
      void client.refetchQueries({ queryKey: ["thing"] });
    });
    attempts[1]!.reject(unavailable());
    await settle();
    expect(last().kind).toBe("stale");
    expect(last().data).toEqual({ title: "Loaded" });
    expect(container.querySelector('[data-testid="data"]')?.textContent).toBe("Loaded");
    expect(container.querySelector('[data-query-view="stale"]')).not.toBeNull();
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
    expect(container.querySelector(".text-destructive")).toBeNull();
  });

  it("shows a quiet placeholder when the first load fails with a transient error", async () => {
    mount();
    attempts[0]!.reject(unavailable());
    await settle();
    expect(last().kind).toBe("reconnecting");
    expect(container.querySelector('[data-query-view="placeholder"]')).not.toBeNull();
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
    expect(container.textContent).not.toContain("tenant_app_unavailable");
  });

  it("shows readable copy and retries for a real error", async () => {
    mount();
    attempts[0]!.reject(new ApiError("Request failed: 500", 500, { error: "internal_error" }));
    await settle();
    expect(last().kind).toBe("error");
    expect(last().errorKind).toBe("unknown");
    const alert = container.querySelector('[data-query-view="error"]');
    expect(alert?.textContent).toContain("Couldn't load the thing");
    expect(alert?.textContent).not.toContain("internal_error");
    const retry = alert?.querySelector("button");
    expect(retry?.textContent).toContain("Retry");
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(fetchCount).toBe(2);
    attempts[1]!.resolve({ title: "Recovered" });
    await settle();
    expect(last().kind).toBe("ready");
    expect(container.querySelector('[data-testid="data"]')?.textContent).toBe("Recovered");
  });

  it("renders not_found only for a real 404", async () => {
    mount({ notFound: <p data-testid="missing">Gone</p> });
    attempts[0]!.reject(notFound());
    await settle();
    expect(last().errorKind).toBe("not_found");
    expect(container.querySelector('[data-testid="missing"]')?.textContent).toBe("Gone");
  });

  it("retry probes the server during an outage", async () => {
    mount();
    attempts[0]!.reject(unavailable());
    await settle();
    // The failed query made the store suspect an outage and probe; make the probe fail so the store is reconnecting.
    probe.mockResolvedValueOnce({ reachable: false, retryAfterMs: null } as unknown as { reachable: true });
    await settle();
    store.reportError(unavailable());
    await settle();
    probe.mockClear();
    act(() => last().retry());
    expect(fetchCount).toBe(2);
    if (store.getSnapshot().status !== "online") expect(probe).toHaveBeenCalled();
  });
});

describe("<QueryErrorState>", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("uses readable copy and leaves out Retry for errors a retry cannot fix", () => {
    act(() => {
      root.render(<QueryErrorState error={forbidden()} onRetry={() => undefined} size="inline" />);
    });
    expect(container.textContent).toContain("Forbidden");
    expect(container.querySelector("button")).toBeNull();

    act(() => {
      root.render(<QueryErrorState error={new ApiError("access_denied", 403, { error: "access_denied" })} onRetry={() => undefined} />);
    });
    expect(container.textContent).not.toContain("access_denied");
    expect(container.textContent).toContain("permission");
    expect(container.querySelector("button")).toBeNull();

    act(() => {
      root.render(<QueryErrorState error={new ApiError("x", 409, { error: "stale_revision" })} onRetry={() => undefined} size="page" />);
    });
    expect(container.textContent).not.toContain("stale_revision");
    expect(container.querySelector("button")?.textContent).toContain("Retry");
  });
});
