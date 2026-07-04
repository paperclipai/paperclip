// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushApi } from "@/api/push";
import { usePushNotifications, type PushState } from "./use-push-notifications";

vi.mock("@/api/push", () => ({
  pushApi: {
    getVapidPublicKey: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    listSubscriptions: vi.fn(),
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookSnapshot = ReturnType<typeof usePushNotifications>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: HookSnapshot | null = null;

function setBrowserPushMocks(registration: unknown, permission = "default") {
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(window, "PushManager", { value: function PushManager() {}, configurable: true });
  vi.stubGlobal("Notification", {
    permission,
    requestPermission: vi.fn(),
  });
  Object.defineProperty(navigator, "serviceWorker", {
    value: { ready: Promise.resolve(registration) },
    configurable: true,
  });
}

function Harness() {
  latest = usePushNotifications();
  return null;
}

async function renderHook() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Harness />);
  });
}

async function waitForState(status: PushState["status"]) {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (latest?.state.status === status) return;
  }
  throw new Error(`Timed out waiting for push state ${status}; saw ${latest?.state.status}`);
}

beforeEach(() => {
  vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ vapidPublicKey: "AQID" });
  vi.mocked(pushApi.subscribe).mockResolvedValue({ status: "subscribed" });
  vi.mocked(pushApi.unsubscribe).mockResolvedValue({ status: "unsubscribed" });
  vi.mocked(pushApi.listSubscriptions).mockResolvedValue({ subscriptions: [] });
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
  latest = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("usePushNotifications", () => {
  it("cleans up a browser subscription that is missing from the server list", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    setBrowserPushMocks({
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue({
          endpoint: "https://push.example/local-only",
          unsubscribe,
        }),
      },
    });

    await renderHook();
    await waitForState("unsubscribed");

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(latest?.subscriptions).toEqual([]);
  });

  it("rolls back the browser subscription when server sync fails during enable", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const subscription = {
      endpoint: "https://push.example/new-device",
      toJSON: () => ({ keys: { p256dh: "p256dh", auth: "auth" } }),
      unsubscribe,
    };
    setBrowserPushMocks({
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe: vi.fn().mockResolvedValue(subscription),
      },
    });
    vi.mocked(Notification.requestPermission).mockResolvedValue("granted");
    vi.mocked(pushApi.subscribe).mockRejectedValue(new Error("server unavailable"));

    await renderHook();
    await waitForState("unsubscribed");

    await act(async () => {
      await latest?.enable();
    });

    expect(pushApi.subscribe).toHaveBeenCalledWith({
      endpoint: "https://push.example/new-device",
      p256dh: "p256dh",
      auth: "auth",
      deviceLabel: expect.any(String),
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(latest?.state).toMatchObject({ status: "error", message: "server unavailable" });
  });

  it("unsubscribes locally before deleting the server subscription", async () => {
    const calls: string[] = [];
    const subscription = {
      endpoint: "https://push.example/current-device",
      unsubscribe: vi.fn().mockImplementation(async () => {
        calls.push("local");
        return true;
      }),
    };
    setBrowserPushMocks({
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(subscription),
      },
    });
    vi.mocked(pushApi.listSubscriptions).mockResolvedValue({
      subscriptions: [{
        id: "sub-1",
        endpoint: "https://push.example/current-device",
        deviceLabel: "Chrome on Linux",
        createdAt: "2026-07-04T00:00:00.000Z",
      }],
    });
    vi.mocked(pushApi.unsubscribe).mockImplementation(async () => {
      calls.push("server");
      return { status: "unsubscribed" };
    });

    await renderHook();
    await waitForState("subscribed");

    await act(async () => {
      await latest?.disable();
    });

    expect(calls).toEqual(["local", "server"]);
    expect(latest?.state.status).toBe("unsubscribed");
  });
});
