import { APP_DEFINITIONS } from "./app-definitions.generated.js";
import type { AppDefinition, ConnectionMethodDef, FieldDef } from "./types/app-definition.js";
import type { ToolConnectionOwnership } from "./types/tool-access.js";

const CONNECTABLE_APP_SLUGS = new Set([
  "zapier",
  "github",
  "slack",
  "notion",
  "posthog",
  "linear",
  "google-sheets",
  "context7",
]);

export const CONNECTABLE_APP_DEFINITIONS = APP_DEFINITIONS.filter((app) =>
  CONNECTABLE_APP_SLUGS.has(app.slug)
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

export function getAvailableConnectionMethod(
  app: AppDefinition,
  methodKey?: string | null,
): ConnectionMethodDef | null {
  const methods = getAvailableConnectionMethods(app);
  return methodKey ? methods.find((method) => method.key === methodKey) ?? null : methods[0] ?? null;
}

export function credentialConfigPath(field: FieldDef): string {
  return `credentials.${field.key}`;
}

export function recommendedDefaultsForApp(app: AppDefinition, methodKey?: string | null): Record<string, unknown> {
  void app;
  void methodKey;
  return {
    access: "all_agents",
    askFirstRiskLevels: [],
  };
}
