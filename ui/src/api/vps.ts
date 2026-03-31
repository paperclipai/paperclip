async function vpsPost<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/vps${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (payload as { error?: string } | null)?.error ?? `Request failed: ${res.status}`;
    throw new Error(message);
  }
  return payload as T;
}

async function vpsGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`/api/vps${path}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (payload as { error?: string } | null)?.error ?? `Request failed: ${res.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export const vpsApi = {
  bootstrapAdmin: () =>
    vpsPost<{ ok: boolean; userId: string; role: string }>("/bootstrap-admin"),

  getNetworkInfo: () =>
    vpsGet<{ ip: string; port: number }>("/network-info"),

  verifyDns: (domain: string) =>
    vpsPost<{
      domain: string;
      resolved: boolean;
      resolvedIps: string[];
      expectedIp: string;
      matches: boolean;
    }>("/verify-dns", { domain }),

  configureDomain: (domain: string) =>
    vpsPost<{ ok: boolean; domain: string; url: string; nextUrl: string; restartScheduled: boolean }>("/configure-domain", { domain }),

  skipDomain: () =>
    vpsPost<{ ok: boolean }>("/skip-domain"),
};
