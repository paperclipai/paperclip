export type TailscaleLoginStatus = { status: "authorizing" | "needs_approval" | "connected"; authorizationUrl?: string };

export function parseTailscaleLoginStatus(value: unknown): TailscaleLoginStatus {
  const status = value as { BackendState?: unknown; AuthURL?: unknown } | null;
  if (status?.BackendState === "Running") return { status: "connected" };
  if (status?.BackendState === "NeedsMachineAuth") return { status: "needs_approval" };
  if (typeof status?.AuthURL === "string" && status.AuthURL) {
    const url = new URL(status.AuthURL);
    if (url.origin !== "https://login.tailscale.com" || url.username || url.password || url.search || url.hash
      || !/^\/a\/[a-zA-Z0-9_-]+$/.test(url.pathname)) throw new Error("Invalid Tailscale sign-in address");
    return { status: "authorizing", authorizationUrl: url.toString() };
  }
  return { status: "authorizing" };
}
