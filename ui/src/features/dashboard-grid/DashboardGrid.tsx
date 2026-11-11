import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { Check, LayoutDashboard, Plus, RotateCcw, Sparkles } from "lucide-react";
import { DASHBOARD_GRID_COLUMNS, DASHBOARD_MAX_WIDGETS, resolveDashboardLayout, type DashboardLayout } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { UiLayoutNotice } from "@/components/UiLayoutNotice";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useUiLayout, type UiLayoutSaveState } from "@/hooks/useUiLayout";
import { DASHBOARD_ROW_HEIGHT_REM, DashboardGridItem } from "./DashboardGridItem";
import {
  CONTEXTUAL_RULES,
  addWidget,
  buildDefaultLayout,
  isRuleEnabled,
  moveWidget,
  normalizeLayout,
  pinContextualWidget,
  removeWidget,
  resizeWidget,
  resolveVisibleWidgets,
  setRuleEnabled,
  setWidgetConfig,
  type WidgetSize,
} from "./lib/dashboard-layout";
import { deriveDashboardSignals } from "./lib/signals";
import { DEFAULT_WIDGET_IDS, WIDGET_CATALOG, WIDGET_DEFINITIONS, WIDGET_REGISTRY } from "./registry";
import { useCompanyAgents, useCompanyLiveRuns, useDashboardSummary } from "./widgets/data";

const COLUMN_QUERIES: ReadonlyArray<{ query: string; columns: number }> = [
  { query: "(min-width: 1280px)", columns: DASHBOARD_GRID_COLUMNS },
  { query: "(min-width: 768px)", columns: 2 },
];

function readColumns(): number {
  if (typeof window === "undefined" || !window.matchMedia) return DASHBOARD_GRID_COLUMNS;
  for (const entry of COLUMN_QUERIES) if (window.matchMedia(entry.query).matches) return entry.columns;
  return 1;
}

function subscribeColumns(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const lists = COLUMN_QUERIES.map((entry) => window.matchMedia(entry.query));
  for (const list of lists) list.addEventListener("change", onChange);
  return () => {
    for (const list of lists) list.removeEventListener("change", onChange);
  };
}

export function useDashboardColumns(): number {
  return useSyncExternalStore(subscribeColumns, readColumns, () => DASHBOARD_GRID_COLUMNS);
}

const SAVE_LABELS: Record<UiLayoutSaveState, string> = {
  idle: "",
  pending: "Unsaved changes",
  saving: "Saving…",
  saved: "Layout saved",
  error: "Layout not saved",
};

function resolveStoredLayout(raw: unknown): DashboardLayout | null {
  const resolved = resolveDashboardLayout(raw);
  return resolved ? normalizeLayout(resolved, WIDGET_CATALOG) : null;
}

export function DashboardGrid({ companyId }: { companyId: string }) {
  const { stored, isLoaded, save, reset, resetting, saveState, saveError, retrySave, blocked, loadError, allowOverwrite, retryLoad } = useUiLayout({
    companyId,
    surface: "dashboard",
    resolve: resolveStoredLayout,
  });
  const defaultLayout = useMemo(() => buildDefaultLayout(DEFAULT_WIDGET_IDS, WIDGET_CATALOG), []);
  const [layout, setLayout] = useState<DashboardLayout | null>(null);
  const layoutRef = useRef<DashboardLayout | null>(null);
  const [editing, setEditing] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const columns = useDashboardColumns();

  const wasBlocked = useRef(false);

  useEffect(() => {
    if (!isLoaded) return;
    const recovered = wasBlocked.current && blocked === null && stored !== null;
    wasBlocked.current = blocked !== null;
    if (layoutRef.current && !recovered) return;
    const initial = stored ?? defaultLayout;
    layoutRef.current = initial;
    setLayout(initial);
  }, [isLoaded, stored, blocked, defaultLayout]);

  const update = useCallback(
    (change: (current: DashboardLayout) => DashboardLayout) => {
      const current = layoutRef.current;
      if (!current) return;
      const next = change(current);
      if (next === current) return;
      layoutRef.current = next;
      setLayout(next);
      save(next);
    },
    [save],
  );

  const summary = useDashboardSummary(companyId);
  const liveRuns = useCompanyLiveRuns(companyId);
  const agents = useCompanyAgents(companyId);
  const signals = useMemo(
    () => deriveDashboardSignals({ summary: summary.data, liveRuns: liveRuns.data, agents: agents.data }),
    [summary.data, liveRuns.data, agents.data],
  );
  const visible = useMemo(
    () => (layout ? resolveVisibleWidgets(layout, signals, WIDGET_CATALOG) : []),
    [layout, signals],
  );
  const sortableIds = useMemo(
    () => visible.filter((item) => item.contextualRuleId === null).map((item) => item.placement.instanceId),
    [visible],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!event.over || event.active.id === event.over.id) return;
      update((current) => moveWidget(current, String(event.active.id), String(event.over!.id)));
    },
    [update],
  );
  const onResize = useCallback(
    (instanceId: string, size: WidgetSize) => update((current) => resizeWidget(current, instanceId, size, WIDGET_CATALOG)),
    [update],
  );
  const onRemove = useCallback((instanceId: string) => update((current) => removeWidget(current, instanceId)), [update]);
  const onPin = useCallback((ruleId: string) => update((current) => pinContextualWidget(current, ruleId, WIDGET_CATALOG)), [update]);
  const onConfigChange = useCallback(
    (instanceId: string, key: string, value: number | boolean) =>
      update((current) => setWidgetConfig(current, instanceId, key, value)),
    [update],
  );
  const restoreDefault = useCallback(() => {
    layoutRef.current = defaultLayout;
    setLayout(defaultLayout);
    reset();
  }, [defaultLayout, reset]);

  if (!layout) {
    return <div className="h-64 animate-pulse rounded-lg bg-muted" aria-label="Loading dashboard layout" />;
  }

  const atLimit = layout.widgets.length >= DASHBOARD_MAX_WIDGETS;

  return (
    <section className="flex flex-col gap-3" aria-label="Dashboard widgets" data-testid="dashboard-grid">
      <UiLayoutNotice
        blocked={blocked}
        error={loadError}
        subject="dashboard"
        onRetry={retryLoad}
        onOverwrite={allowOverwrite}
        saveError={saveError}
        onRetrySave={retrySave}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span
          role="status"
          aria-live="polite"
          className={saveState === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
        >
          {blocked ? "" : SAVE_LABELS[saveState]}
        </span>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm">
              <Sparkles aria-hidden />
              Automatic widgets
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="flex w-80 flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Automatic widgets appear while something needs attention and leave when it ends. Pin one to keep it.
            </p>
            {CONTEXTUAL_RULES.map((rule) => (
              <label key={rule.id} className="flex items-start justify-between gap-3 text-sm">
                <span className="flex flex-col">
                  {rule.label}
                  <span className="text-xs text-muted-foreground">{rule.description}</span>
                </span>
                <ToggleSwitch
                  checked={isRuleEnabled(layout, rule.id)}
                  onCheckedChange={(checked) => update((current) => setRuleEnabled(current, rule.id, checked))}
                  aria-label={rule.label}
                />
              </label>
            ))}
          </PopoverContent>
        </Popover>
        {editing ? (
          <>
            <Button variant="outline" size="sm" disabled={atLimit} onClick={() => setCatalogOpen(true)}>
              <Plus aria-hidden />
              Add widget
            </Button>
            <Button variant="outline" size="sm" disabled={blocked !== null || resetting} onClick={restoreDefault}>
              <RotateCcw aria-hidden />
              Restore default
            </Button>
            <Button size="sm" onClick={() => setEditing(false)}>
              <Check aria-hidden />
              Done
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <LayoutDashboard aria-hidden />
            Customize
          </Button>
        )}
      </div>

      {visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          This dashboard has no widgets. Choose Customize, then Add widget or Restore default.
        </p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
            <div
              className="grid gap-4"
              style={{
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gridAutoRows: `${DASHBOARD_ROW_HEIGHT_REM}rem`,
                gridAutoFlow: "row dense",
              }}
            >
              {visible.map((item) => {
                const definition = WIDGET_REGISTRY.get(item.placement.widgetId);
                if (!definition) return null;
                return (
                  <DashboardGridItem
                    key={item.placement.instanceId}
                    item={item}
                    definition={definition}
                    companyId={companyId}
                    columns={columns}
                    editing={editing}
                    onResize={onResize}
                    onRemove={onRemove}
                    onPin={onPin}
                    onConfigChange={onConfigChange}
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <Dialog open={catalogOpen} onOpenChange={setCatalogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a widget</DialogTitle>
            <DialogDescription>Widgets are added at the end of your dashboard. Drag them to move them.</DialogDescription>
          </DialogHeader>
          <ul className="flex max-h-96 flex-col divide-y divide-border overflow-y-auto" aria-label="Widget catalog">
            {WIDGET_DEFINITIONS.map((definition) => (
              <li key={definition.id} className="flex items-center justify-between gap-3 py-2">
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium">{definition.title}</span>
                  <span className="text-xs text-muted-foreground">{definition.description}</span>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={atLimit}
                  aria-label={`Add ${definition.title}`}
                  onClick={() => update((current) => addWidget(current, definition))}
                >
                  <Plus aria-hidden />
                  Add
                </Button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </section>
  );
}
