import { useState, useEffect, useCallback } from "react";
import { pushApi, type PushSubscriptionRecord } from "@/api/push";

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

export type PushState =
  | { status: "unsupported" }
  | { status: "insecure" }
  | { status: "loading" }
  | { status: "denied" }
  | { status: "subscribed"; endpoint: string }
  | { status: "unsubscribed" }
  | { status: "error"; message: string };

export function usePushNotifications(companyId: string | null | undefined) {
  const [state, setState] = useState<PushState>({ status: "loading" });
  const [isToggling, setIsToggling] = useState(false);
  const [subscriptions, setSubscriptions] = useState<PushSubscriptionRecord[]>([]);

  const refreshSubscriptions = useCallback(async () => {
    if (!companyId) {
      setSubscriptions([]);
      return [];
    }
    const result = await pushApi.listSubscriptions(companyId);
    setSubscriptions(result.subscriptions);
    return result.subscriptions;
  }, [companyId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        if (!companyId) {
          if (!cancelled) setState({ status: "error", message: "Select a company before enabling push notifications" });
          return;
        }
        const serverSubscriptions = await refreshSubscriptions();

        if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
          if (!cancelled) setState({ status: "unsupported" });
          return;
        }
        if (!window.isSecureContext) {
          if (!cancelled) setState({ status: "insecure" });
          return;
        }

        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        if (cancelled) return;
        if (existing) {
          const existsOnServer = serverSubscriptions.some((sub) => sub.endpoint === existing.endpoint);
          if (existsOnServer) {
            setState({ status: "subscribed", endpoint: existing.endpoint });
          } else {
            await existing.unsubscribe();
            if (!cancelled) setState({ status: "unsubscribed" });
          }
        } else if (Notification.permission === "denied") {
          setState({ status: "denied" });
        } else {
          setState({ status: "unsubscribed" });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Failed to read push state",
          });
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [companyId, refreshSubscriptions]);

  const enable = useCallback(async () => {
    if (isToggling) return;
    setIsToggling(true);
    try {
      if (!companyId) {
        throw new Error("Select a company before enabling push notifications");
      }
      const permission = await Notification.requestPermission();
      if (permission === "denied") {
        setState({ status: "denied" });
        return;
      }
      if (permission !== "granted") {
        setState({ status: "unsubscribed" });
        return;
      }

      const { vapidPublicKey } = await pushApi.getVapidPublicKey();
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });

      const json = sub.toJSON();
      const keys = json.keys ?? {};
      if (!keys.p256dh || !keys.auth) {
        await sub.unsubscribe().catch(() => undefined);
        throw new Error("Browser did not provide valid push credentials");
      }
      try {
        await pushApi.subscribe(companyId, {
          endpoint: sub.endpoint,
          p256dh: keys.p256dh,
          auth: keys.auth,
          deviceLabel: navigator.userAgent.slice(0, 120),
        });
      } catch (err) {
        await sub.unsubscribe().catch(() => undefined);
        throw err;
      }

      setState({ status: "subscribed", endpoint: sub.endpoint });
      await refreshSubscriptions();
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to enable push notifications",
      });
    } finally {
      setIsToggling(false);
    }
  }, [companyId, isToggling, refreshSubscriptions]);

  const disable = useCallback(async () => {
    if (isToggling) return;
    setIsToggling(true);
    try {
      if (!companyId) {
        throw new Error("Select a company before disabling push notifications");
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const endpoint = sub?.endpoint ?? (state.status === "subscribed" ? state.endpoint : undefined);
      if (sub) {
        const unsubscribed = await sub.unsubscribe();
        if (!unsubscribed) {
          throw new Error("Browser failed to unsubscribe this device");
        }
      }
      if (endpoint) {
        await pushApi.unsubscribe(companyId, endpoint);
      }
      setState({ status: "unsubscribed" });
      await refreshSubscriptions();
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to disable push notifications",
      });
    } finally {
      setIsToggling(false);
    }
  }, [companyId, isToggling, refreshSubscriptions, state]);

  return { state, isToggling, subscriptions, refreshSubscriptions, enable, disable };
}
