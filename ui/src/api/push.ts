// Web Push subscription API client (TON-2312).

export interface VapidPublicKeyResponse {
  configured: boolean;
  publicKey: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    ...init,
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : null) ?? `Request failed: ${res.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export const pushApi = {
  getVapidPublicKey: () => request<VapidPublicKeyResponse>("/push/vapid-public-key"),

  subscribe: (subscription: PushSubscriptionJSON) =>
    request<{ ok: true }>("/push/subscribe", {
      method: "POST",
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        keys: subscription.keys,
      }),
    }),

  unsubscribe: (endpoint: string) =>
    request<{ ok: true }>("/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint }),
    }),
};
