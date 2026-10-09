// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";

const { pushToast } = vi.hoisted(() => ({ pushToast: vi.fn() }));
vi.mock("./CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1" } }),
}));
vi.mock("./ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));
vi.mock("../lib/router", () => ({ useLocation: () => ({ pathname: "/tasks" }) }));
vi.mock("../api/auth", () => ({
  authApi: { getSession: async () => ({ user: { id: "viewer" }, session: { id: "session", userId: "viewer" } }) },
}));
vi.mock("../api/health", () => ({ healthApi: { get: async () => ({ deploymentMode: "authenticated" }) } }));
import { LiveUpdatesProvider } from "./LiveUpdatesProvider";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class Socket {
  static instances: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage = null;
  onerror = null;
  constructor() { Socket.instances.push(this); }
  close() { this.readyState = 3; }
}

describe("LiveUpdatesProvider connection recovery", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const read = vi.fn(async () => "current task data");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    read.mockReset();
    read.mockResolvedValue("current task data");
    Socket.instances = [];
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "viewer" }, session: { id: "session", userId: "viewer" } });
    client.setQueryData(queryKeys.health, { deploymentMode: "authenticated" });
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function render() {
    function Tasks() {
      const { data } = useQuery({ queryKey: ["company-1", "tasks"], queryFn: read });
      return <span>{data}</span>;
    }
    await act(async () => root.render(
      <QueryClientProvider client={client}><LiveUpdatesProvider><Tasks /></LiveUpdatesProvider></QueryClientProvider>,
    ));
    await act(async () => vi.advanceTimersByTimeAsync(1));
  }

  it("reconciles updates between the initial query and the first socket connection", async () => {
    vi.stubGlobal("WebSocket", Socket);
    await render();
    expect(container.textContent).toBe("current task data");
    expect(Socket.instances).toHaveLength(1);

    // The server saves a reply after the page read but before it subscribes.
    // There is no event replay and this is not a reconnect.
    read.mockResolvedValue("reply saved during connection setup");
    await act(async () => Socket.instances[0].onopen?.());
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.textContent).toBe("reply saved during connection setup");
    const readsAfterConnect = read.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(read).toHaveBeenCalledTimes(readsAfterConnect);
  });

  it.each(["missing", "throws"])("polls visible data and resumes realtime when the constructor %s", async (failure) => {
    vi.stubGlobal("WebSocket", failure === "missing" ? undefined : class {
      constructor() { throw new DOMException("Blocked", "SecurityError"); }
    });
    await render();
    expect(container.textContent).toBe("current task data");
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(read).toHaveBeenCalledTimes(2);

    vi.stubGlobal("WebSocket", Socket);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(Socket.instances).toHaveLength(1);
    await act(async () => Socket.instances[0].onopen?.());
    const readsAfterRecovery = read.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(read).toHaveBeenCalledTimes(readsAfterRecovery);
    expect(Socket.instances).toHaveLength(1);

    // An ordinary disconnect must re-enable the same fallback.
    await act(async () => Socket.instances[0].onclose?.());
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(read.mock.calls.length).toBeGreaterThan(readsAfterRecovery);
  });

  it("stops fallback reads and connection retries while hidden and after unmount", async () => {
    const construct = vi.fn();
    vi.stubGlobal("WebSocket", class {
      constructor() { construct(); throw new Error("Unavailable"); }
    });
    await render();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    await act(async () => {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const attempts = construct.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(read).toHaveBeenCalledTimes(1);
    expect(construct).toHaveBeenCalledTimes(attempts);
    await act(async () => {
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => vi.advanceTimersByTimeAsync(15_001));
    expect(read.mock.calls.length).toBeGreaterThan(1);
    await act(async () => root.unmount());
    const readsAtUnmount = read.mock.calls.length;
    const attemptsAtUnmount = construct.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(read).toHaveBeenCalledTimes(readsAtUnmount);
    expect(construct).toHaveBeenCalledTimes(attemptsAtUnmount);
  });
});
