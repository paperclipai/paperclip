import { applyCompanyPrefix, extractCompanyPrefixFromPath } from "@/lib/company-routes";

export const DESKTOP_NOTIFICATION_STORAGE_KEY = "paperclip:desktop-notifications";
export const DESKTOP_NOTIFICATION_LEVEL_CHANGED = "paperclip:desktop-notifications-change";
export const DESKTOP_NOTIFICATION_ICON = "/favicon-32x32.png";
export const DESKTOP_NOTIFICATION_TEST_TAG = "paperclip:desktop-notification-test";

export type DesktopNotificationLevel = "off" | "attention" | "all";
export type DesktopNotificationPermission = NotificationPermission | "unsupported";

export type DesktopNotificationToast = {
  id: string;
  title: string;
  body?: string;
  tone: "info" | "success" | "warn" | "error";
  action?: { href?: string };
  dedupeKey?: string;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

type NotificationLike = {
  permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
  new (
    title: string,
    options?: NotificationOptions,
  ): {
    onclick: ((this: Notification, ev: Event) => unknown) | null;
    close: () => void;
  };
};

export type DesktopNotificationEnvironment = {
  storage?: StorageLike | null;
  notification?: NotificationLike | null;
  isSecureContext?: boolean;
  visibilityState?: DocumentVisibilityState;
  getRegistration?: () => Promise<ServiceWorkerRegistration | null | undefined>;
  focus?: () => void;
  navigate?: (href: string) => void;
  companyPrefix?: string | null;
};

export const DESKTOP_NOTIFICATION_NAVIGATE_EVENT = "paperclip:desktop-notification-navigate";

let navigateTo: ((href: string) => void) | null = null;
let boundCompanyPrefix: string | null = null;

export function bindDesktopNotificationNavigation(
  navigate: ((href: string) => void) | null,
  companyPrefix: string | null = null,
) {
  navigateTo = navigate;
  boundCompanyPrefix = navigate ? companyPrefix : null;
}

export function resolveDesktopNotificationHref(
  href: string | undefined,
  env: DesktopNotificationEnvironment = {},
): string | undefined {
  if (!href) return undefined;
  const prefix = env.companyPrefix !== undefined
    ? env.companyPrefix
    : boundCompanyPrefix ?? (
      typeof window === "undefined" ? null : extractCompanyPrefixFromPath(window.location.pathname)
    );
  return applyCompanyPrefix(href, prefix);
}

function browserStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

function notificationApi(notification?: NotificationLike | null): NotificationLike | null {
  if (notification !== undefined) return notification;
  if (typeof window === "undefined" || !("Notification" in window)) return null;
  return Notification as unknown as NotificationLike;
}

export function isDesktopNotificationSupported(env: DesktopNotificationEnvironment = {}): boolean {
  const isSecure = env.isSecureContext ?? (typeof window === "undefined" || window.isSecureContext !== false);
  return Boolean(notificationApi(env.notification)) && isSecure;
}

export function readDesktopNotificationPermission(
  env: DesktopNotificationEnvironment = {},
): DesktopNotificationPermission {
  if (!isDesktopNotificationSupported(env)) return "unsupported";
  const api = notificationApi(env.notification);
  if (!api) return "unsupported";
  const permission = api.permission;
  if (permission === "granted" || permission === "denied" || permission === "default") return permission;
  return "default";
}

export function readDesktopNotificationLevel(env: DesktopNotificationEnvironment = {}): DesktopNotificationLevel {
  try {
    const raw = browserStorage(env.storage)?.getItem(DESKTOP_NOTIFICATION_STORAGE_KEY);
    if (raw === "off" || raw === "attention" || raw === "all") return raw;
  } catch {
    return "off";
  }
  return "off";
}

export function writeDesktopNotificationLevel(
  level: DesktopNotificationLevel,
  env: DesktopNotificationEnvironment = {},
): boolean {
  try {
    const storage = browserStorage(env.storage);
    if (!storage) return false;
    storage.setItem(DESKTOP_NOTIFICATION_STORAGE_KEY, level);
    if (typeof window === "undefined") return true;
    if (env.storage !== undefined && env.storage !== (typeof localStorage === "undefined" ? null : localStorage)) {
      return true;
    }
    window.dispatchEvent(new Event(DESKTOP_NOTIFICATION_LEVEL_CHANGED));
    return true;
  } catch {
    return false;
  }
}

export function keepsLiveSocketWhileHidden(
  level: DesktopNotificationLevel = readDesktopNotificationLevel(),
): boolean {
  return level === "attention" || level === "all";
}

export function subscribeDesktopNotificationLevel(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === DESKTOP_NOTIFICATION_STORAGE_KEY || event.key === null) onChange();
  };
  window.addEventListener(DESKTOP_NOTIFICATION_LEVEL_CHANGED, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(DESKTOP_NOTIFICATION_LEVEL_CHANGED, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function isAttentionToast(toast: DesktopNotificationToast): boolean {
  if (toast.tone === "error" || toast.tone === "warn") return true;
  const href = toast.action?.href ?? "";
  const dedupeKey = toast.dedupeKey ?? "";
  if (dedupeKey.startsWith("join-request:")) return true;
  if (/(?:^|\/)approvals(?:\/|$|\?|#)/.test(href)) return true;
  if (href.includes("#interaction")) return true;
  const text = `${toast.title}\n${toast.body ?? ""}`;
  if (/\bwants to join\b/i.test(text)) return true;
  if (/\bwaiting for approval\b/i.test(text)) return true;
  if (/\bneeds you\b/i.test(text)) return true;
  if (/\basked you\b/i.test(text)) return true;
  return false;
}

export function shouldMirrorToast(
  toast: DesktopNotificationToast,
  env: DesktopNotificationEnvironment = {},
): boolean {
  if (!isDesktopNotificationSupported(env)) return false;
  if (readDesktopNotificationPermission(env) !== "granted") return false;
  const level = readDesktopNotificationLevel(env);
  if (level === "off") return false;
  const visibility = env.visibilityState ?? (typeof document === "undefined" ? "visible" : document.visibilityState);
  if (visibility !== "hidden") return false;
  if (level === "all") return true;
  return isAttentionToast(toast);
}

export async function requestDesktopNotificationPermission(
  env: DesktopNotificationEnvironment = {},
): Promise<DesktopNotificationPermission> {
  if (!isDesktopNotificationSupported(env)) return "unsupported";
  const api = notificationApi(env.notification);
  if (!api) return "unsupported";
  try {
    const result = await api.requestPermission();
    if (result === "granted" || result === "denied" || result === "default") return result;
    return readDesktopNotificationPermission(env);
  } catch {
    return readDesktopNotificationPermission(env);
  }
}

async function resolveRegistration(
  env: DesktopNotificationEnvironment,
): Promise<ServiceWorkerRegistration | null> {
  try {
    if (env.getRegistration) {
      return (await env.getRegistration()) ?? null;
    }
    if (typeof navigator === "undefined" || !navigator.serviceWorker?.getRegistration) return null;
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

export function presentDesktopNotification(
  input: { title: string; body?: string; tag: string; href?: string; icon?: string },
  env: DesktopNotificationEnvironment = {},
): void {
  try {
    const api = notificationApi(env.notification);
    if (api && readDesktopNotificationPermission(env) !== "granted") return;
    const href = resolveDesktopNotificationHref(input.href, env);
    const options: NotificationOptions = {
      body: input.body,
      tag: input.tag,
      icon: input.icon ?? DESKTOP_NOTIFICATION_ICON,
      data: { href: href ?? null },
    };
    const openTarget = (closable?: { close?: () => void }) => {
      try {
        closable?.close?.();
      } catch {}
      try {
        (env.focus ?? (() => window.focus()))();
      } catch {}
      if (!href) return;
      try {
        if (
          typeof window !== "undefined" &&
          !window.dispatchEvent(new CustomEvent(DESKTOP_NOTIFICATION_NAVIGATE_EVENT, { cancelable: true, detail: { href } }))
        ) {
          return;
        }
        (env.navigate ?? navigateTo)?.(href);
      } catch {}
    };
    if (api) {
      try {
        const notification = new api(input.title, options);
        notification.onclick = (event: Event) => {
          try {
            event.preventDefault();
          } catch {}
          openTarget(notification);
        };
        return;
      } catch {}
    }
    void resolveRegistration(env)
      .then((registration) => {
        if (registration && typeof registration.showNotification === "function") {
          return registration.showNotification(input.title, options);
        }
        return undefined;
      })
      .catch(() => undefined);
  } catch {
    return;
  }
}

export function mirrorPushedToast(
  toast: DesktopNotificationToast,
  env: DesktopNotificationEnvironment = {},
): void {
  try {
    if (!shouldMirrorToast(toast, env)) return;
    presentDesktopNotification(
      {
        title: toast.title,
        body: toast.body,
        tag: toast.dedupeKey ?? toast.id,
        href: toast.action?.href,
      },
      env,
    );
  } catch {
    return;
  }
}

export function sendTestDesktopNotification(env: DesktopNotificationEnvironment = {}): void {
  try {
    if (readDesktopNotificationPermission(env) !== "granted") return;
    presentDesktopNotification(
      {
        title: "Paperclip",
        body: "Desktop notifications are on.",
        tag: DESKTOP_NOTIFICATION_TEST_TAG,
      },
      env,
    );
  } catch {
    return;
  }
}
