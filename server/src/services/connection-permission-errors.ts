/** Only explicit protocol error codes establish insufficient consent. Never echo provider bodies. */
export function isInsufficientConnectionScope(response: Pick<Response, "status" | "headers">, body?: string): boolean {
  if (response.status !== 401 && response.status !== 403) return false;
  if (/\berror\s*=\s*"?insufficient_scope\b/i.test(response.headers.get("www-authenticate") ?? "")) return true;
  if (!body) return false;
  try {
    const payload = JSON.parse(body);
    return payload?.error === "insufficient_scope" || payload?.error?.code === "insufficient_scope"
      || payload?.error?.data?.code === "insufficient_scope";
  } catch { return false; }
}
export const INSUFFICIENT_CONNECTION_SCOPE_MESSAGE = "The provider has not granted the permissions needed for this action. Reconnect this connection and allow the required read and write access.";
