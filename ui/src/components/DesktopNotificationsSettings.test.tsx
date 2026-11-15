// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_NOTIFICATION_STORAGE_KEY } from "@/lib/desktop-notifications";
import { DesktopNotificationsSettings } from "./DesktopNotificationsSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FakeNotificationInstance = {
  title: string;
  options?: NotificationOptions;
};

function installNotification(permission: NotificationPermission) {
  const instances: FakeNotificationInstance[] = [];
  const requestPermission = vi.fn(async () => permission);
  class FakeNotification {
    static permission = permission;
    static requestPermission = requestPermission;
    title: string;
    options?: NotificationOptions;
    onclick = null;
    close = vi.fn();
    constructor(title: string, options?: NotificationOptions) {
      this.title = title;
      this.options = options;
      instances.push(this);
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  return { FakeNotification, instances, requestPermission };
}

describe("DesktopNotificationsSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.localStorage.clear();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  async function render() {
    const root = createRoot(container);
    await act(async () => {
      root.render(<DesktopNotificationsSettings />);
    });
    return root;
  }

  it("requests permission when enabling Needs attention", async () => {
    const api = installNotification("default");
    api.requestPermission.mockResolvedValue("granted");
    const root = await render();
    const attention = Array.from(container.querySelectorAll('[role="radio"]')).find(
      (button) => button.textContent?.includes("Needs attention"),
    );
    expect(attention).toBeTruthy();
    await act(async () => {
      attention?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(api.requestPermission).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(DESKTOP_NOTIFICATION_STORAGE_KEY)).toBe("attention");
    expect(container.textContent).toContain("This browser allowed Paperclip to show notifications.");
    await act(async () => root.unmount());
  });

  it("shows denied copy when the browser blocks notifications", async () => {
    installNotification("denied");
    const root = await render();
    expect(container.textContent).toContain("Notifications are blocked for this site.");
    expect(container.textContent).toContain("Allow them in your browser site settings");
    await act(async () => root.unmount());
  });

  it("shows unsupported copy when the API is missing", async () => {
    vi.stubGlobal("Notification", undefined);
    Object.defineProperty(window, "Notification", { configurable: true, value: undefined });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    const root = await render();
    expect(container.textContent).toContain("This browser cannot show desktop notifications.");
    expect(container.textContent).toContain("HTTPS or localhost");
    await act(async () => root.unmount());
  });

  it("shows unsupported copy when the origin is not a secure context", async () => {
    installNotification("granted");
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    const root = await render();
    expect(container.textContent).toContain("This browser cannot show desktop notifications.");
    await act(async () => root.unmount());
  });

  it("restores the stored preference after a remount", async () => {
    installNotification("granted");
    window.localStorage.setItem(DESKTOP_NOTIFICATION_STORAGE_KEY, "all");
    const root = await render();
    const all = Array.from(container.querySelectorAll('[role="radio"]')).find((button) => {
      return button.textContent?.startsWith("All") || button.querySelector("span")?.textContent === "All";
    });
    const selected = container.querySelector('[role="radio"][aria-checked="true"]');
    expect(selected?.textContent).toContain("All");
    expect(all).toBeTruthy();
    await act(async () => root.unmount());
    const root2 = createRoot(container);
    await act(async () => {
      root2.render(<DesktopNotificationsSettings />);
    });
    expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("All");
    await act(async () => root2.unmount());
  });

  it("sends a test notification after permission is granted", async () => {
    const api = installNotification("granted");
    const root = await render();
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Send test notification",
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(api.instances).toHaveLength(1);
    expect(api.instances[0]?.title).toBe("Paperclip");
    await act(async () => root.unmount());
  });

  it("updates the selected card when another tab changes the stored choice", async () => {
    installNotification("granted");
    const root = await render();
    expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("Off");
    await act(async () => {
      window.localStorage.setItem(DESKTOP_NOTIFICATION_STORAGE_KEY, "all");
      window.dispatchEvent(new StorageEvent("storage", {
        key: DESKTOP_NOTIFICATION_STORAGE_KEY,
        newValue: "all",
      }));
    });
    expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("All");
    await act(async () => root.unmount());
  });

  it("keeps the previous choice and shows an error when storage rejects the save", async () => {
    installNotification("granted");
    const root = await render();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const all = Array.from(container.querySelectorAll('[role="radio"]')).find((button) => {
      return button.textContent?.startsWith("All") || button.querySelector("span")?.textContent === "All";
    });
    await act(async () => {
      all?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not save the notification choice");
    expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("Off");
    expect(window.localStorage.getItem(DESKTOP_NOTIFICATION_STORAGE_KEY)).toBeNull();
    await act(async () => root.unmount());
  });

  it("ignores an older permission result after Off is chosen", async () => {
    const api = installNotification("default");
    let grant: ((permission: NotificationPermission) => void) | undefined;
    api.requestPermission.mockImplementation(() => new Promise((resolve) => {
      grant = resolve;
    }));
    const root = await render();
    const radios = Array.from(container.querySelectorAll('[role="radio"]'));
    const all = radios.find((button) => button.textContent?.startsWith("All") || button.querySelector("span")?.textContent === "All");
    const off = radios.find((button) => button.textContent?.includes("Off"));
    await act(async () => {
      all?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      off?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(window.localStorage.getItem(DESKTOP_NOTIFICATION_STORAGE_KEY)).toBe("off");
    await act(async () => {
      grant?.("granted");
    });
    expect(window.localStorage.getItem(DESKTOP_NOTIFICATION_STORAGE_KEY)).toBe("off");
    expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("Off");
    await act(async () => root.unmount());
  });
});
