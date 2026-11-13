import { cn } from "@/lib/utils";
import { DIRECTION_IDS, KIT_KEYS, KIT_META, type DirectionId } from "../kit";
import { LAB_VIEWS, type LabState, type LabTheme, type LabView } from "../lab-state";

/**
 * The lab's own chrome (`chrome=1`). Deliberately not the product's look —
 * monospace, one line — so it never reads as part of a frame.
 */

interface Option<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          data-size="xs"
          aria-checked={option.value === value}
          title={option.hint}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-sm px-2 py-1 leading-none transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
            option.value === value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// The kit set has no "All": the every-kit contact sheet is URL-only (`?d=all`).
const KIT_OPTIONS: Option<DirectionId | "all">[] = DIRECTION_IDS.map((id) => ({
  value: id,
  label: KIT_META[id].name,
  hint: `${KIT_META[id].tagline} (${KIT_KEYS[id]})`,
}));
// Overview first; the vocabulary sheet (`s=kinds`) is URL-only.
const VIEW_OPTIONS: Option<LabView>[] = [
  { value: "board", label: "Overview", hint: "The kit's four surfaces on one sheet" },
  { value: "thread", label: "Task-thread" },
  { value: "panel", label: "Right-panel" },
  { value: "gallery", label: "Tab-gallery" },
  { value: "stack", label: "Tab-closeup" },
];
const THEME_OPTIONS: Option<LabTheme>[] = [
  { value: "dark", label: "dark", hint: "Toggle with t" },
  { value: "light", label: "light", hint: "Toggle with t" },
];
const ANIM_OPTIONS: Option<"off" | "on">[] = [
  { value: "off", label: "off", hint: "Hover animations off (toggle with a)" },
  { value: "on", label: "on", hint: "Hover animations on: MVP V1 artwork rises, stack pages turn (toggle with a)" },
];

const TITLE = "font-medium uppercase tracking-(--tracking-label) text-foreground";

/**
 * Two labelled rows on one grid — "Artifact directions" over "Artifact
 * surfaces" — so the labels sit flush left and the two sets start on the same
 * column. Theme and animation keep to the first row's right edge.
 */
export function LabToolbar({ state, onChange }: { state: LabState; onChange: (patch: Partial<LabState>) => void }) {
  return (
    <div
      className="sticky top-0 z-50 grid items-center gap-x-4 gap-y-2 border-b border-border bg-background px-4 py-2 font-mono text-(length:--text-micro) text-muted-foreground"
      style={{ gridTemplateColumns: "max-content 1fr" }}
    >
      <span className={TITLE}>Artifact directions</span>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Segmented label="Kit" options={KIT_OPTIONS} value={state.direction} onChange={(direction) => onChange({ direction })} />
        <div className="ml-auto flex items-center gap-4">
          <Segmented label="Theme" options={THEME_OPTIONS} value={state.theme} onChange={(theme) => onChange({ theme })} />
          <span className="flex items-center gap-1.5">
            <span>animation</span>
            <Segmented label="Animation" options={ANIM_OPTIONS} value={state.anim ? "on" : "off"} onChange={(value) => onChange({ anim: value === "on" })} />
          </span>
        </div>
      </div>
      <span className={TITLE}>Artifact surfaces</span>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Segmented label="Surface" options={VIEW_OPTIONS} value={state.view} onChange={(view) => onChange({ view })} />
        <span className="ml-auto hidden lg:inline">0–5 kit · t theme · a animation</span>
      </div>
    </div>
  );
}
