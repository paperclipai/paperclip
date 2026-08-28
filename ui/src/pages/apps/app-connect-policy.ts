/** OAuth apps that are safe to connect directly through the MCP OAuth broker. */
export const MCP_DIRECT_OAUTH_CONNECT_SLUGS = ["notion"] as const;

export function isMcpDirectOAuthConnectSlug(slug: string | null | undefined): boolean {
  return MCP_DIRECT_OAUTH_CONNECT_SLUGS.some((allowedSlug) => allowedSlug === slug);
}

export function appSourceConnectHref(slug: string, interactionId?: string | null): string {
  const params = new URLSearchParams({ source: slug });
  if (interactionId) params.set("intent", interactionId);
  return `/apps/connect?${params.toString()}`;
}

export function canEnterAppsConnect(searchParams: URLSearchParams): boolean {
  return searchParams.get("byo") === "1" || isMcpDirectOAuthConnectSlug(searchParams.get("source"));
}
