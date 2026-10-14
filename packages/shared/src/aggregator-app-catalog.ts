import composio from "./composio-search-catalog.json" with { type: "json" };
import arcade from "./arcade-app-catalog.json" with { type: "json" };

export type AppCatalogAggregator = "composio" | "arcade" | "executor";

export interface AggregatorAppRoute {
  provider: AppCatalogAggregator;
  toolkit: string;
  logoUrl: string;
  docsUrl: string;
}

export interface AggregatorAppCatalogEntry {
  slug: string;
  name: string;
  aliases: string[];
  routes: AggregatorAppRoute[];
}

// The public catalogs use different brand names for these same services.
const SERVICE_IDENTITY_ALIASES = new Map([
  ["closeio", "close"],
  ["microsoftexcel", "excel"],
  ["microsoftonedrive", "onedrive"],
  ["microsoftsharepoint", "sharepoint"],
  ["squareup", "square"],
  ["x", "twitter"],
]);

/** Public discovery metadata only. A listing does not establish app authorization. */
export function aggregatorAppIdentity(value: string): string {
  const identity = value.toLowerCase().replace(/\s+(mcp|api)$/i, "")
    .replace(/[^a-z0-9]/g, "");
  return SERVICE_IDENTITY_ALIASES.get(identity) ?? identity;
}

const entries = new Map<string, AggregatorAppCatalogEntry>();
function add(name: string, slug: string, aliases: string[], route: AggregatorAppRoute) {
  const identity = aggregatorAppIdentity(name);
  const existing = entries.get(identity);
  if (existing) {
    existing.aliases = [...new Set([...existing.aliases, name, slug, ...aliases])];
    // Prefer the ordinary toolkit over an API/MCP variant from the same provider.
    if (!existing.routes.some((candidate) => candidate.provider === route.provider)) {
      existing.routes.push(route);
    }
    return;
  }
  entries.set(identity, { slug, name: name.replace(/\s+(MCP|API)$/i, ""), aliases, routes: [route] });
}

for (const [toolkit, name] of composio.toolkits) {
  add(name, toolkit.replaceAll("_", "-").replace(/^-+/, ""), [toolkit], {
    provider: "composio", toolkit,
    logoUrl: `https://logos.composio.dev/api/${toolkit}`,
    docsUrl: `https://docs.composio.dev/toolkits/${toolkit}`,
  });
}
for (const app of arcade.apps) {
  add(app.name, app.slug, app.aliases, {
    provider: "arcade", toolkit: app.toolkit, logoUrl: app.logoUrl, docsUrl: app.docsUrl,
  });
}

export const AGGREGATOR_APP_CATALOG = [...entries.values()].sort((a, b) =>
  a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.slug.localeCompare(b.slug));

/** Include provider variants and native overlaps when checking existing accounts. */
export const COMPOSIO_APP_TOOLKITS = composio.toolkits.map(([toolkit]) => toolkit);

export function findComposioCatalogApp(toolkit: string) {
  return AGGREGATOR_APP_CATALOG.find(app => app.routes.some(route => route.provider === "composio")
    && (app.aliases.includes(toolkit) || app.routes.some(route => route.provider === "composio" && route.toolkit === toolkit)));
}

export function findAggregatorApp(provider: string, toolkit: string | null | undefined) {
  if (!toolkit) return undefined;
  return AGGREGATOR_APP_CATALOG.find((app) =>
    app.routes.some((route) => route.provider === provider)
      && (app.routes.some(route => route.provider === provider && route.toolkit === toolkit) || app.aliases.includes(toolkit)));
}

/** Executor supports custom integrations. Only exact known service identities share branding. */
export function resolveAggregatorApp(provider: AppCatalogAggregator, toolkit: string, name?: string) {
  const known = provider === "composio" ? findComposioCatalogApp(toolkit) : findAggregatorApp(provider, toolkit)
    ?? AGGREGATOR_APP_CATALOG.find(app => app.routes.some(route => route.provider === provider)
      && [app.slug, ...app.aliases].some(alias => aggregatorAppIdentity(alias) === aggregatorAppIdentity(toolkit)));
  if (known) return { slug: known.slug, name: known.name };
  if (provider === "executor") {
    const identity = aggregatorAppIdentity(toolkit);
    const match = AGGREGATOR_APP_CATALOG.find(app => [app.slug, ...app.aliases].some(alias => aggregatorAppIdentity(alias) === identity));
    if (match) return { slug: match.slug, name: match.name };
  }
  return { slug: `${provider}:${toolkit}`, name: name || toolkit };
}
