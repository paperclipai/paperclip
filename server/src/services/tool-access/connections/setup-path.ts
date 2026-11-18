/** Relative destination shared by agent handoffs and saved setup cards. */
export function toolConnectionSetupPath(prefix: string, connection: {
  id: string; status?: string; credentialSource: string;
}, source?: string | null, interactionId?: string) {
  return `/${encodeURIComponent(prefix)}/apps/${connection.credentialSource === "vercel_connect" ? "vercel-connect" : "connect"}?${new URLSearchParams({
    [connection.status === "draft" ? "resume" : "reconnect"]: connection.id,
    ...(source ? { source } : {}), ...(interactionId ? { intent: interactionId } : {}),
  })}`;
}
