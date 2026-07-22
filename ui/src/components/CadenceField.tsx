import { useEffect, useState } from "react";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  CADENCE_UNIT_LABELS,
  cadenceToSeconds,
  formatRunsPerDay,
  secondsToCadence,
  type CadenceUnit,
} from "../lib/cadence";
import { HintIcon } from "./agent-config-primitives";
import { cn } from "../lib/utils";

const inputClass =
  "w-16 rounded-md border border-border px-2 py-1 bg-transparent outline-none text-sm font-mono text-center";
const selectClass =
  "rounded-md border border-border px-2 py-1 bg-transparent outline-none text-sm";

const UNIT_OPTIONS: CadenceUnit[] = ["seconds", "minutes", "hours"];

/**
 * Humanized heartbeat cadence control (wireframe 05). Presents the stored
 * `intervalSec` as "Every [N] [unit]" with a live "≈ 288 runs/day" preview.
 * The value is always stored/emitted in seconds — the unit select is a
 * display convenience that round-trips exactly (see lib/cadence).
 */
export function CadenceField({
  label = "Run automatically on a timer",
  hint,
  enabled,
  onEnabledChange,
  intervalSec,
  onIntervalSecChange,
  disabled,
}: {
  label?: string;
  hint?: string;
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  intervalSec: number;
  onIntervalSecChange: (next: number) => void;
  disabled?: boolean;
}) {
  // Local display state so switching units doesn't fight the derived value.
  // Seconds remain the source of truth; we re-derive when the prop changes.
  const [display, setDisplay] = useState(() => secondsToCadence(intervalSec));
  useEffect(() => {
    setDisplay((prev) => {
      // Preserve the user's chosen unit when the prop still matches what that
      // unit would produce (e.g. after a save round-trip), otherwise re-derive.
      if (cadenceToSeconds(prev.value, prev.unit) === Math.max(1, Math.floor(intervalSec))) {
        return prev;
      }
      return secondsToCadence(intervalSec);
    });
  }, [intervalSec]);

  function commit(value: number, unit: CadenceUnit) {
    setDisplay({ value, unit });
    onIntervalSecChange(cadenceToSeconds(value, unit));
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-sm">{label}</span>
          {hint && <HintIcon text={hint} />}
        </div>
        <ToggleSwitch checked={enabled} onCheckedChange={onEnabledChange} disabled={disabled} />
      </div>
      {enabled && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Every</span>
          <input
            type="number"
            min={1}
            className={inputClass}
            value={display.value}
            disabled={disabled}
            aria-label="Interval amount"
            onChange={(event) => {
              const next = Number(event.target.value);
              commit(Number.isFinite(next) ? next : 0, display.unit);
            }}
          />
          <select
            className={selectClass}
            value={display.unit}
            disabled={disabled}
            aria-label="Interval unit"
            onChange={(event) => commit(display.value, event.target.value as CadenceUnit)}
          >
            {UNIT_OPTIONS.map((unit) => (
              <option key={unit} value={unit}>
                {CADENCE_UNIT_LABELS[unit]}
              </option>
            ))}
          </select>
          <span className={cn("text-xs text-muted-foreground")} aria-live="polite">
            {formatRunsPerDay(cadenceToSeconds(display.value, display.unit))}
          </span>
        </div>
      )}
    </div>
  );
}
