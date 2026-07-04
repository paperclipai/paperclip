// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PushNotificationSection } from "./PushNotificationSection";
import { usePushNotifications } from "@/hooks/use-push-notifications";

vi.mock("@/hooks/use-push-notifications", () => ({
  usePushNotifications: vi.fn(),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderSection() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const createdRoot = createRoot(container);
  root = createdRoot;
  act(() => {
    createdRoot.render(<PushNotificationSection />);
  });
  return { text: () => container?.textContent ?? "" };
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe("PushNotificationSection", () => {
  it("renders the subscribed device list and marks the current device", () => {
    vi.mocked(usePushNotifications).mockReturnValue({
      state: { status: "subscribed", endpoint: "https://push.example/current" },
      isToggling: false,
      subscriptions: [
        {
          id: "sub-1",
          endpoint: "https://push.example/current",
          deviceLabel: "Chrome on Linux",
          createdAt: "2026-07-04T00:00:00.000Z",
        },
        {
          id: "sub-2",
          endpoint: "https://push.example/phone",
          deviceLabel: "Mobile Safari",
          createdAt: "2026-07-03T00:00:00.000Z",
        },
      ],
      refreshSubscriptions: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
    });

    const view = renderSection();

    expect(view.text()).toContain("Subscribed devices");
    expect(view.text()).toContain("Chrome on Linux");
    expect(view.text()).toContain("Mobile Safari");
    expect(view.text()).toContain("This device");
  });

  it("renders an empty subscribed-device state", () => {
    vi.mocked(usePushNotifications).mockReturnValue({
      state: { status: "unsubscribed" },
      isToggling: false,
      subscriptions: [],
      refreshSubscriptions: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
    });

    const view = renderSection();

    expect(view.text()).toContain("No devices are subscribed yet.");
  });
});
