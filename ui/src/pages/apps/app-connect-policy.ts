import {
  APP_STORE_DEFINITIONS,
  appSupportsCatalogSetup,
  connectionMethodSupportsAutomaticOAuth,
  getAvailableConnectionMethods,
  getAppStoreDefinition,
  getConnectableAppDefinition,
} from "@paperclipai/shared";

export const MCP_DIRECT_OAUTH_CONNECT_SLUGS = APP_STORE_DEFINITIONS
  .filter((app) => getAvailableConnectionMethods(app).some((method) =>
    connectionMethodSupportsAutomaticOAuth(method)
  ))
  .map((app) => app.slug);

export function isMcpDirectOAuthConnectSlug(slug: string | null | undefined): boolean {
  return MCP_DIRECT_OAUTH_CONNECT_SLUGS.some((allowedSlug) => allowedSlug === slug);
}

export function appSourceConnectHref(slug: string, interactionId?: string | null): string {
  const params = new URLSearchParams({ source: slug });
  if (interactionId) params.set("intent", interactionId);
  return `/apps/connect?${params.toString()}`;
}

/** Resume one exact draft through the same setup wizard used for a new app. */
export function appSourceResumeHref(slug: string, connectionId: string): string {
  return `/apps/connect?${new URLSearchParams({ source: slug, resume: connectionId }).toString()}`;
}

export function vercelConnectSourceHref(slug?: string): string {
  if (!slug) return "/apps/vercel-connect";
  return `/apps/vercel-connect?${new URLSearchParams({ source: slug }).toString()}`;
}

export function resolveAppsConnectRouteKey(input: {
  serviceSlug?: string | null;
  appKey?: string | null;
  sourceSlug?: string | null;
}): string | undefined {
  return input.serviceSlug ?? input.appKey ?? input.sourceSlug ?? undefined;
}

export function canEnterAppsConnect(searchParams: URLSearchParams): boolean {
  if (searchParams.get("byo") === "1") {
    // The old BYO discovery page has moved to the Connectors list. Keep only
    // exact custom-connection reconnects using this legacy query contract.
    return Boolean(
      searchParams.get("reconnect")?.trim()
      && searchParams.get("applicationId")?.trim()
      && searchParams.get("link")?.trim(),
    );
  }
  const source = searchParams.get("source") ?? "";
  const entry = getAppStoreDefinition(source);
  // A retained connection may belong to a provider hidden from fresh catalog
  // setup. Admit only known providers here; the setup flow then proves the
  // exact reconnect target is visible to the selected company before rendering.
  if (getConnectableAppDefinition(source) && searchParams.get("reconnect")?.trim()) return true;
  return appSupportsCatalogSetup(entry);
}
