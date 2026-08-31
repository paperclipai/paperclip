import { APP_DEFINITIONS } from "./app-definitions.generated.js";
import { SELF_SERVE_MCP_CANDIDATES } from "./self-serve-mcp-research.js";
import type { AppDefinition, ConnectionMethodDef, FieldDef } from "./types/app-definition.js";
import type { ToolConnectionOwnership } from "./types/tool-access.js";

export const CONNECTABLE_APP_SLUGS = new Set([
  ...SELF_SERVE_MCP_CANDIDATES.map((entry) => entry.slug),
  "zapier",
  "github",
  "slack",
  "notion",
  "posthog",
  "linear",
  "google-sheets",
  "context7",
  "shopify",
  "composio",
  "gmail",
  "google-drive",
  "google-docs",
  "google-slides",
  "google-calendar",
  "google-chat",
  "google-people",
  "google-workspace-search",
]);

export const CONNECTABLE_APP_DEFINITIONS = APP_DEFINITIONS.filter((app) =>
  CONNECTABLE_APP_SLUGS.has(app.slug)
);

/**
 * Definitions retained for existing connections and later verification, but
 * intentionally withheld from the customer-facing store. Keeping visibility
 * separate from recognition avoids breaking saved connections when a provider
 * is pulled from Browse or reserved for a future first-party experience.
 */
export const APP_STORE_HIDDEN_SLUGS = new Set([
  "beehiiv",
  "bitly",
  "brex",
  "candid",
  "coda",
  "composio",
  "context7",
  "egnyte",
  "embat",
  "github",
  "kernel",
  "local-falcon",
  "make",
  "manufact",
  "oreilly",
  "planetscale",
  "razorpay",
  "sanity",
  "similarweb",
  "slack",
  "ticket-tailor",
  "ticktick",
  "xero",
]);

export const APP_STORE_DEFINITIONS = CONNECTABLE_APP_DEFINITIONS.filter((app) =>
  !APP_STORE_HIDDEN_SLUGS.has(app.slug)
);

export const DEFAULT_OWNERSHIP_AVAILABILITY: Record<ToolConnectionOwnership, boolean> = {
  platform_shared: false,
  platform_provisioned: false,
  customer: true,
  dcr: true,
};

export function getConnectableAppDefinition(slug: string): AppDefinition | null {
  return CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === slug) ?? null;
}

export function getAppStoreDefinition(slug: string): AppDefinition | null {
  return APP_STORE_DEFINITIONS.find((app) => app.slug === slug) ?? null;
}

export function isAppStoreVisibleSlug(slug: string | null | undefined): boolean {
  return Boolean(slug && !APP_STORE_HIDDEN_SLUGS.has(slug) && CONNECTABLE_APP_SLUGS.has(slug));
}

function wildcardPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function getAppDefinitionForUrl(
  link: string,
  definitions: readonly AppDefinition[] = CONNECTABLE_APP_DEFINITIONS,
): AppDefinition | null {
  let normalized: string;
  try {
    normalized = new URL(link.trim()).toString();
  } catch {
    return null;
  }
  return definitions.find((app) =>
    app.urlPatterns.some((pattern) => wildcardPatternToRegExp(pattern).test(normalized))
  ) ?? null;
}

export function getAvailableConnectionMethods(app: AppDefinition): ConnectionMethodDef[] {
  const availability = app.ownershipAvailability ?? DEFAULT_OWNERSHIP_AVAILABILITY;
  return app.methods.filter((method) =>
    method.ownershipModes.some((ownership) => availability[ownership] !== false)
  );
}

/**
 * Pick the method that gives a new connection the app's useful write surface.
 *
 * Google Workspace publishes separate read and write capability groups. The
 * read method is intentionally listed first for documentation, but treating
 * array order as a product default silently created read-only connections and
 * left every write action Off. Capability metadata is the durable signal; apps
 * without an explicit write/draft capability retain their declared order.
 */
export function getRecommendedConnectionMethod(
  methods: readonly ConnectionMethodDef[],
): ConnectionMethodDef | null {
  return methods.find((method) => {
    const capabilityKey = method.capabilityProfile?.key;
    return capabilityKey === "write" || capabilityKey === "draft";
  }) ?? methods[0] ?? null;
}

export function getAvailableConnectionMethod(
  app: AppDefinition,
  methodKey?: string | null,
): ConnectionMethodDef | null {
  const methods = getAvailableConnectionMethods(app);
  return methodKey
    ? methods.find((method) => method.key === methodKey) ?? null
    : getRecommendedConnectionMethod(methods);
}

export function connectionMethodSupportsAutomaticOAuth(method: ConnectionMethodDef | null | undefined): boolean {
  return method?.auth === "oauth" && (
    (method.oauthStrategy === "paperclip_cloud_connector" || method.oauthStrategy === "paperclip_id_connector")
    || method.ownershipModes.includes("dcr")
  );
}

export function connectionMethodAcceptsCustomerOAuthClient(method: ConnectionMethodDef | null | undefined): boolean {
  return method?.auth === "oauth"
    && !method.oauthStrategy
    && method.ownershipModes.includes("customer");
}

export function connectionMethodSupportsCatalogSetup(method: ConnectionMethodDef | null | undefined): boolean {
  if (!method) return false;
  if (method.auth === "none" || method.auth === "api_key") return true;
  return connectionMethodSupportsAutomaticOAuth(method)
    || connectionMethodAcceptsCustomerOAuthClient(method);
}

export function connectionMethodRequiresConfiguration(method: ConnectionMethodDef | null | undefined): boolean {
  if (!method) return false;
  const visibleTenantFields = method.tenantFields?.filter((field) => !field.hidden) ?? [];
  const visibleExtensionFields = method.extensionFields?.filter((field) => !field.hidden) ?? [];
  return Boolean(
    method.credentialFields?.length
    || visibleTenantFields.length
    || visibleExtensionFields.length
    || method.configRequirements?.atLeastOneOf?.length
    // "Use your own OAuth app" is an advanced alternative when DCR/CIMD is
    // available, not a required setup field. Only customer-client-only methods
    // must stop on the configuration screen.
    || (
      connectionMethodAcceptsCustomerOAuthClient(method)
      && !connectionMethodSupportsAutomaticOAuth(method)
    ),
  );
}

export function appSupportsCatalogSetup(app: AppDefinition | null | undefined): boolean {
  return Boolean(app && getAvailableConnectionMethods(app).some(connectionMethodSupportsCatalogSetup));
}

export function isConnectableAppSlug(slug: string | null | undefined): boolean {
  return Boolean(slug && CONNECTABLE_APP_SLUGS.has(slug));
}

export function appSupportsAutomaticOAuth(app: AppDefinition | null | undefined): boolean {
  return Boolean(app && getAvailableConnectionMethods(app).some(connectionMethodSupportsAutomaticOAuth));
}

export function appAcceptsCustomerOAuthClient(app: AppDefinition | null | undefined): boolean {
  return Boolean(app && getAvailableConnectionMethods(app).some(connectionMethodAcceptsCustomerOAuthClient));
}

export function credentialConfigPath(field: FieldDef): string {
  return `credentials.${field.key}`;
}

export function resolveConnectionMethodServerUrl(
  method: ConnectionMethodDef,
  configValues: Record<string, string | boolean>,
): string | null {
  const template = method.defaults?.serverUrlTemplate;
  if (!template) return method.defaults?.serverUrl ?? null;

  let missingValue = false;
  const resolved = template.replace(/\{([a-zA-Z0-9_-]+)\}/g, (_placeholder, key: string) => {
    const value = configValues[key];
    if (value === undefined || String(value).trim().length === 0) {
      missingValue = true;
      return "";
    }
    return encodeURIComponent(String(value).trim());
  });
  if (missingValue) return null;

  try {
    return new URL(resolved).toString();
  } catch {
    return null;
  }
}

export function recommendedDefaultsForApp(app: AppDefinition, methodKey?: string | null): Record<string, unknown> {
  const normalizedMethodKey = app.slug === "gmail" && methodKey === "paperclip-id-oauth" ? "paperclip-draft" : methodKey;
  const method = normalizedMethodKey
    ? app.methods.find((candidate) => candidate.key === normalizedMethodKey) ?? null
    : getAvailableConnectionMethod(app, null);
  return {
    access: "all_agents",
    askFirstRiskLevels: method && method.riskTier !== "S1" ? ["write", "destructive"] : [],
  };
}
