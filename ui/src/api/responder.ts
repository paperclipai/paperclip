export type ResponderStatus = "acknowledged" | "en_route" | "on_scene" | "cleared";

export const RESPONDER_STATUS_LABELS: Record<ResponderStatus, string> = {
  acknowledged: "Acknowledged",
  en_route: "En Route",
  on_scene: "On Scene",
  cleared: "Cleared",
};

export const RESPONDER_STATUS_ORDER: ResponderStatus[] = [
  "acknowledged",
  "en_route",
  "on_scene",
  "cleared",
];

export interface ResponderStatusUpdate {
  id: string;
  alertId: string;
  companyId: string;
  status: ResponderStatus;
  responderId: string | null;
  responderName: string | null;
  note: string | null;
  eta: string | null;
  lat: number | null;
  lng: number | null;
  createdAt: string;
}

export interface WebPushSubscription {
  id: string;
  companyId: string;
  responderId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
  updatedAt: string;
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export async function postResponderStatus(
  alertId: string,
  input: { status: ResponderStatus; responderId?: string; responderName?: string; note?: string; eta?: string; lat?: number; lng?: number },
): Promise<ResponderStatusUpdate> {
  return apiFetch<ResponderStatusUpdate>(`/api/solaris/alerts/${encodeURIComponent(alertId)}/responder-status`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchResponderStatus(
  alertId: string,
  responderId?: string,
): Promise<{ updates: ResponderStatusUpdate[]; latestStatus: ResponderStatus | null }> {
  const url = new URL(`/api/solaris/alerts/${encodeURIComponent(alertId)}/responder-status`, window.location.origin);
  if (responderId) url.searchParams.set("responderId", responderId);
  return apiFetch<{ updates: ResponderStatusUpdate[]; latestStatus: ResponderStatus | null }>(url.toString());
}

export async function fetchVapidPublicKey(): Promise<string | null> {
  const data = await apiFetch<{ vapidPublicKey: string | null }>("/api/solaris/push/vapid-public-key");
  return data.vapidPublicKey;
}

export async function savePushSubscription(
  companyId: string,
  input: { responderId: string; endpoint: string; p256dh: string; auth: string },
): Promise<WebPushSubscription> {
  const url = new URL("/api/solaris/push/subscribe", window.location.origin);
  url.searchParams.set("companyId", companyId);
  return apiFetch<WebPushSubscription>(url.toString(), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function deletePushSubscription(subscriptionId: string): Promise<void> {
  await apiFetch<void>(`/api/solaris/push/subscribe/${encodeURIComponent(subscriptionId)}`, { method: "DELETE" });
}
