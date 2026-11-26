function readSameOriginOAuthCallback(
  popup: Window | null,
  connectionId: string,
): { url: URL; outcome: "connected" | "denied" | "failed" | "waiting" } | null {
  if (!popup || popup.closed) return null;
  try {
    const url = new URL(popup.location.href);
    if (url.origin !== window.location.origin) return null;
    if (!url.pathname.split("/").includes(connectionId)
      && url.searchParams.get("resume") !== connectionId
      && url.searchParams.get("reconnect") !== connectionId) return null;
    const outcome = url.searchParams.get("oauth");
    if (outcome === "denied" || outcome === "failed") {
      return { url, outcome };
    }
    const connected = url.searchParams.get("success") === "1"
      || url.pathname.endsWith(`/apps/${connectionId}/permissions`);
    return { url, outcome: connected ? "connected" : "waiting" };
  } catch {
    return null;
  }
}

export function readOAuthWindowOutcome(
  popup: Window | null,
  connectionId: string,
): "waiting" | "closed" | "connected" | "denied" | "failed" {
  if (!popup) return "waiting";
  if (popup.closed) return "closed";
  return readSameOriginOAuthCallback(popup, connectionId)?.outcome ?? "waiting";
}

export function readOAuthWindowFailureDetails(
  popup: Window | null,
  connectionId: string,
): { code: string | null; providerError: string | null } | null {
  const callback = readSameOriginOAuthCallback(popup, connectionId);
  if (!callback || (callback.outcome !== "denied" && callback.outcome !== "failed")) return null;
  return {
    code: callback.url.searchParams.get("code"),
    providerError: callback.url.searchParams.get("provider_error"),
  };
}
