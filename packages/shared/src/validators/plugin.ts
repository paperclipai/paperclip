import { z } from "zod";
import {
  PLUGIN_STATUSES,
  PLUGIN_CATEGORIES,
  PLUGIN_CAPABILITIES,
  PLUGIN_UI_SLOT_TYPES,
  PLUGIN_UI_SLOT_ENTITY_TYPES,
  PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS,
  PLUGIN_LAUNCHER_PLACEMENT_ZONES,
  PLUGIN_LAUNCHER_ACTIONS,
  PLUGIN_LAUNCHER_BOUNDS,
  PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS,
  PLUGIN_STATE_SCOPE_KINDS,
  PLUGIN_DATABASE_CORE_READ_TABLES,
  PLUGIN_API_ROUTE_AUTH_MODES,
  PLUGIN_API_ROUTE_CHECKOUT_POLICIES,
  PLUGIN_API_ROUTE_METHODS,
} from "../constants.js";

// ---------------------------------------------------------------------------
// JSON Schema placeholder – a permissive validator for JSON Schema objects
// ---------------------------------------------------------------------------

/**
 * Permissive validator for JSON Schema objects. Accepts any `Record<string, unknown>`
 * that contains at least a `type`, `$ref`, or composition keyword (`oneOf`/`anyOf`/`allOf`).
 * Empty objects are also accepted.
 *
 * Used to validate `instanceConfigSchema` and `parametersSchema` fields in the
 * plugin manifest without fully parsing JSON Schema.
 *
 * @see PLUGIN_SPEC.md §10.1 — Manifest shape
 */
export const jsonSchemaSchema = z.record(z.unknown()).refine(
  (val) => {
    // Must have a "type" field if non-empty, or be a valid JSON Schema object
    if (Object.keys(val).length === 0) return true;
    return typeof val.type === "string" || val.$ref !== undefined || val.oneOf !== undefined || val.anyOf !== undefined || val.allOf !== undefined;
  },
  { message: "Must be a valid JSON Schema object (requires at least a 'type', '$ref', or composition keyword)" },
);

// ---------------------------------------------------------------------------
// Manifest sub-type schemas
// ---------------------------------------------------------------------------

/**
 * Validates a {@link PluginJobDeclaration} — a scheduled job declared in the
 * plugin manifest. Requires `jobKey` and `displayName`; `description` and
 * `schedule` (cron expression) are optional.
 *
 * @see PLUGIN_SPEC.md §17 — Scheduled Jobs
 */
/**
 * Validates a cron expression has exactly 5 whitespace-separated fields,
 * each containing only valid cron characters (digits, *, /, -, ,).
 *
 * Valid tokens per field: *, N, N-M, N/S, * /S, N-M/S, and comma-separated lists.
 */
const CRON_FIELD_PATTERN = /^(\*(?:\/[0-9]+)?|[0-9]+(?:-[0-9]+)?(?:\/[0-9]+)?)(?:,(\*(?:\/[0-9]+)?|[0-9]+(?:-[0-9]+)?(?:\/[0-9]+)?))*$/;

function isValidCronExpression(expression: string): boolean {
  const trimmed = expression.trim();
  if (!trimmed) return false;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f) => CRON_FIELD_PATTERN.test(f));
}

export const pluginJobDeclarationSchema = z.object({
  jobKey: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  schedule: z.string().refine(
    (val) => isValidCronExpression(val),
    { message: "schedule must be a valid 5-field cron expression (e.g. '*/15 * * * *')" },
  ).optional(),
});

export type PluginJobDeclarationInput = z.infer<typeof pluginJobDeclarationSchema>;

/**
 * Validates a {@link PluginWebhookDeclaration} — a webhook endpoint declared
 * in the plugin manifest. Requires `endpointKey` and `displayName`.
 *
 * @see PLUGIN_SPEC.md §18 — Webhooks
 */
export const pluginWebhookDeclarationSchema = z.object({
  endpointKey: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
});

export type PluginWebhookDeclarationInput = z.infer<typeof pluginWebhookDeclarationSchema>;

/**
 * Validates a {@link PluginToolDeclaration} — an agent tool contributed by the
 * plugin. Requires `name`, `displayName`, `description`, and a valid
 * `parametersSchema`. Requires the `agent.tools.register` capability.
 *
 * @see PLUGIN_SPEC.md §11 — Agent Tools
 */
export const pluginToolDeclarationSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  parametersSchema: jsonSchemaSchema,
});

export type PluginToolDeclarationInput = z.infer<typeof pluginToolDeclarationSchema>;

/**
 * Validates a {@link PluginUiSlotDeclaration} — a UI extension slot the plugin
 * fills with a React component. Includes `superRefine` checks for slot-specific
 * requirements such as `entityTypes` for context-sensitive slots.
 *
 * @see PLUGIN_SPEC.md §19 — UI Extension Model
 */
export const pluginUiSlotDeclarationSchema = z.object({
  type: z.enum(PLUGIN_UI_SLOT_TYPES),
  id: z.string().min(1),
  displayName: z.string().min(1),
  exportName: z.string().min(1),
  entityTypes: z.array(z.enum(PLUGIN_UI_SLOT_ENTITY_TYPES)).optional(),
  routePath: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: "routePath must be a lowercase single-segment slug (letters, numbers, hyphens)",
  }).optional(),
  order: z.number().int().optional(),
}).superRefine((value, ctx) => {
  // context-sensitive slots require explicit entity targeting.
  const entityScopedTypes = ["detailTab", "taskDetailView", "contextMenuItem", "commentAnnotation", "commentContextMenuItem", "projectSidebarItem"];
  if (
    entityScopedTypes.includes(value.type)
    && (!value.entityTypes || value.entityTypes.length === 0)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${value.type} slots require at least one entityType`,
      path: ["entityTypes"],
    });
  }
  // projectSidebarItem only makes sense for entityType "project".
  if (value.type === "projectSidebarItem" && value.entityTypes && !value.entityTypes.includes("project")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "projectSidebarItem slots require entityTypes to include \"project\"",
      path: ["entityTypes"],
    });
  }
  // commentAnnotation only makes sense for entityType "comment".
  if (value.type === "commentAnnotation" && value.entityTypes && !value.entityTypes.includes("comment")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "commentAnnotation slots require entityTypes to include \"comment\"",
      path: ["entityTypes"],
    });
  }
  // commentContextMenuItem only makes sense for entityType "comment".
  if (value.type === "commentContextMenuItem" && value.entityTypes && !value.entityTypes.includes("comment")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "commentContextMenuItem slots require entityTypes to include \"comment\"",
      path: ["entityTypes"],
    });
  }
  if (value.routePath && value.type !== "page") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "routePath is only supported for page slots",
      path: ["routePath"],
    });
  }
  if (value.routePath && PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS.includes(value.routePath as (typeof PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS)[number])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `routePath "${value.routePath}" is reserved by the host`,
      path: ["routePath"],
    });
  }
});

export type PluginUiSlotDeclarationInput = z.infer<typeof pluginUiSlotDeclarationSchema>;

const entityScopedLauncherPlacementZones = [
  "detailTab",
  "taskDetailView",
  "contextMenuItem",
  "commentAnnotation",
  "commentContextMenuItem",
  "projectSidebarItem",
] as const;

const launcherBoundsByEnvironment: Record<
  (typeof PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS)[number],
  readonly (typeof PLUGIN_LAUNCHER_BOUNDS)[number][]
> = {
  hostInline: ["inline", "compact", "default"],
  hostOverlay: ["compact", "default", "wide", "full"],
  hostRoute: ["default", "wide", "full"],
  external: [],
  iframe: ["compact", "default", "wide", "full"],
};

/**
 * Validates the action payload for a declarative plugin launcher.
 */
export const pluginLauncherActionDeclarationSchema = z.object({
  type: z.enum(PLUGIN_LAUNCHER_ACTIONS),
  target: z.string().min(1),
  params: z.record(z.unknown()).optional(),
}).superRefine((value, ctx) => {
  if (value.type === "performAction" && value.target.includes("/")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "performAction launchers must target an action key, not a route or URL",
      path: ["target"],
    });
  }

  if (value.type === "navigate" && /^https?:\/\//.test(value.target)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "navigate launchers must target a host route, not an absolute URL",
      path: ["target"],
    });
  }
});

export type PluginLauncherActionDeclarationInput =
  z.infer<typeof pluginLauncherActionDeclarationSchema>;

/**
 * Validates optional render hints for a plugin launcher destination.
 */
export const pluginLauncherRenderDeclarationSchema = z.object({
  environment: z.enum(PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS),
  bounds: z.enum(PLUGIN_LAUNCHER_BOUNDS).optional(),
}).superRefine((value, ctx) => {
  if (!value.bounds) {
    return;
  }

  const supportedBounds = launcherBoundsByEnvironment[value.environment];
  if (!supportedBounds.includes(value.bounds)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `bounds "${value.bounds}" is not supported for render environment "${value.environment}"`,
      path: ["bounds"],
    });
  }
});

export type PluginLauncherRenderDeclarationInput =
  z.infer<typeof pluginLauncherRenderDeclarationSchema>;

/**
 * Validates declarative launcher metadata in a plugin manifest.
 */
export const pluginLauncherDeclarationSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  placementZone: z.enum(PLUGIN_LAUNCHER_PLACEMENT_ZONES),
  exportName: z.string().min(1).optional(),
  entityTypes: z.array(z.enum(PLUGIN_UI_SLOT_ENTITY_TYPES)).optional(),
  order: z.number().int().optional(),
  action: pluginLauncherActionDeclarationSchema,
  render: pluginLauncherRenderDeclarationSchema.optional(),
}).superRefine((value, ctx) => {
  if (
    entityScopedLauncherPlacementZones.some((zone) => zone === value.placementZone)
    && (!value.entityTypes || value.entityTypes.length === 0)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${value.placementZone} launchers require at least one entityType`,
      path: ["entityTypes"],
    });
  }

  if (
    value.placementZone === "projectSidebarItem"
    && value.entityTypes
    && !value.entityTypes.includes("project")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "projectSidebarItem launchers require entityTypes to include \"project\"",
      path: ["entityTypes"],
    });
  }

  if (value.action.type === "performAction" && value.render) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "performAction launchers cannot declare render hints",
      path: ["render"],
    });
  }

  if (
    ["openModal", "openDrawer", "openPopover"].includes(value.action.type)
    && !value.render
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${value.action.type} launchers require render metadata`,
      path: ["render"],
    });
  }

  if (value.action.type === "openModal" && value.render?.environment === "hostInline") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "openModal launchers cannot use the hostInline render environment",
      path: ["render", "environment"],
    });
  }

  if (
    value.action.type === "openDrawer"
    && value.render
    && !["hostOverlay", "iframe"].includes(value.render.environment)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "openDrawer launchers must use hostOverlay or iframe render environments",
      path: ["render", "environment"],
    });
  }

  if (value.action.type === "openPopover" && value.render?.environment === "hostRoute") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "openPopover launchers cannot use the hostRoute render environment",
      path: ["render", "environment"],
    });
  }
});

export type PluginLauncherDeclarationInput = z.infer<typeof pluginLauncherDeclarationSchema>;

export const pluginDatabaseDeclarationSchema = z.object({
  namespaceSlug: z.string().regex(/^[a-z0-9][a-z0-9_]*$/, {
    message: "namespaceSlug must be lowercase letters, digits, or underscores and start with a letter or digit",
  }).max(40).optional(),
  migrationsDir: z.string().min(1).refine(
    (value) => !value.startsWith("/") && !value.includes("..") && !/[\\]/.test(value),
    { message: "migrationsDir must be a relative package path without '..' or backslashes" },
  ),
  coreReadTables: z.array(z.enum(PLUGIN_DATABASE_CORE_READ_TABLES)).optional(),
});

export type PluginDatabaseDeclarationInput = z.infer<typeof pluginDatabaseDeclarationSchema>;

export const pluginApiRouteDeclarationSchema = z.object({
  routeKey: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message: "routeKey must be lowercase letters, digits, dots, colons, underscores, or hyphens",
  }),
  method: z.enum(PLUGIN_API_ROUTE_METHODS),
  path: z.string().min(1).regex(/^\/[a-zA-Z0-9:_./-]*$/, {
    message: "path must start with / and contain only path-safe literal or :param segments",
  }).refine(
    (value) =>
      !value.includes("..") &&
      !value.includes("//") &&
      value !== "/api" &&
      !value.startsWith("/api/") &&
      value !== "/plugins" &&
      !value.startsWith("/plugins/"),
    { message: "path must stay inside the plugin api namespace" },
  ),
  auth: z.enum(PLUGIN_API_ROUTE_AUTH_MODES),
  capability: z.literal("api.routes.register"),
  checkoutPolicy: z.enum(PLUGIN_API_ROUTE_CHECKOUT_POLICIES).optional(),
  companyResolution: z.discriminatedUnion("from", [
    z.object({ from: z.literal("body"), key: z.string().min(1) }),
    z.object({ from: z.literal("query"), key: z.string().min(1) }),
    z.object({ from: z.literal("issue"), param: z.string().min(1) }),
  ]).optional(),
});

export type PluginApiRouteDeclarationInput = z.infer<typeof pluginApiRouteDeclarationSchema>;

// ---------------------------------------------------------------------------
// Plugin Manifest V1 schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for {@link PaperclipPluginManifestV1} — the complete runtime
 * validator for plugin manifests read at install time.
 *
 * Field-level constraints (see PLUGIN_SPEC.md §10.1 for the normative rules):
 *
 * | Field                    | Type       | Constraints                                  |
 * |--------------------------|------------|----------------------------------------------|
 * | `id`                     | string     | `^[a-z0-9][a-z0-9._-]*$`                    |
 * | `apiVersion`             | literal 1  | must equal `PLUGIN_API_VERSION`              |
 * | `version`                | string     | semver (`\d+\.\d+\.\d+`)                    |
 * | `displayName`            | string     | 1–100 chars                                  |
 * | `description`            | string     | 1–500 chars                                  |
 * | `author`                 | string     | 1–200 chars                                  |
 * | `categories`             | enum[]     | at least one; values from PLUGIN_CATEGORIES  |
 * | `minimumHostVersion`     | string?    | semver lower bound if present, no leading `v`|
 * | `minimumPaperclipVersion`| string?    | legacy alias of `minimumHostVersion`         |
 * | `capabilities`           | enum[]     | at least one; values from PLUGIN_CAPABILITIES|
 * | `entrypoints.worker`     | string     | min 1 char                                   |
 * | `entrypoints.ui`         | string?    | required when `ui.slots` is declared         |
 *
 * Cross-field rules enforced via `superRefine`:
 * - `entrypoints.ui` required when `ui.slots` declared
 * - `agent.tools.register` capability required when `tools` declared
 * - `jobs.schedule` capability required when `jobs` declared
 * - `webhooks.receive` capability required when `webhooks` declared
 * - duplicate `jobs[].jobKey` values are rejected
 * - duplicate `webhooks[].endpointKey` values are rejected
 * - duplicate `tools[].name` values are rejected
 * - duplicate `ui.slots[].id` values are rejected
 *
 * @see PLUGIN_SPEC.md §10.1 — Manifest shape
 * @see {@link PaperclipPluginManifestV1} — the inferred TypeScript type
 */
export const pluginManifestV1Schema = z.object({
  id: z.string().min(1).regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "Plugin id must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, hyphens, or underscores",
  ),
  apiVersion: z.literal(1),
  version: z.string().min(1).regex(
    /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
    "Version must follow semver (e.g. 1.0.0 or 1.0.0-beta.1)",
  ),
  displayName: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  author: z.string().min(1).max(200),
  categories: z.array(z.enum(PLUGIN_CATEGORIES)).min(1),
  minimumHostVersion: z.string().regex(
    /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
    "minimumHostVersion must follow semver (e.g. 1.0.0)",
  ).optional(),
  minimumPaperclipVersion: z.string().regex(
    /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
    "minimumPaperclipVersion must follow semver (e.g. 1.0.0)",
  ).optional(),
  capabilities: z.array(z.enum(PLUGIN_CAPABILITIES)).min(1),
  entrypoints: z.object({
    worker: z.string().min(1),
    ui: z.string().min(1).optional(),
  }),
  instanceConfigSchema: jsonSchemaSchema.optional(),
  jobs: z.array(pluginJobDeclarationSchema).optional(),
  webhooks: z.array(pluginWebhookDeclarationSchema).optional(),
  tools: z.array(pluginToolDeclarationSchema).optional(),
  database: pluginDatabaseDeclarationSchema.optional(),
  apiRoutes: z.array(pluginApiRouteDeclarationSchema).optional(),
  launchers: z.array(pluginLauncherDeclarationSchema).optional(),
  ui: z.object({
    slots: z.array(pluginUiSlotDeclarationSchema).min(1).optional(),
    launchers: z.array(pluginLauncherDeclarationSchema).optional(),
  }).optional(),
}).superRefine((manifest, ctx) => {
  // ── Entrypoint ↔ UI slot consistency ──────────────────────────────────
  // Plugins that declare UI slots must also declare a UI entrypoint so the
  // host knows where to load the bundle from (PLUGIN_SPEC.md §10.1).
  const hasUiSlots = (manifest.ui?.slots?.length ?? 0) > 0;
  const hasUiLaunchers = (manifest.ui?.launchers?.length ?? 0) > 0;
  if ((hasUiSlots || hasUiLaunchers) && !manifest.entrypoints.ui) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "entrypoints.ui is required when ui.slots or ui.launchers are declared",
      path: ["entrypoints", "ui"],
    });
  }

  if (
    manifest.minimumHostVersion
    && manifest.minimumPaperclipVersion
    && manifest.minimumHostVersion !== manifest.minimumPaperclipVersion
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "minimumHostVersion and minimumPaperclipVersion must match when both are declared",
      path: ["minimumHostVersion"],
    });
  }

  // ── Capability ↔ feature declaration consistency ───────────────────────
  // The host enforces capabilities at install and runtime. A plugin must
  // declare every capability it needs up-front; silently having more features
  // than capabilities would cause runtime rejections.

  // tools require agent.tools.register (PLUGIN_SPEC.md §11)
  if (manifest.tools && manifest.tools.length > 0) {
    if (!manifest.capabilities.includes("agent.tools.register")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Capability 'agent.tools.register' is required when tools are declared",
        path: ["capabilities"],
      });
    }
  }

  // jobs require jobs.schedule (PLUGIN_SPEC.md §17)
  if (manifest.jobs && manifest.jobs.length > 0) {
    if (!manifest.capabilities.includes("jobs.schedule")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Capability 'jobs.schedule' is required when jobs are declared",
        path: ["capabilities"],
      });
    }
  }

  // webhooks require webhooks.receive (PLUGIN_SPEC.md §18)
  if (manifest.webhooks && manifest.webhooks.length > 0) {
    if (!manifest.capabilities.includes("webhooks.receive")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Capability 'webhooks.receive' is required when webhooks are declared",
        path: ["capabilities"],
      });
    }
  }

  if (manifest.apiRoutes && manifest.apiRoutes.length > 0) {
    if (!manifest.capabilities.includes("api.routes.register")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Capability 'api.routes.register' is required when apiRoutes are declared",
        path: ["capabilities"],
      });
    }
  }

  if (manifest.database) {
    const requiredCapabilities = [
      "database.namespace.migrate",
      "database.namespace.read",
    ] as const;
    for (const capability of requiredCapabilities) {
      if (!manifest.capabilities.includes(capability)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Capability '${capability}' is required when database migrations are declared`,
          path: ["capabilities"],
        });
      }
    }

    const coreReadTables = manifest.database.coreReadTables ?? [];
    const duplicates = coreReadTables.filter((table, i) => coreReadTables.indexOf(table) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate database coreReadTables: ${[...new Set(duplicates)].join(", ")}`,
        path: ["database", "coreReadTables"],
      });
    }
  }

  // ── Uniqueness checks ──────────────────────────────────────────────────
  // Duplicate keys within a plugin's own manifest are always a bug. The host
  // would not know which declaration takes precedence, so we reject early.

  // job keys must be unique within the plugin (used as identifiers in the DB)
  if (manifest.jobs) {
    const jobKeys = manifest.jobs.map((j) => j.jobKey);
    const duplicates = jobKeys.filter((key, i) => jobKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate job keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["jobs"],
      });
    }
  }

  // webhook endpoint keys must be unique within the plugin (used in routes)
  if (manifest.webhooks) {
    const endpointKeys = manifest.webhooks.map((w) => w.endpointKey);
    const duplicates = endpointKeys.filter((key, i) => endpointKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate webhook endpoint keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["webhooks"],
      });
    }
  }

  if (manifest.apiRoutes) {
    const routeKeys = manifest.apiRoutes.map((route) => route.routeKey);
    const duplicateKeys = routeKeys.filter((key, i) => routeKeys.indexOf(key) !== i);
    if (duplicateKeys.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate api route keys: ${[...new Set(duplicateKeys)].join(", ")}`,
        path: ["apiRoutes"],
      });
    }
    const routeSignatures = manifest.apiRoutes.map((route) => `${route.method} ${route.path}`);
    const duplicateRoutes = routeSignatures.filter((sig, i) => routeSignatures.indexOf(sig) !== i);
    if (duplicateRoutes.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate api routes: ${[...new Set(duplicateRoutes)].join(", ")}`,
        path: ["apiRoutes"],
      });
    }
  }

  // tool names must be unique within the plugin (namespaced at runtime)
  if (manifest.tools) {
    const toolNames = manifest.tools.map((t) => t.name);
    const duplicates = toolNames.filter((name, i) => toolNames.indexOf(name) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate tool names: ${[...new Set(duplicates)].join(", ")}`,
        path: ["tools"],
      });
    }
  }

  // UI slot ids must be unique within the plugin (namespaced at runtime)
  if (manifest.ui) {
    if (manifest.ui.slots) {
      const slotIds = manifest.ui.slots.map((s) => s.id);
      const duplicates = slotIds.filter((id, i) => slotIds.indexOf(id) !== i);
      if (duplicates.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate UI slot ids: ${[...new Set(duplicates)].join(", ")}`,
          path: ["ui", "slots"],
        });
      }
    }
  }

  // launcher ids must be unique within the plugin
  const allLaunchers = [
    ...(manifest.launchers ?? []),
    ...(manifest.ui?.launchers ?? []),
  ];
  if (allLaunchers.length > 0) {
    const launcherIds = allLaunchers.map((launcher) => launcher.id);
    const duplicates = launcherIds.filter((id, i) => launcherIds.indexOf(id) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate launcher ids: ${[...new Set(duplicates)].join(", ")}`,
        path: manifest.ui?.launchers ? ["ui", "launchers"] : ["launchers"],
      });
    }
  }
});

export type PluginManifestV1Input = z.infer<typeof pluginManifestV1Schema>;

// ---------------------------------------------------------------------------
// Plugin installation / registration request
// ---------------------------------------------------------------------------

/**
 * Schema for installing (registering) a plugin.
 * The server receives the packageName and resolves the manifest from the
 * installed package.
 */
export const installPluginSchema = z.object({
  packageName: z.string().min(1),
  version: z.string().min(1).optional(),
  /** Set by loader for local-path installs so the worker can be resolved. */
  packagePath: z.string().min(1).optional(),
});

export type InstallPlugin = z.infer<typeof installPluginSchema>;

// ---------------------------------------------------------------------------
// Plugin config (instance configuration) schemas
// ---------------------------------------------------------------------------

/**
 * Schema for creating or updating a plugin's instance configuration.
 * configJson is validated permissively here; runtime validation against
 * the plugin's instanceConfigSchema is done at the service layer.
 */
export const upsertPluginConfigSchema = z.object({
  configJson: z.record(z.unknown()),
});

export type UpsertPluginConfig = z.infer<typeof upsertPluginConfigSchema>;

/**
 * Schema for partially updating a plugin's instance configuration.
 * Allows a partial merge of config values.
 */
export const patchPluginConfigSchema = z.object({
  configJson: z.record(z.unknown()),
});

export type PatchPluginConfig = z.infer<typeof patchPluginConfigSchema>;

// ---------------------------------------------------------------------------
// Plugin status update
// ---------------------------------------------------------------------------

/**
 * Schema for updating a plugin's lifecycle status. Used by the lifecycle
 * manager to persist state transitions.
 *
 * @see {@link PLUGIN_STATUSES} for the valid status values
 */
export const updatePluginStatusSchema = z.object({
  status: z.enum(PLUGIN_STATUSES),
  lastError: z.string().nullable().optional(),
});

export type UpdatePluginStatus = z.infer<typeof updatePluginStatusSchema>;

// ---------------------------------------------------------------------------
// Plugin uninstall
// ---------------------------------------------------------------------------

/** Schema for the uninstall request. `removeData` controls hard vs soft delete. */
export const uninstallPluginSchema = z.object({
  removeData: z.boolean().optional().default(false),
});

export type UninstallPlugin = z.infer<typeof uninstallPluginSchema>;

// ---------------------------------------------------------------------------
// Plugin state (key-value storage) schemas
// ---------------------------------------------------------------------------

/**
 * Schema for a plugin state scope key — identifies the exact location where
 * state is stored. Used by the `ctx.state.get()`, `ctx.state.set()`, and
 * `ctx.state.delete()` SDK methods.
 *
 * @see PLUGIN_SPEC.md §21.3 `plugin_state`
 */
export const pluginStateScopeKeySchema = z.object({
  scopeKind: z.enum(PLUGIN_STATE_SCOPE_KINDS),
  scopeId: z.string().min(1).optional(),
  namespace: z.string().min(1).optional(),
  stateKey: z.string().min(1),
});

export type PluginStateScopeKey = z.infer<typeof pluginStateScopeKeySchema>;

/**
 * Schema for setting a plugin state value.
 */
export const setPluginStateSchema = z.object({
  scopeKind: z.enum(PLUGIN_STATE_SCOPE_KINDS),
  scopeId: z.string().min(1).optional(),
  namespace: z.string().min(1).optional(),
  stateKey: z.string().min(1),
  /** JSON-serializable value to store. */
  value: z.unknown(),
});

export type SetPluginState = z.infer<typeof setPluginStateSchema>;

/**
 * Schema for querying plugin state entries. All fields are optional to allow
 * flexible list queries (e.g. all state for a plugin within a scope).
 */
export const listPluginStateSchema = z.object({
  scopeKind: z.enum(PLUGIN_STATE_SCOPE_KINDS).optional(),
  scopeId: z.string().min(1).optional(),
  namespace: z.string().min(1).optional(),
});

export type ListPluginState = z.infer<typeof listPluginStateSchema>;
