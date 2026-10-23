import { useState, useEffect, useCallback } from "react";
import { pushApi } from "@/api/push";

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

export function usePushNotifications() {
  const [state, setState] = useState<PushState>({ status: "loading" });
  const [isToggling, setIsToggling] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setState({ status: "unsupported" });
      return;
    }
    if (!window.isSecureContext) {
      setState({ status: "insecure" });
      return;
    }

    navigator.serviceWorker.ready
      .then(async (reg) => {
        const existing = await reg.pushManager.getSubscription();
        if (existing) {
          setState({ status: "subscribed", endpoint: existing.endpoint });
        } else if (Notification.permission === "denied") {
          setState({ status: "denied" });
        } else {
          setState({ status: "unsubscribed" });
        }
      })
      .catch((err) => {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to read push state",
        });
      });
  }, []);

  const enable = useCallback(async () => {
    if (isToggling) return;
    setIsToggling(true);
    try {
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
      await pushApi.subscribe({
        endpoint: sub.endpoint,
        p256dh: keys.p256dh ?? "",
        auth: keys.auth ?? "",
        deviceLabel: navigator.userAgent.slice(0, 120),
      });

      setState({ status: "subscribed", endpoint: sub.endpoint });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to enable push notifications",
      });
    } finally {
      setIsToggling(false);
    }
  }, [isToggling]);

  const disable = useCallback(async () => {
    if (isToggling) return;
    setIsToggling(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await pushApi.unsubscribe(sub.endpoint);
        await sub.unsubscribe();
      }
      setState({ status: "unsubscribed" });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to disable push notifications",
      });
    } finally {
      setIsToggling(false);
    }
  }, [isToggling]);

  return { state, isToggling, enable, disable };
}
