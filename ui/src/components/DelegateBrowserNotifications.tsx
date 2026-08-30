import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell, BellOff } from "lucide-react";
import { issuesApi } from "@/api/issues";
import { useCompany } from "@/context/CompanyContext";
import { useNavigate } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import {
  claimDelegateNotification,
  DELEGATE_NOTIFICATION_POLL_INTERVAL_MS,
  DELEGATE_NOTIFICATION_SETTINGS_EVENT,
  delegateNotificationStorageKey,
  getDueDelegateNotifications,
  isDelegateBrowserNotificationsEnabled,
  releaseDelegateNotification,
  setDelegateBrowserNotificationsEnabled,
} from "@/lib/delegate-browser-notifications";
import { Button } from "@/components/ui/button";

type BrowserPermission = NotificationPermission | "unsupported";
type ExtendedNotificationOptions = NotificationOptions & {
  data?: { href: string };
  renotify?: boolean;
};

const SERVICE_WORKER_READY_TIMEOUT_MS = 2_000;
let testNotificationSequence = 0;

function nextTestNotificationTag() {
  testNotificationSequence += 1;
  return `paperclip-delegate-notification-test-${Date.now()}-${testNotificationSequence}`;
}

function currentPermission(): BrowserPermission {
  if (typeof window === "undefined" || !("Notification" in window) || !window.isSecureContext) {
    return "unsupported";
  }
  return Notification.permission;
}

function useDelegateNotificationPreference(companyId: string | null) {
  const [enabled, setEnabled] = useState(() => isDelegateBrowserNotificationsEnabled(companyId));

  useEffect(() => {
    setEnabled(isDelegateBrowserNotificationsEnabled(companyId));
    if (!companyId) return;

    const sync = () => setEnabled(isDelegateBrowserNotificationsEnabled(companyId));
    const syncStorage = (event: StorageEvent) => {
      if (event.key === delegateNotificationStorageKey(companyId)) sync();
    };
    window.addEventListener(DELEGATE_NOTIFICATION_SETTINGS_EVENT, sync);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(DELEGATE_NOTIFICATION_SETTINGS_EVENT, sync);
      window.removeEventListener("storage", syncStorage);
    };
  }, [companyId]);

  return enabled;
}

function companyScopedNotificationHref(href: string) {
  const currentPrefix = window.location.pathname.split("/").filter(Boolean)[0];
  if (!currentPrefix || href === `/${currentPrefix}` || href.startsWith(`/${currentPrefix}/`)) return href;
  return `/${currentPrefix}${href.startsWith("/") ? href : `/${href}`}`;
}

async function readyServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => resolve(null), SERVICE_WORKER_READY_TIMEOUT_MS);
    void navigator.serviceWorker.ready.then(
      (registration) => {
        window.clearTimeout(timeoutId);
        resolve(registration);
      },
      () => {
        window.clearTimeout(timeoutId);
        resolve(null);
      },
    );
  });
}

async function deliverBrowserNotification(input: {
  body: string;
  href: string;
  onOpen: (href: string) => void;
  renotify?: boolean;
  tag: string;
  title: string;
}): Promise<"persistent" | "page"> {
  const options = {
    body: input.body,
    data: { href: companyScopedNotificationHref(input.href) },
    renotify: input.renotify,
    tag: input.tag,
  } as ExtendedNotificationOptions;

  const registration = await readyServiceWorkerRegistration();
  if (registration) {
    try {
      await registration.showNotification(input.title, options);
      const storedNotifications = await registration.getNotifications({ tag: input.tag });
      if (storedNotifications.some((notification) => notification.tag === input.tag)) {
        return "persistent";
      }
    } catch {
      // Hardened browsers can expose a service worker while rejecting its
      // notification API. Fall back to the page-level constructor below.
    }
  }

  const notification = new Notification(input.title, options);
  notification.onclick = () => {
    window.focus();
    input.onOpen(input.href);
    notification.close();
  };
  return "page";
}

async function showNotification(
  companyId: string,
  candidate: ReturnType<typeof getDueDelegateNotifications>[number],
  onOpen: (href: string) => void,
) {
  if (!claimDelegateNotification(companyId, candidate.key)) return;
  try {
    await deliverBrowserNotification({
      body: candidate.body,
      href: candidate.href,
      onOpen,
      tag: candidate.tag,
      title: candidate.title,
    });
  } catch {
    releaseDelegateNotification(companyId, candidate.key);
  }
}

export function DelegateBrowserNotificationCoordinator() {
  const { selectedCompanyId } = useCompany();
  const enabled = useDelegateNotificationPreference(selectedCompanyId);
  const navigate = useNavigate();
  const openTask = useCallback((href: string) => navigate(href), [navigate]);
  const issuesQuery = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "delegate-browser-notifications"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { includeRoutineExecutions: false }),
    enabled: Boolean(selectedCompanyId && enabled && currentPermission() === "granted"),
    refetchInterval: DELEGATE_NOTIFICATION_POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!selectedCompanyId || !enabled || currentPermission() !== "granted" || !issuesQuery.data) return;
    for (const candidate of getDueDelegateNotifications(issuesQuery.data, selectedCompanyId)) {
      void showNotification(selectedCompanyId, candidate, openTask);
    }
  }, [enabled, issuesQuery.data, openTask, selectedCompanyId]);

  return null;
}

export function DelegateBrowserNotificationControl() {
  const { selectedCompanyId } = useCompany();
  const enabled = useDelegateNotificationPreference(selectedCompanyId);
  const [permission, setPermission] = useState<BrowserPermission>(currentPermission);
  const [error, setError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [testDeliveryMode, setTestDeliveryMode] = useState<"persistent" | "page" | null>(null);

  useEffect(() => {
    const refresh = () => setPermission(currentPermission());
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const enable = async () => {
    if (!selectedCompanyId || currentPermission() === "unsupported") return;
    setError(null);
    try {
      const nextPermission = await Notification.requestPermission();
      setPermission(nextPermission);
      setDelegateBrowserNotificationsEnabled(selectedCompanyId, nextPermission === "granted");
    } catch {
      setError("Paperclip could not request notification permission. Try again from your browser settings.");
    }
  };

  const disable = () => {
    if (!selectedCompanyId) return;
    setDelegateBrowserNotificationsEnabled(selectedCompanyId, false);
    setError(null);
    setTestStatus("idle");
    setTestDeliveryMode(null);
  };

  const testNotification = async () => {
    setError(null);
    setTestStatus("sending");
    setTestDeliveryMode(null);
    try {
      const deliveryMode = await deliverBrowserNotification({
        body: "Ready and blocked work will appear here while Paperclip is open.",
        href: window.location.pathname,
        onOpen: () => window.focus(),
        renotify: true,
        tag: nextTestNotificationTag(),
        title: "Paperclip notifications are on",
      });
      setTestDeliveryMode(deliveryMode);
      setTestStatus("sent");
    } catch {
      setTestStatus("idle");
      setError("The browser could not show a notification. Check this site’s notification permission.");
    }
  };

  const unavailable = permission === "unsupported";
  const blocked = permission === "denied";
  const active = enabled && permission === "granted";
  const description = unavailable
    ? "This browser cannot show notifications for this page."
    : blocked
      ? "Notifications are blocked. Allow them in this site’s browser settings, then return here."
      : active
        ? "Ready and blocked work will notify you while Paperclip is open in a browser tab."
        : "Get a browser alert when work is blocked or reaches its review time.";

  return (
    <section className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between" aria-labelledby="browser-notifications-title">
      <div className="flex min-w-0 items-start gap-2">
        {active ? (
          <Bell className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <BellOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <h2 id="browser-notifications-title" className="text-sm font-medium text-foreground">
            Browser notifications
          </h2>
          <p className="text-xs text-muted-foreground">{description}</p>
          {testStatus === "sent" ? (
            <p className="mt-1 text-xs text-muted-foreground" role="status">
              {testDeliveryMode === "persistent"
                ? "Chrome stored the test notification. Check Notification Center if the banner is hidden."
                : "Chrome accepted a page notification, but persistent delivery was unavailable."}
            </p>
          ) : null}
          {error ? <p className="mt-1 text-xs text-destructive" role="alert">{error}</p> : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {active ? (
          <>
            <Button type="button" variant="outline" size="sm" onClick={testNotification} disabled={testStatus === "sending"}>
              {testStatus === "sending" ? "Sending…" : testStatus === "sent" ? "Send again" : "Send test"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={disable}>Turn off</Button>
          </>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={enable} disabled={unavailable || blocked || !selectedCompanyId}>
            Enable notifications
          </Button>
        )}
      </div>
    </section>
  );
}
