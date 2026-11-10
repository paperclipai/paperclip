import {
  DASHBOARD_GRID_COLUMNS,
  DASHBOARD_LAYOUT_SCHEMA_VERSION,
  DASHBOARD_MAX_ROW_SPAN,
  DASHBOARD_MAX_WIDGETS,
  type DashboardLayout,
  type DashboardWidgetPlacement,
} from "@paperclipai/shared";

export interface WidgetSize {
  w: number;
  h: number;
}

export type WidgetSettingDefinition =
  | { key: string; label: string; type: "number"; min: number; max: number; default: number }
  | { key: string; label: string; type: "boolean"; default: boolean };

export interface WidgetMeta {
  id: string;
  title: string;
  description: string;
  dataSource: string;
  defaultSize: WidgetSize;
  minSize: WidgetSize;
  settings?: readonly WidgetSettingDefinition[];
}

export type WidgetCatalog = ReadonlyMap<string, WidgetMeta>;

export function clampSize(size: WidgetSize, meta: WidgetMeta | undefined): WidgetSize {
  const minW = meta?.minSize.w ?? 1;
  const minH = meta?.minSize.h ?? 1;
  return {
    w: Math.min(DASHBOARD_GRID_COLUMNS, Math.max(minW, Math.round(size.w))),
    h: Math.min(DASHBOARD_MAX_ROW_SPAN, Math.max(minH, Math.round(size.h))),
  };
}

export function createPlacement(meta: WidgetMeta, instanceId: string): DashboardWidgetPlacement {
  return { instanceId, widgetId: meta.id, ...clampSize(meta.defaultSize, meta) };
}

export function buildDefaultLayout(defaultWidgetIds: readonly string[], catalog: WidgetCatalog): DashboardLayout {
  const widgets: DashboardWidgetPlacement[] = [];
  for (const id of defaultWidgetIds) {
    const meta = catalog.get(id);
    if (meta) widgets.push(createPlacement(meta, id));
  }
  return { schemaVersion: DASHBOARD_LAYOUT_SCHEMA_VERSION, widgets, contextualRules: {} };
}

export function normalizeLayout(layout: DashboardLayout, catalog: WidgetCatalog): DashboardLayout {
  let changed = false;
  const widgets: DashboardWidgetPlacement[] = [];
  for (const placement of layout.widgets) {
    const meta = catalog.get(placement.widgetId);
    if (!meta) {
      changed = true;
      continue;
    }
    const size = clampSize(placement, meta);
    if (size.w !== placement.w || size.h !== placement.h) {
      changed = true;
      widgets.push({ ...placement, ...size });
    } else {
      widgets.push(placement);
    }
  }
  return changed ? { ...layout, widgets } : layout;
}

function uniqueInstanceId(layout: DashboardLayout, widgetId: string): string {
  const taken = new Set(layout.widgets.map((widget) => widget.instanceId));
  if (!taken.has(widgetId)) return widgetId;
  let counter = 2;
  while (taken.has(`${widgetId}-${counter}`)) counter += 1;
  return `${widgetId}-${counter}`;
}

export function addWidget(layout: DashboardLayout, meta: WidgetMeta): DashboardLayout {
  if (layout.widgets.length >= DASHBOARD_MAX_WIDGETS) return layout;
  const placement = createPlacement(meta, uniqueInstanceId(layout, meta.id));
  return { ...layout, widgets: [...layout.widgets, placement] };
}

export function removeWidget(layout: DashboardLayout, instanceId: string): DashboardLayout {
  const widgets = layout.widgets.filter((widget) => widget.instanceId !== instanceId);
  return widgets.length === layout.widgets.length ? layout : { ...layout, widgets };
}

export function moveWidget(layout: DashboardLayout, instanceId: string, targetInstanceId: string): DashboardLayout {
  const from = layout.widgets.findIndex((widget) => widget.instanceId === instanceId);
  const to = layout.widgets.findIndex((widget) => widget.instanceId === targetInstanceId);
  if (from < 0 || to < 0 || from === to) return layout;
  const widgets = [...layout.widgets];
  const [moved] = widgets.splice(from, 1);
  widgets.splice(to, 0, moved!);
  return { ...layout, widgets };
}

export function resizeWidget(
  layout: DashboardLayout,
  instanceId: string,
  size: WidgetSize,
  catalog: WidgetCatalog,
): DashboardLayout {
  const index = layout.widgets.findIndex((widget) => widget.instanceId === instanceId);
  if (index < 0) return layout;
  const current = layout.widgets[index]!;
  const next = clampSize(size, catalog.get(current.widgetId));
  if (next.w === current.w && next.h === current.h) return layout;
  const widgets = [...layout.widgets];
  widgets[index] = { ...current, ...next };
  return { ...layout, widgets };
}

export function setWidgetConfig(
  layout: DashboardLayout,
  instanceId: string,
  key: string,
  value: string | number | boolean,
): DashboardLayout {
  const index = layout.widgets.findIndex((widget) => widget.instanceId === instanceId);
  if (index < 0) return layout;
  const current = layout.widgets[index]!;
  if (current.config?.[key] === value) return layout;
  const widgets = [...layout.widgets];
  widgets[index] = { ...current, config: { ...current.config, [key]: value } };
  return { ...layout, widgets };
}

export function effectiveColumnSpan(w: number, columns: number): number {
  return Math.max(1, Math.min(w, columns));
}

export function widgetSetting<T extends number | boolean>(
  placement: DashboardWidgetPlacement,
  definition: WidgetSettingDefinition & { default: T },
): T {
  const value = placement.config?.[definition.key];
  if (definition.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return definition.default;
    return Math.min(definition.max, Math.max(definition.min, Math.round(value))) as T;
  }
  return (typeof value === "boolean" ? value : definition.default) as T;
}
