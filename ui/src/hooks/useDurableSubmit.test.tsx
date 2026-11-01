// @vitest-environment jsdom

import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { PendingSendNotice } from "@/components/PendingSendNotice";
import { CommentSubmissionUnknownError } from "@/lib/comment-submit-result";
import {
  ConnectivityProvider,
  createConnectivityStore,
  type ConnectivityStore,
  type ProbeResult,
} from "@/lib/connectivity";
import { MAX_ONLINE_RESENDS, pendingSendKeyFor, readPendingSend, writePendingSend } from "@/lib/pending-send";
import { queryKeys } from "@/lib/queryKeys";
import { DETACHED_DRAFT_OWNER } from "./useDraftOwner";
import { useAutoResend, useDurableSubmit, type AutoResendState, type DurableSubmit, type DurableSubmitOptions } from "./useDurableSubmit";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The session lookup never answers on its own; tests set the account directly.
vi.mock("@/api/auth", () => ({
  authApi: { getSession: () => new Promise(() => {}) },
}));

type Payload = { body: string };
const isPayload = (value: unknown): value is Payload =>
  !!value && typeof value === "object" && typeof (value as Payload).body === "string";

const KEY = "test:pending-send";
/** Mounted without a QueryClientProvider, records belong to the detached owner. */
const STORED_KEY = pendingSendKeyFor(KEY, DETACHED_DRAFT_OWNER);
const outage = () => new ApiError("Paperclip is restarting", 503, { error: "tenant_app_unavailable" });

/**
 * A server that dedupes by idempotency key, like `clientRequestId` on comments:
 * a repeated key returns the first result instead of creating another row.
 */
function createDedupingServer() {
  const rows = new Map<string, { id: string; body: string }>();
  return {
    rows,
    post(payload: Payload, key: string) {
      const existing = rows.get(key);
      if (existing) return existing;
      const row = { id: `row-${rows.size + 1}`, body: payload.body };
      rows.set(key, row);
      return row;
    },
  };
}

describe("useDurableSubmit", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ConnectivityStore;
  let probe: ReturnType<typeof vi.fn<() => Promise<ProbeResult>>>;
  let current: DurableSubmit<Payload, { id: string; body: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    probe = vi.fn<() => Promise<ProbeResult>>().mockResolvedValue({ reachable: false, retryAfterMs: null });
    store = createConnectivityStore({ probe, browserOnline: true });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.dispose();
    vi.useRealTimers();
  });

  function Harness(props: DurableSubmitOptions<Payload, { id: string; body: string }>) {
    current = useDurableSubmit(props);
    return current.pending ? <PendingSendNotice persisted={current.persisted} resending={current.resending}
      stalled={current.status === "stalled"} onResendNow={current.resendNow} onCancel={current.cancel} /> : null;
  }

  function render(options: Partial<DurableSubmitOptions<Payload, { id: string; body: string }>> & Pick<DurableSubmitOptions<Payload, { id: string; body: string }>, "send">) {
    const wrap = (children: ReactNode) => <ConnectivityProvider store={store}>{children}</ConnectivityProvider>;
    act(() => {
      root.render(wrap(<Harness sourceId="test" storageKey={KEY} isPayload={isPayload} {...options} />));
    });
  }

  const flush = () => act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const advance = (ms: number) => act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

  it("reports memory-only retention when browser storage rejects the request", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
    render({ send: vi.fn().mockRejectedValue(outage()) });
    await act(async () => { await current.submit({ body: "Keep this text" }); });
    expect(current.pending?.payload.body).toBe("Keep this text");
    expect(current.persisted).toBe(false);
    expect(container.textContent).toContain("Browser storage is unavailable");
    expect(container.textContent).not.toContain("saved on this device");
    expect(readPendingSend(STORED_KEY, isPayload)).toBeNull();
    storage.mockRestore();
  });
  it("persists the payload and key before the request and clears them after a receipt", async () => {
    const server = createDedupingServer();
    let storedDuringRequest: unknown = null;
    const send = vi.fn(async (payload: Payload, key: string) => {
      storedDuringRequest = readPendingSend(STORED_KEY, isPayload);
      return server.post(payload, key);
    });
    render({ send });

    let result: Awaited<ReturnType<typeof current.submit>> | undefined;
    await act(async () => {
      result = await current.submit({ body: "Hello" });
    });

    expect(storedDuringRequest).toMatchObject({ payload: { body: "Hello" }, idempotencyKey: send.mock.calls[0]![1] });
    expect(result).toMatchObject({ kind: "sent", result: { body: "Hello" } });
    expect(readPendingSend(STORED_KEY, isPayload)).toBeNull();
    expect(current.status).toBe("idle");
  });

  it("resends with the same key after an outage and the server keeps exactly one row", async () => {
    const server = createDedupingServer();
    // The first request commits on the server, then the response is lost.
    const send = vi.fn(async (payload: Payload, key: string) => {
      const row = server.post(payload, key);
      if (send.mock.calls.length === 1) throw new CommentSubmissionUnknownError();
      return row;
    });
    render({ send });

    let first: Awaited<ReturnType<typeof current.submit>> | undefined;
    await act(async () => {
      first = await current.submit({ body: "Typed during the outage" });
    });
    expect(first?.kind).toBe("pending");
    expect(current.status).toBe("waiting");
    expect(store.getSnapshot().pendingWrites).toBe(1);
    expect(readPendingSend(STORED_KEY, isPayload)?.payload.body).toBe("Typed during the outage");

    // The connection drops before the scheduled resend: nothing is sent.
    store.reportError(outage());
    await flush();
    expect(store.getSnapshot().status).toBe("reconnecting");
    await advance(60_000);
    expect(send).toHaveBeenCalledTimes(1);

    // Recovery resends right away with the original key.
    probe.mockResolvedValue({ reachable: true });
    await act(async () => {
      store.probeNow();
      await vi.advanceTimersByTimeAsync(0);
    });
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1]).toBe(send.mock.calls[0]![1]);
    expect(server.rows.size).toBe(1);
    expect(current.status).toBe("idle");
    expect(current.pending).toBeNull();
    expect(readPendingSend(STORED_KEY, isPayload)).toBeNull();
    expect(store.getSnapshot().pendingWrites).toBe(0);
  });

  it("resends with backoff while the app stays online", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(outage())
      .mockRejectedValueOnce(outage())
      .mockResolvedValue({ id: "row-1", body: "Retry me" });
    render({ send });
    await act(async () => {
      await current.submit({ body: "Retry me" });
    });
    expect(send).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(send).toHaveBeenCalledTimes(2);
    await advance(2_000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(new Set(send.mock.calls.map((call) => call[1])).size).toBe(1);
    expect(current.status).toBe("idle");
  });

  it("puts a definitive rejection back with readable copy and never resends it", async () => {
    const onRejected = vi.fn();
    const send = vi.fn().mockRejectedValue(new ApiError("Forbidden", 403, { error: "Forbidden" }));
    render({ send, onRejected, action: "post the comment" });
    let result: Awaited<ReturnType<typeof current.submit>> | undefined;
    await act(async () => {
      result = await current.submit({ body: "Not allowed" });
    });
    expect(result?.kind).toBe("rejected");
    expect(current.error).toEqual({ title: "Couldn't post the comment", body: "Forbidden", retryable: false });
    expect(onRejected).toHaveBeenCalledWith(expect.any(ApiError), current.error, expect.objectContaining({ payload: { body: "Not allowed" } }));
    expect(readPendingSend(STORED_KEY, isPayload)).toBeNull();
    await advance(60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("restores a pending send after a reload and resends it with its stored key", async () => {
    writePendingSend(STORED_KEY, { idempotencyKey: "stored-key-123", payload: { body: "From before reload" }, createdAt: 1 });
    const send = vi.fn().mockResolvedValue({ id: "row-1", body: "From before reload" });
    render({ send });
    expect(current.status).toBe("waiting");
    await advance(1_000);
    expect(send).toHaveBeenCalledWith({ body: "From before reload" }, "stored-key-123");
    expect(current.status).toBe("idle");
  });

  it("neither restores nor resends another account's pending send", async () => {
    writePendingSend(pendingSendKeyFor(KEY, "user-2"), { idempotencyKey: "other-account-key", payload: { body: "Not mine" }, createdAt: 1 });
    const send = vi.fn().mockResolvedValue({ id: "row-1", body: "Not mine" });
    render({ send });
    expect(current.pending).toBeNull();
    await advance(5_000);
    expect(send).not.toHaveBeenCalled();
    expect(readPendingSend(pendingSendKeyFor(KEY, "user-2"), isPayload)?.idempotencyKey).toBe("other-account-key");
  });

  it.each([
    ["a receipt", () => ({ id: "row-1", body: "Before the session" })],
    ["a rejection", () => { throw new ApiError("Title is required", 422, { error: "validation_error" }); }],
  ])("clears a send that moved into the account's storage before %s", async (_label, settle) => {
    const userKey = pendingSendKeyFor(KEY, "user-1");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let finish!: () => void;
    const send = vi.fn((_payload: Payload, _key: string) => new Promise<{ id: string; body: string }>((resolve, reject) => {
      finish = () => {
        try {
          resolve(settle());
        } catch (error) {
          reject(error);
        }
      };
    }));
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <ConnectivityProvider store={store}>
            <Harness sourceId="test" storageKey={KEY} isPayload={isPayload} send={send} />
          </ConnectivityProvider>
        </QueryClientProvider>,
      );
    });

    // The session is still loading: the send is kept in memory only.
    let submitted!: Promise<unknown>;
    act(() => {
      submitted = current.submit({ body: "Before the session" });
    });
    expect(readPendingSend(userKey, isPayload)).toBeNull();

    // The account becomes known mid-request, so the record moves into its key.
    act(() => {
      client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
    });
    await flush();
    expect(readPendingSend(userKey, isPayload)?.idempotencyKey).toBe(send.mock.calls[0]![1]);

    await act(async () => {
      finish();
      await submitted;
    });
    expect(readPendingSend(userKey, isPayload)).toBeNull();
    expect(current.pending).toBeNull();
    client.clear();
  });

  it("cancel stops resending and returns the payload", async () => {
    const send = vi.fn().mockRejectedValue(outage());
    render({ send });
    await act(async () => {
      await current.submit({ body: "Keep my text" });
    });
    let cancelled: Payload | null = null;
    act(() => {
      cancelled = current.cancel();
    });
    expect(cancelled).toEqual({ body: "Keep my text" });
    expect(current.status).toBe("idle");
    expect(readPendingSend(STORED_KEY, isPayload)).toBeNull();
    await advance(60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("stalls after repeated failures while online and resends on demand", async () => {
    const send = vi.fn().mockRejectedValue(new ApiError("Bad gateway", 502, null));
    render({ send });
    await act(async () => {
      await current.submit({ body: "Stubborn route" });
    });
    // Effects schedule each next resend after React commits, so step through.
    for (let step = 0; step < 2 * MAX_ONLINE_RESENDS; step += 1) await advance(30_000);
    expect(send).toHaveBeenCalledTimes(1 + MAX_ONLINE_RESENDS);
    expect(current.status).toBe("stalled");
    send.mockResolvedValueOnce({ id: "row-1", body: "Stubborn route" });
    await act(async () => {
      current.resendNow();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(current.status).toBe("idle");
  });

  it("never resends a non-idempotent write on its own", async () => {
    const send = vi.fn().mockRejectedValueOnce(outage()).mockResolvedValue({ id: "upload-1", body: "file" });
    render({ send, autoResend: false });
    await act(async () => {
      await current.submit({ body: "file" });
    });
    await advance(10 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(current.status).toBe("waiting");
    expect(store.getSnapshot().pendingWrites).toBe(1);
    await act(async () => {
      current.resendNow();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(current.status).toBe("idle");
  });

  it("keeps its resend budget when the caller stops waiting during each resend", async () => {
    // Like a mutation-backed caller: `active` drops while its own resend is
    // pending and only comes back a tick after the resend failed.
    let auto!: AutoResendState;
    const resend = vi.fn();
    function FlappingCaller() {
      const [waiting, setWaiting] = useState(true);
      auto = useAutoResend({
        sourceId: "flapping",
        active: waiting,
        resend: async () => {
          resend();
          setWaiting(false);
          await Promise.resolve();
          setTimeout(() => setWaiting(true), 0);
          return "pending";
        },
      });
      return null;
    }
    act(() => {
      root.render(<ConnectivityProvider store={store}><FlappingCaller /></ConnectivityProvider>);
    });
    for (let step = 0; step < 3 * MAX_ONLINE_RESENDS; step += 1) await advance(30_000);
    expect(resend).toHaveBeenCalledTimes(MAX_ONLINE_RESENDS);
    expect(auto.stalled).toBe(true);
  });
});
