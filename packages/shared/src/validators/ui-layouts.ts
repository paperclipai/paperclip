import { z } from "zod";

export const UI_LAYOUT_SURFACES = ["agent_graph", "dashboard"] as const;
export const UI_LAYOUT_MAX_BYTES = 262_144;

export const AGENT_GRAPH_LAYOUT_SCHEMA_VERSION = 1;
export const AGENT_GRAPH_MAX_POSITIONS = 5_000;
export const AGENT_GRAPH_MAX_STICKIES = 200;
export const AGENT_GRAPH_MAX_DRAFTS = 50;
export const AGENT_GRAPH_STICKY_TEXT_MAX = 2_000;
export const AGENT_GRAPH_STICKY_COLORS = ["yellow", "blue", "green", "pink", "gray"] as const;
export const AGENT_GRAPH_DIRECTIONS = ["TB", "LR"] as const;

export const DASHBOARD_LAYOUT_SCHEMA_VERSION = 1;
export const DASHBOARD_MAX_WIDGETS = 60;
export const DASHBOARD_GRID_COLUMNS = 4;
export const DASHBOARD_MAX_ROW_SPAN = 6;

const coordinateSchema = z.number().finite().min(-1_000_000).max(1_000_000);
const idSchema = z.string().trim().min(1).max(64);

function hasUniqueIds(items: Array<{ id: string }>): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}

const pointSchema = z.object({ x: coordinateSchema, y: coordinateSchema }).strict();

export const agentGraphStickySchema = z.object({
  id: idSchema,
  x: coordinateSchema,
  y: coordinateSchema,
  width: z.number().finite().min(80).max(1_200),
  height: z.number().finite().min(60).max(1_200),
  text: z.string().max(AGENT_GRAPH_STICKY_TEXT_MAX),
  color: z.enum(AGENT_GRAPH_STICKY_COLORS),
}).strict();

export const agentGraphDraftSchema = z.object({
  id: idSchema,
  x: coordinateSchema,
  y: coordinateSchema,
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(64),
  title: z.string().max(200).nullable(),
  capabilities: z.string().max(4_000).nullable(),
  adapterType: z.string().trim().min(1).max(64),
  model: z.string().max(512).nullable(),
  reportsTo: z.string().guid().nullable(),
  sourceAgentId: z.string().guid().nullable(),
}).strict();

export const agentGraphLayoutSchema = z.object({
  schemaVersion: z.literal(AGENT_GRAPH_LAYOUT_SCHEMA_VERSION),
  direction: z.enum(AGENT_GRAPH_DIRECTIONS),
  viewport: z.object({
    x: coordinateSchema,
    y: coordinateSchema,
    zoom: z.number().finite().min(0.05).max(4),
  }).strict().nullable(),
  positions: z.record(z.string().guid(), pointSchema).refine(
    (value) => Object.keys(value).length <= AGENT_GRAPH_MAX_POSITIONS,
    { message: `At most ${AGENT_GRAPH_MAX_POSITIONS} node positions are allowed` },
  ),
  hiddenAgentIds: z.array(z.string().guid()).max(AGENT_GRAPH_MAX_POSITIONS),
  stickies: z.array(agentGraphStickySchema).max(AGENT_GRAPH_MAX_STICKIES).refine(
    hasUniqueIds,
    { message: "Sticky note ids must be unique" },
  ),
  drafts: z.array(agentGraphDraftSchema).max(AGENT_GRAPH_MAX_DRAFTS).refine(
    hasUniqueIds,
    { message: "Hire draft ids must be unique" },
  ),
}).strict();

export const AGENT_GRAPH_CLIPBOARD_KIND = "paperclip.agent-graph";
export const AGENT_GRAPH_CLIPBOARD_VERSION = 1;

export const agentGraphClipboardAgentSchema = agentGraphDraftSchema
  .omit({ id: true, sourceAgentId: true })
  .extend({ sourceAgentId: z.string().guid() })
  .strict();

export const agentGraphClipboardStickySchema = agentGraphStickySchema.omit({ id: true }).strict();

export const agentGraphClipboardSchema = z.object({
  kind: z.literal(AGENT_GRAPH_CLIPBOARD_KIND),
  version: z.literal(AGENT_GRAPH_CLIPBOARD_VERSION),
  agents: z.array(agentGraphClipboardAgentSchema).max(AGENT_GRAPH_MAX_DRAFTS),
  stickies: z.array(agentGraphClipboardStickySchema).max(AGENT_GRAPH_MAX_STICKIES),
}).strict();

export type AgentGraphClipboard = z.infer<typeof agentGraphClipboardSchema>;
export type AgentGraphClipboardAgent = z.infer<typeof agentGraphClipboardAgentSchema>;
export type AgentGraphSticky = z.infer<typeof agentGraphStickySchema>;
export type AgentGraphDraft = z.infer<typeof agentGraphDraftSchema>;
export type AgentGraphLayout = z.infer<typeof agentGraphLayoutSchema>;

const widgetConfigValueSchema = z.union([z.string().max(200), z.number().finite(), z.boolean()]);

export const dashboardWidgetPlacementSchema = z.object({
  instanceId: idSchema,
  widgetId: idSchema,
  w: z.number().int().min(1).max(DASHBOARD_GRID_COLUMNS),
  h: z.number().int().min(1).max(DASHBOARD_MAX_ROW_SPAN),
  config: z.record(z.string().max(64), widgetConfigValueSchema).refine(
    (value) => Object.keys(value).length <= 20,
    { message: "At most 20 widget settings are allowed" },
  ).optional(),
}).strict();

export const dashboardLayoutSchema = z.object({
  schemaVersion: z.literal(DASHBOARD_LAYOUT_SCHEMA_VERSION),
  widgets: z.array(dashboardWidgetPlacementSchema).max(DASHBOARD_MAX_WIDGETS).refine(
    (value) => new Set(value.map((widget) => widget.instanceId)).size === value.length,
    { message: "Widget instance ids must be unique" },
  ),
  contextualRules: z.record(z.string().max(64), z.boolean()).refine(
    (value) => Object.keys(value).length <= 20,
    { message: "At most 20 contextual rules are allowed" },
  ),
}).strict();

export type DashboardWidgetPlacement = z.infer<typeof dashboardWidgetPlacementSchema>;
export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;

export const uiLayoutSurfaceSchema = z.enum(UI_LAYOUT_SURFACES);

const UI_LAYOUT_SCHEMAS = {
  agent_graph: agentGraphLayoutSchema,
  dashboard: dashboardLayoutSchema,
} as const;

export function uiLayoutByteLength(layout: unknown): number {
  return new TextEncoder().encode(JSON.stringify(layout) ?? "").length;
}

export type ParsedUiLayout =
  | { ok: true; layout: AgentGraphLayout | DashboardLayout; schemaVersion: number }
  | { ok: false; error: string };

export function parseUiLayoutForSurface(surface: (typeof UI_LAYOUT_SURFACES)[number], input: unknown): ParsedUiLayout {
  if (uiLayoutByteLength(input) > UI_LAYOUT_MAX_BYTES) {
    return { ok: false, error: `Layout exceeds ${UI_LAYOUT_MAX_BYTES} bytes` };
  }
  const parsed = UI_LAYOUT_SCHEMAS[surface].safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return { ok: false, error: `Invalid ${surface} layout: ${path}${issue?.message ?? "validation failed"}` };
  }
  return { ok: true, layout: parsed.data, schemaVersion: parsed.data.schemaVersion };
}

export const upsertUiLayoutSchema = z.object({
  layout: z.unknown(),
}).strict();

export type UpsertUiLayout = z.infer<typeof upsertUiLayoutSchema>;

type LayoutMigration = (input: Record<string, unknown>) => Record<string, unknown>;

const AGENT_GRAPH_MIGRATIONS: Record<number, LayoutMigration> = {
  0: (input) => ({
    schemaVersion: 1,
    direction: input.direction === "LR" ? "LR" : "TB",
    viewport: input.viewport ?? null,
    positions: input.positions ?? {},
    hiddenAgentIds: input.hiddenAgentIds ?? [],
    stickies: input.stickies ?? [],
    drafts: input.drafts ?? [],
  }),
};

const DASHBOARD_MIGRATIONS: Record<number, LayoutMigration> = {
  0: (input) => ({
    schemaVersion: 1,
    widgets: input.widgets ?? [],
    contextualRules: input.contextualRules ?? {},
  }),
};

function migrateLayout(
  input: unknown,
  currentVersion: number,
  migrations: Record<number, LayoutMigration>,
): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  let document = input as Record<string, unknown>;
  let version = typeof document.schemaVersion === "number" && Number.isInteger(document.schemaVersion)
    ? document.schemaVersion
    : 0;
  if (version > currentVersion || version < 0) return null;
  while (version < currentVersion) {
    const migrate = migrations[version];
    if (!migrate) return null;
    document = migrate(document);
    version += 1;
  }
  return document;
}

export function resolveAgentGraphLayout(input: unknown): AgentGraphLayout | null {
  const migrated = migrateLayout(input, AGENT_GRAPH_LAYOUT_SCHEMA_VERSION, AGENT_GRAPH_MIGRATIONS);
  if (migrated === null) return null;
  const parsed = parseUiLayoutForSurface("agent_graph", migrated);
  return parsed.ok ? (parsed.layout as AgentGraphLayout) : null;
}

export function resolveDashboardLayout(input: unknown): DashboardLayout | null {
  const migrated = migrateLayout(input, DASHBOARD_LAYOUT_SCHEMA_VERSION, DASHBOARD_MIGRATIONS);
  if (migrated === null) return null;
  const parsed = parseUiLayoutForSurface("dashboard", migrated);
  return parsed.ok ? (parsed.layout as DashboardLayout) : null;
}
