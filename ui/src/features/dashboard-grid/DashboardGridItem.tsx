import { Suspense, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Minus, Pin, Plus, Settings2, Sparkles, X } from "lucide-react";
import { DASHBOARD_GRID_COLUMNS, DASHBOARD_MAX_ROW_SPAN } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "@/lib/utils";
import { effectiveColumnSpan, widgetSetting, type VisibleWidget, type WidgetSize } from "./lib/dashboard-layout";
import type { WidgetDefinition } from "./registry";

export const DASHBOARD_ROW_HEIGHT_REM = 7;

function SizeStepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <span className="flex items-center gap-0.5" role="group" aria-label={label}>
      <Button variant="ghost" size="icon-xs" aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}>
        <Minus aria-hidden />
      </Button>
      <span className="w-4 text-center font-mono text-xs" aria-live="polite">{value}</span>
      <Button variant="ghost" size="icon-xs" aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Plus aria-hidden />
      </Button>
    </span>
  );
}

export function DashboardGridItem({
  item,
  definition,
  companyId,
  columns,
  editing,
  onResize,
  onRemove,
  onPin,
  onConfigChange,
}: {
  item: VisibleWidget;
  definition: WidgetDefinition;
  companyId: string;
  columns: number;
  editing: boolean;
  onResize: (instanceId: string, size: WidgetSize) => void;
  onRemove: (instanceId: string) => void;
  onPin: (ruleId: string) => void;
  onConfigChange: (instanceId: string, key: string, value: number | boolean) => void;
}) {
  const { placement, contextualRuleId, highlighted } = item;
  const contextual = contextualRuleId !== null;
  const sortable = useSortable({ id: placement.instanceId, disabled: !editing || contextual });
  const elementRef = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<WidgetSize | null>(null);
  const size = preview ?? placement;
  const span = effectiveColumnSpan(size.w, columns);

  const style: CSSProperties = {
    gridColumn: `span ${span} / span ${span}`,
    gridRow: `span ${size.h} / span ${size.h}`,
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };

  const startResize = (event: PointerEvent<HTMLButtonElement>) => {
    const element = elementRef.current;
    if (!element) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const rect = element.getBoundingClientRect();
    const cellWidth = rect.width / effectiveColumnSpan(placement.w, columns);
    const cellHeight = rect.height / placement.h;
    const origin = { x: event.clientX, y: event.clientY };
    let next: WidgetSize = { w: placement.w, h: placement.h };
    const move = (moveEvent: globalThis.PointerEvent) => {
      next = {
        w: Math.min(DASHBOARD_GRID_COLUMNS, Math.max(definition.minSize.w, Math.round(placement.w + (moveEvent.clientX - origin.x) / cellWidth))),
        h: Math.min(DASHBOARD_MAX_ROW_SPAN, Math.max(definition.minSize.h, Math.round(placement.h + (moveEvent.clientY - origin.y) / cellHeight))),
      };
      setPreview(next);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      setPreview(null);
      onResize(placement.instanceId, next);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  return (
    <div
      ref={(node) => {
        elementRef.current = node;
        sortable.setNodeRef(node);
      }}
      style={style}
      data-testid="dashboard-widget"
      data-widget-id={placement.widgetId}
      data-contextual={contextual ? "true" : undefined}
      data-highlighted={highlighted ? "true" : undefined}
      className={cn(
        "relative flex min-w-0 flex-col rounded-lg",
        sortable.isDragging && "z-10 opacity-80",
        highlighted && "ring-2 ring-primary/60 ring-offset-2 ring-offset-background",
        editing && "border border-dashed border-muted-foreground",
      )}
    >
      {contextual ? (
        <div className="flex items-center justify-between gap-2 px-1 pb-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Sparkles className="size-3" aria-hidden />
            Shown automatically
          </span>
          <Button variant="ghost" size="xs" onClick={() => onPin(contextualRuleId)}>
            <Pin aria-hidden />
            Pin to dashboard
          </Button>
        </div>
      ) : null}
      {editing && !contextual ? (
        <div className="flex flex-wrap items-center gap-1 border-b border-dashed border-muted-foreground bg-muted/50 px-1 py-0.5">
          <button
            type="button"
            className="cursor-grab rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={`Move ${definition.title}`}
            {...sortable.attributes}
            {...sortable.listeners}
          >
            <GripVertical className="size-4" aria-hidden />
          </button>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{definition.title}</span>
          <SizeStepper
            label={`${definition.title} width`}
            value={placement.w}
            min={definition.minSize.w}
            max={DASHBOARD_GRID_COLUMNS}
            onChange={(w) => onResize(placement.instanceId, { w, h: placement.h })}
          />
          <SizeStepper
            label={`${definition.title} height`}
            value={placement.h}
            min={definition.minSize.h}
            max={DASHBOARD_MAX_ROW_SPAN}
            onChange={(h) => onResize(placement.instanceId, { w: placement.w, h })}
          />
          {definition.settings?.length ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={`${definition.title} settings`}>
                  <Settings2 aria-hidden />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="flex w-64 flex-col gap-3">
                {definition.settings.map((setting) => (
                  <label key={setting.key} className="flex items-center justify-between gap-3 text-sm">
                    {setting.label}
                    {setting.type === "number" ? (
                      <input
                        type="number"
                        className="w-20 rounded-md border border-input bg-background px-2 py-1 text-sm"
                        min={setting.min}
                        max={setting.max}
                        value={widgetSetting(placement, setting)}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (Number.isFinite(value)) {
                            onConfigChange(placement.instanceId, setting.key, Math.min(setting.max, Math.max(setting.min, Math.round(value))));
                          }
                        }}
                      />
                    ) : (
                      <ToggleSwitch
                        checked={widgetSetting(placement, setting)}
                        onCheckedChange={(checked) => onConfigChange(placement.instanceId, setting.key, checked)}
                        aria-label={setting.label}
                      />
                    )}
                  </label>
                ))}
              </PopoverContent>
            </Popover>
          ) : null}
          <Button variant="ghost" size="icon-xs" aria-label={`Remove ${definition.title}`} onClick={() => onRemove(placement.instanceId)}>
            <X aria-hidden />
          </Button>
        </div>
      ) : null}
      <div className={cn("min-h-0 flex-1 overflow-hidden [&>*]:h-full", editing && "pointer-events-none p-1")}>
        <Suspense fallback={<div className="h-full animate-pulse rounded-lg bg-muted" aria-label={`Loading ${definition.title}`} />}>
          <definition.Component companyId={companyId} placement={placement} />
        </Suspense>
      </div>
      {editing && !contextual ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          className="absolute bottom-0 right-0 size-4 cursor-nwse-resize touch-none rounded-br-lg border-b-2 border-r-2 border-muted-foreground"
          onPointerDown={startResize}
        />
      ) : null}
    </div>
  );
}
