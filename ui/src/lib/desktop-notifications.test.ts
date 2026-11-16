import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_NOTIFICATION_NAVIGATE_EVENT,
  bindDesktopNotificationNavigation,
  DESKTOP_NOTIFICATION_ICON,
  DESKTOP_NOTIFICATION_STORAGE_KEY,
  DESKTOP_NOTIFICATION_TEST_TAG,
  isAttentionToast,
  isDesktopNotificationSupported,
  keepsLiveSocketWhileHidden,
  mirrorPushedToast,
  presentDesktopNotification,
  readDesktopNotificationLevel,
  readDesktopNotificationPermission,
  requestDesktopNotificationPermission,
  resolveDesktopNotificationHref,
  sendTestDesktopNotification,
  shouldMirrorToast,
  writeDesktopNotificationLevel,
  type DesktopNotificationEnvironment,
  type DesktopNotificationToast,
} from "./desktop-notifications";

type FakeNotificationInstance = {
  title: string;
  options?: NotificationOptions;
  onclick: ((this: Notification, ev: Event) => unknown) | null;
  close: ReturnType<typeof vi.fn>;
};

function createNotificationApi(permission: NotificationPermission = "granted") {
  const instances: FakeNotificationInstance[] = [];
  const requestPermission = vi.fn(async () => permission);
  class FakeNotification {
    static permission = permission;
    static requestPermission = requestPermission;
    static instances = instances;
    title: string;
    options?: NotificationOptions;
    onclick: FakeNotificationInstance["onclick"] = null;
    close = vi.fn();
    constructor(title: string, options?: NotificationOptions) {
      this.title = title;
      this.options = options;
      instances.push(this);
    }
  }
  return { FakeNotification, instances, requestPermission };
}

function toast(overrides: Partial<DesktopNotificationToast> = {}): DesktopNotificationToast {
  return {
    id: "toast_1",
    title: "Ada run succeeded",
    body: "Trigger: comment",
    tone: "success",
    ...overrides,
  };
}

describe("desktop notifications", () => {
  const storage = new Map<string, string>();
  const storageLike = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };

  beforeEach(() => {
    storage.clear();
    bindDesktopNotificationNavigation(null);
  });

  afterEach(() => {
    bindDesktopNotificationNavigation(null);
  });

  it("treats a missing API or insecure context as unsupported", () => {
    expect(isDesktopNotificationSupported({ notification: null, isSecureContext: true })).toBe(false);
    const { FakeNotification } = createNotificationApi();
    expect(isDesktopNotificationSupported({
      notification: FakeNotification as unknown as DesktopNotificationEnvironment["notification"],
      isSecureContext: false,
    })).toBe(false);
    expect(readDesktopNotificationPermission({ notification: null, isSecureContext: true })).toBe("unsupported");
  });

  it("defaults the stored preference to off and persists a chosen level", () => {
    expect(readDesktopNotificationLevel({ storage: storageLike })).toBe("off");
    expect(writeDesktopNotificationLevel("attention", { storage: storageLike })).toBe(true);
    expect(storageLike.getItem(DESKTOP_NOTIFICATION_STORAGE_KEY)).toBe("attention");
    expect(readDesktopNotificationLevel({ storage: storageLike })).toBe("attention");
    expect(writeDesktopNotificationLevel("all", { storage: storageLike })).toBe(true);
    expect(readDesktopNotificationLevel({ storage: storageLike })).toBe("all");
  });

  it("returns false when storage is missing or rejects the write", () => {
    expect(writeDesktopNotificationLevel("all", { storage: null })).toBe(false);
    expect(writeDesktopNotificationLevel("all", {
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
      },
    })).toBe(false);
    expect(readDesktopNotificationLevel({
      storage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => undefined,
      },
    })).toBe("off");
  });

  it("prefixes notification destinations at present time", () => {
    expect(resolveDesktopNotificationHref("/inbox/mine", { companyPrefix: "PAP" })).toBe("/PAP/inbox/mine");
    expect(resolveDesktopNotificationHref("/PAP/agents/ada/runs/run-1", { companyPrefix: "ORG" })).toBe("/PAP/agents/ada/runs/run-1");
    expect(resolveDesktopNotificationHref("/inbox/mine", { companyPrefix: null })).toBe("/inbox/mine");
    expect(resolveDesktopNotificationHref(undefined, { companyPrefix: "PAP" })).toBeUndefined();
  });

  it("ignores unknown stored values", () => {
    storageLike.setItem(DESKTOP_NOTIFICATION_STORAGE_KEY, "loud");
    expect(readDesktopNotificationLevel({ storage: storageLike })).toBe("off");
  });

  it("keeps the live socket while hidden only when notifications are enabled", () => {
    expect(keepsLiveSocketWhileHidden("off")).toBe(false);
    expect(keepsLiveSocketWhileHidden("attention")).toBe(true);
    expect(keepsLiveSocketWhileHidden("all")).toBe(true);
  });

  it.each([
    [{ tone: "error" as const }, true],
    [{ tone: "warn" as const }, true],
    [{ tone: "success" as const }, false],
    [{ tone: "info" as const }, false],
    [{ tone: "info" as const, dedupeKey: "join-request:abc" }, true],
    [{ tone: "info" as const, title: "Someone wants to join" }, true],
    [{ tone: "info" as const, body: "A new join request is waiting for approval." }, true],
    [{ tone: "info" as const, action: { href: "/approvals/appr-1" } }, true],
    [{ tone: "info" as const, action: { href: "/PAP/issues/PAP-1#interaction-9" } }, true],
    [{ tone: "info" as const, title: "Ada asked you to review the plan" }, true],
    [{ tone: "info" as const, title: "A task needs you" }, true],
    [{ tone: "success" as const, title: "Join request approved" }, false],
    [{ tone: "info" as const, title: "Ada created PAP-1" }, false],
  ] as const)("classifies attention toasts %j", (overrides, expected) => {
    expect(isAttentionToast(toast(overrides))).toBe(expected);
  });

  it("mirrors only while the tab is hidden and the level includes the toast", () => {
    const { FakeNotification } = createNotificationApi("granted");
    const envFor = (level: "off" | "attention" | "all", visibility: DocumentVisibilityState): DesktopNotificationEnvironment => {
      writeDesktopNotificationLevel(level, { storage: storageLike });
      return {
        storage: storageLike,
        notification: FakeNotification as unknown as DesktopNotificationEnvironment["notification"],
        isSecureContext: true,
        visibilityState: visibility,
      };
    };

    expect(shouldMirrorToast(toast({ tone: "error" }), envFor("off", "hidden"))).toBe(false);
    expect(shouldMirrorToast(toast({ tone: "error" }), envFor("attention", "visible"))).toBe(false);
    expect(shouldMirrorToast(toast({ tone: "error" }), envFor("attention", "hidden"))).toBe(true);
    expect(shouldMirrorToast(toast({ tone: "warn" }), envFor("attention", "hidden"))).toBe(true);
    expect(shouldMirrorToast(toast({ tone: "success" }), envFor("attention", "hidden"))).toBe(false);
    expect(shouldMirrorToast(toast({ tone: "info" }), envFor("attention", "hidden"))).toBe(false);
    expect(shouldMirrorToast(toast({ tone: "info", dedupeKey: "join-request:1" }), envFor("attention", "hidden"))).toBe(true);
    expect(shouldMirrorToast(toast({ tone: "success" }), envFor("all", "hidden"))).toBe(true);
    expect(shouldMirrorToast(toast({ tone: "info" }), envFor("all", "hidden"))).toBe(true);
    expect(shouldMirrorToast(toast({ tone: "success" }), envFor("all", "visible"))).toBe(false);
  });

  it("does not mirror when permission is denied or the API is missing", () => {
    const denied = createNotificationApi("denied");
    writeDesktopNotificationLevel("all", { storage: storageLike });
    expect(shouldMirrorToast(toast({ tone: "error" }), {
      storage: storageLike,
      notification: denied.FakeNotification as unknown as DesktopNotificationEnvironment["notification"],
      isSecureContext: true,
      visibilityState: "hidden",
    })).toBe(false);
    expect(shouldMirrorToast(toast({ tone: "error" }), {
      storage: storageLike,
      notification: null,
      isSecureContext: true,
      visibilityState: "hidden",
    })).toBe(false);
  });

  it("requests permission from a user gesture path", async () => {
    const api = createNotificationApi("default");
    api.requestPermission.mockResolvedValue("granted");
    await expect(requestDesktopNotificationPermission({
      notification: api.FakeNotification as unknown as DesktopNotificationEnvironment["notification"],
      isSecureContext: true,
    })).resolves.toBe("granted");
    expect(api.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("reuses the toast dedupe key as the notification tag", () => {
    const api = createNotificationApi("granted");
    writeDesktopNotificationLevel("all", { storage: storageLike });
    const env: DesktopNotificationEnvironment = {
      storage: storageLike,
      notification: api.FakeNotification as unknown as DesktopNotificationEnvironment["notification"],
      isSecureContext: true,
      visibilityState: "hidden",
    };
    mirrorPushedToast(toast({
      id: "toast_9",
      dedupeKey: "run-status:run-1:failed",
      tone: "error",
      title: "Ada run failed",
    }), env);
    expect(api.instances).toHaveLength(1);
    expect(api.instances[0]?.options).toMatchObject({
      tag: "run-status:run-1:failed",
      icon: DESKTOP_NOTIFICATION_ICON,
    });
    api.instances.length = 0;
    presentDesktopNotification({ title: "Ada run failed", tag: "run-status:run-1:failed" }, env);
    expect(api.instances[0]?.options?.tag).toBe("run-status:run-1:failed");
  });

  it("focuses the window and navigates to a company-prefixed href on click", () => {
    const api = createNotificationApi("granted");
    const focus = vi.fn();
    const navigate = vi.fn();
    presentDesktopNotification({
      title: "Ada run failed",
      body: "exit 1",
      tag: "run-status:run-1:failed",
      href: "/agents/ada/runs/run-1",
    }, {
      notification: api.FakeNotification as unknown as DesktopNotificationEnvironment["notification"],
      isSecureContext: true,
      focus,
      navigate,
      companyPrefix: "PAP",
    });
    const instance = api.instances[0];
    expect(instance).toBeTruthy();
    expect(instance?.options?.data).toEqual({ href: "/PAP/agents/ada/runs/run-1" });
    instance?.onclick?.call(instance as unknown as Notification, new Event("click"));
    expect(instance?.close).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/PAP/agents/ada/runs/run-1");
  });

  it("stays on the page when a listener cancels the notification navigation", () => {
    const api = createNotificationApi("granted");
    const navigate = vi.fn();
    const fakeWindow = new EventTarget();
    fakeWindow.addEventListener(DESKTOP_NOTIFICATION_NAVIGATE_EVENT, (event) => event.preventDefault());
    vi.stubGlobal("window", fakeWindow);
    try {
      presentDesktopNotification({
        title: "Ada run failed",
        tag: "run-status:run-1:failed",
        href: "/agents/ada/runs/run-1",
      }, {
        notification: api.FakeNotification as unknown as DesktopNotificationEnvironment["notification"],
        isSecureContext: true,
        focus: vi.fn(),
        navigate,
        companyPrefix: "PAP",
      });
      api.instances[0]?.onclick?.call(api.instances[0] as unknown as Notification, new Event("click"));
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the bound company prefix when the presenter does not receive one", () => {
    const api = createNotificationApi("granted");
    const navigate = vi.fn();
    bindDesktopNotificationNavigation(navigate, "PAP");
    presentDesktopNotification({
      title: "Someone wants to join",
      tag: "join-request:1",
      href: "/inbox/mine",
    }, {
      notification: api.FakeNotification as unknown as DesktopNotificationEnvironment["notification"],
      isSecureContext: true,
    });
    expect(api.instances[0]?.options?.data).toEqual({ href: "/PAP/inbox/mine" });
    api.instances[0]?.onclick?.call(api.instances[0] as unknown as Notification, new Event("click"));
    expect(navigate).toHaveBeenCalledWith("/PAP/inbox/mine");
  });

  it("keeps an already prefixed destination when the current company changes", () => {
    const api = createNotificationApi("granted");
    const navigate = vi.fn();
    presentDesktopNotification({
      title: "Ada run failed",
      tag: "run-status:run-1:failed",
      href: "/PAP/agents/ada/runs/run-1",
    }, {
      notification: api.FakeNotification as unknown as DesktopNotificationEnvironment["notification"],
      isSecureContext: true,
      navigate,
      companyPrefix: "ORG",
    });
    api.instances[0]?.onclick?.call(api.instances[0] as unknown as Notification, new Event("click"));
    expect(navigate).toHaveBeenCalledWith("/PAP/agents/ada/runs/run-1");
  });

  it("never throws when permission is revoked while presenting", () => {
    const throwing = {
      permission: "granted" as const,
      requestPermission: async () => "granted" as const,
    };
    Object.setPrototypeOf(throwing, function ThrowingNotification() {
      throw new Error("revoked");
    });
    expect(() => presentDesktopNotification({ title: "Ada run failed", tag: "x" }, {
      notification: throwing as unknown as DesktopNotificationEnvironment["notification"],
      isSecureContext: true,
    })).not.toThrow();
  });

  it("falls back to showNotification when the page constructor is missing", async () => {
    const showNotification = vi.fn(async () => undefined);
    presentDesktopNotification({
      title: "Ada run failed",
      tag: "run-status:run-1:failed",
      body: "exit 1",
      href: "/inbox/mine",
    }, {
      notification: null,
      isSecureContext: true,
      companyPrefix: "PAP",
      getRegistration: async () => ({ showNotification } as unknown as ServiceWorkerRegistration),
    });
    await vi.waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1));
    expect(showNotification).toHaveBeenCalledWith("Ada run failed", expect.objectContaining({
      tag: "run-status:run-1:failed",
      body: "exit 1",
      icon: DESKTOP_NOTIFICATION_ICON,
      data: { href: "/PAP/inbox/mine" },
    }));
  });

  it("sends a test notification without a hidden-tab gate", () => {
    const api = createNotificationApi("granted");
    sendTestDesktopNotification({
      notification: api.FakeNotification as unknown as DesktopNotificationEnvironment["notification"],
      isSecureContext: true,
      visibilityState: "visible",
    });
    expect(api.instances).toHaveLength(1);
    expect(api.instances[0]?.title).toBe("Paperclip");
    expect(api.instances[0]?.options?.tag).toBe(DESKTOP_NOTIFICATION_TEST_TAG);
  });
});
