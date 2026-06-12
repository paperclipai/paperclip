// Browser-side Web Push helpers (TON-2312).
import { pushApi } from "@/api/push";

/**
 * Web Push and service workers require a secure context (HTTPS), except on
 * localhost. When the control plane is served over plain HTTP (e.g. port-based
 * Tailscale access without certs), the APIs are unavailable and we surface a
 * clear "needs HTTPS" message instead of a generic "unsupported" one.
 */
export function isSecureContextAvailable(): boolean {
  return typeof window !== "undefined" && window.isSecureContext === true;
}

/** Whether this browser supports the APIs required for Web Push. */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    isSecureContextAvailable() &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * iOS only delivers Web Push when the app is installed to the home screen and
 * launched in standalone mode. We surface this caveat in the UI.
 */
export function isStandaloneDisplayMode(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  const displayStandalone =
    typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
  return iosStandalone || displayStandalone;
}

export function currentPermission(): NotificationPermission {
  if (typeof Notification === "undefined") return "default";
  return Notification.permission;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/** Returns the active push subscription endpoint, if any. */
export async function getExistingSubscriptionEndpoint(): Promise<string | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub?.endpoint ?? null;
}

/**
 * Request notification permission, subscribe via PushManager using the
 * server's VAPID public key, and persist the subscription server-side.
 * Throws with a human-readable message on failure.
 */
export async function enablePushNotifications(): Promise<void> {
  if (!isPushSupported()) {
    throw new Error("This browser does not support push notifications.");
  }

  const { configured, publicKey } = await pushApi.getVapidPublicKey();
  if (!configured || !publicKey) {
    throw new Error("Push notifications are not configured on this server yet.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const subscription =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  await pushApi.subscribe(subscription.toJSON());
}

/** Unsubscribe locally and remove the subscription server-side. */
export async function disablePushNotifications(): Promise<void> {
  if (!isPushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const { endpoint } = sub;
  await sub.unsubscribe().catch(() => {});
  await pushApi.unsubscribe(endpoint);
}
