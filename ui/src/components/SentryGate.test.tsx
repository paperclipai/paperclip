// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { SentryGate } from "./SentryGate";

const getSessionMock = vi.hoisted(() => vi.fn());
const initBrowserErrorMonitoringMock = vi.hoisted(() => vi.fn(async (_dsn: string) => {}));
const teardownBrowserErrorMonitoringMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/api/auth", () => ({
  authApi: { getSession: () => getSessionMock() },
}));

vi.mock("@/lib/sentry", () => ({
  initBrowserErrorMonitoring: (dsn: string) => initBrowserErrorMonitoringMock(dsn),
  teardownBrowserErrorMonitoring: () => teardownBrowserErrorMonitoringMock(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("SentryGate", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderGate() {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SentryGate />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("loads no SDK when the session query answers null", async () => {
    getSessionMock.mockResolvedValue(null);

    const root = await renderGate();

    expect(initBrowserErrorMonitoringMock).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
    root.unmount();
  });

  it("loads no SDK when the session sentryDsn is null", async () => {
    getSessionMock.mockResolvedValue({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: "Jane", image: null },
      sentryDsn: null,
    });

    const root = await renderGate();

    expect(initBrowserErrorMonitoringMock).not.toHaveBeenCalled();
    root.unmount();
  });

  it("opens the gate once when the session carries a DSN", async () => {
    getSessionMock.mockResolvedValue({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: "Jane", image: null },
      sentryDsn: "https://public@o0.ingest.sentry.io/1",
    });

    const root = await renderGate();

    expect(initBrowserErrorMonitoringMock).toHaveBeenCalledTimes(1);
    expect(initBrowserErrorMonitoringMock).toHaveBeenCalledWith("https://public@o0.ingest.sentry.io/1");
    root.unmount();
  });

  it("opens the gate after a signed-out session query refetches with a DSN", async () => {
    getSessionMock.mockResolvedValue(null);
    const root = await renderGate();
    expect(initBrowserErrorMonitoringMock).not.toHaveBeenCalled();

    getSessionMock.mockResolvedValue({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: "Jane", image: null },
      sentryDsn: "https://public@o0.ingest.sentry.io/1",
    });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.auth.session });
    });
    await flushReact();

    expect(initBrowserErrorMonitoringMock).toHaveBeenCalledTimes(1);
    expect(initBrowserErrorMonitoringMock).toHaveBeenCalledWith("https://public@o0.ingest.sentry.io/1");
    root.unmount();
  });

  it("closes browser monitoring when sign-out clears the session's DSN", async () => {
    getSessionMock.mockResolvedValue({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: "Jane", image: null },
      sentryDsn: "https://public@o0.ingest.sentry.io/1",
    });
    const root = await renderGate();
    expect(initBrowserErrorMonitoringMock).toHaveBeenCalledTimes(1);
    expect(teardownBrowserErrorMonitoringMock).not.toHaveBeenCalled();

    // `useSignOut` resets the session query on sign-out; a mounted observer
    // (this component) sees its data drop to `undefined` immediately.
    getSessionMock.mockResolvedValue(null);
    await act(async () => {
      queryClient.resetQueries({ queryKey: queryKeys.auth.session });
    });
    await flushReact();

    expect(teardownBrowserErrorMonitoringMock).toHaveBeenCalledTimes(1);
    // Signing back in must start a fresh client, not skip re-init.
    expect(initBrowserErrorMonitoringMock).toHaveBeenCalledTimes(1);
    root.unmount();
  });

  it("closes browser monitoring when the gate unmounts while a session DSN is set", async () => {
    getSessionMock.mockResolvedValue({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: "Jane", image: null },
      sentryDsn: "https://public@o0.ingest.sentry.io/1",
    });
    const root = await renderGate();
    expect(initBrowserErrorMonitoringMock).toHaveBeenCalledTimes(1);

    root.unmount();

    expect(teardownBrowserErrorMonitoringMock).toHaveBeenCalledTimes(1);
  });
});
