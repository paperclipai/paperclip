import type { AppDefinition, AppReviewedTools } from "./types/app-definition.js";
import type { ToolRiskLevel } from "./constants.js";

/**
 * Plugin-provided connectors.
 *
 * A plugin declares connector types (`apps`) with the same schema as the
 * built-in app definitions. The host namespaces each slug by plugin key so a
 * plugin app can never shadow, or be shadowed by, a built-in app or another
 * plugin's app. The namespace is reversible: the owning plugin can be read
 * back from the slug alone, so availability checks never depend on extra
 * columns on connection rows.
 */
const PLUGIN_APP_SLUG = /^plugin-((?:[0-9a-f]{2})+)-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

const PLUGIN_KEY = /^[a-z0-9][a-z0-9._-]*$/;

/** Longest namespaced slug the connect API accepts (`galleryKey`). */
export const PLUGIN_APP_SLUG_MAX_LENGTH = 300;

export function pluginAppSlug(pluginKey: string, appSlug: string): string {
  const encoded = Array.from(pluginKey, (character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return `plugin-${encoded}-${appSlug}`;
}

export function parsePluginAppSlug(slug: unknown): { pluginKey: string; appSlug: string } | null {
  if (typeof slug !== "string") return null;
  const match = PLUGIN_APP_SLUG.exec(slug);
  if (!match) return null;
  const pluginKey = match[1]!.match(/../g)!.map((pair) => String.fromCharCode(parseInt(pair, 16))).join("");
  return PLUGIN_KEY.test(pluginKey) ? { pluginKey, appSlug: match[2]! } : null;
}

export function isPluginAppSlug(slug: unknown): boolean {
  return parsePluginAppSlug(slug) !== null;
}

/** The catalog entry the host serves for one app a plugin declares. */
export function pluginAppDefinition(pluginKey: string, app: AppDefinition): AppDefinition {
  const { plugin: _plugin, aiConnectionRouter: _router, experimentalFeatureKey: _feature, ...declared } = app;
  return {
    ...structuredClone(declared),
    slug: pluginAppSlug(pluginKey, app.slug),
    plugin: { pluginKey, appSlug: app.slug },
  };
}

/** The connector slug a saved connection or application row was created from. */
export function connectionSourceSlug(row: {
  config?: Record<string, unknown> | null;
  transportConfig?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}): string | null {
  for (const candidate of [
    row.config?.sourceTemplateKey,
    row.transportConfig?.sourceTemplateKey,
    row.metadata?.sourceTemplateKey,
    row.metadata?.galleryKey,
  ]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return null;
}

/**
 * Risk for one tool under a connector's reviewed tool list. Provider hints
 * that mark a tool destructive or writable win over the list, so a provider
 * can raise a tool's risk but never lower it below the review.
 */
export function reviewedToolRisk(
  review: AppReviewedTools,
  tool: { name: string; annotations?: Record<string, unknown> },
): ToolRiskLevel {
  const reviewed: ToolRiskLevel = review.destructive?.includes(tool.name) ? "destructive"
    : review.write?.includes(tool.name) ? "write"
      : review.read?.includes(tool.name) ? "read"
        : review.unlisted ?? "write";
  const annotations = tool.annotations ?? {};
  const hinted: ToolRiskLevel = annotations.destructiveHint === true || annotations.destructive === true ? "destructive"
    : annotations.readOnlyHint === false || annotations.writeHint === true ? "write"
      : "read";
  const rank = { read: 0, write: 1, destructive: 2 } as Record<string, number>;
  return (rank[hinted] ?? 0) > (rank[reviewed] ?? 0) ? hinted : reviewed;
}
