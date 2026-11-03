/** A callback is only a signal to re-read the connection from the server. */
export function readOAuthWindowOutcome(
  popup: Window | null,
  connectionId: string,
): "waiting" | "closed" | "connected" | "denied" | "failed" {
  if (!popup) return "waiting"; // A native fallback link has no window handle.
  if (popup.closed) return "closed";
  try {
    const url = new URL(popup.location.href);
    if (url.origin !== window.location.origin) return "waiting";
    if (!url.pathname.split("/").includes(connectionId)
      && url.searchParams.get("resume") !== connectionId
      && url.searchParams.get("reconnect") !== connectionId) return "waiting";
    const outcome = url.searchParams.get("oauth");
    if (outcome === "denied" || outcome === "failed") return outcome;
    // AppDetail consumes success=1 on mount. The exact permissions route is
    // also the durable callback destination after that query flag is removed.
    // Callers must still verify the saved connection before reporting success.
    return url.searchParams.get("success") === "1"
      || url.pathname.endsWith(`/apps/${connectionId}/permissions`)
      ? "connected" : "waiting";
  } catch {
    // Reading location is forbidden while the window is at the provider.
    return "waiting";
  }
}
