import { useEffect, useMemo, useRef, useState } from "react";

export type DatePreset = "mtd" | "7d" | "30d" | "ytd" | "all" | "custom";

export const PRESET_LABELS: Record<DatePreset, string> = {
  mtd: "Month to Date",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  ytd: "Year to Date",
  all: "All Time",
  custom: "Custom",
};

export const PRESET_KEYS: DatePreset[] = ["mtd", "7d", "30d", "ytd", "all", "custom"];

// note: computeRange is called inside a useMemo that re-evaluates once per minute
// (driven by minuteTick). this means sliding windows (7d, 30d) advance their upper
// bound at most once per minute — acceptable for a cost dashboard.
function computeRange(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  switch (preset) {
    case "mtd": {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: d.toISOString(), to };
    }
    case "7d": {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7, 0, 0, 0, 0);
      return { from: d.toISOString(), to };
    }
    case "30d": {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30, 0, 0, 0, 0);
      return { from: d.toISOString(), to };
    }
    case "ytd": {
      const d = new Date(now.getFullYear(), 0, 1);
      return { from: d.toISOString(), to };
    }
    case "all":
    case "custom":
      return { from: "", to: "" };
  }
}

// floor a Date to the nearest minute so the query key is stable across
// 30s refetch ticks (prevents new cache entries on every poll cycle)
function floorToMinute(d: Date): string {
  const floored = new Date(d);
  floored.setSeconds(0, 0);
  return floored.toISOString();
}

export interface UseDateRangeResult {
  preset: DatePreset;
  setPreset: (p: DatePreset) => void;
  customFrom: string;
  setCustomFrom: (v: string) => void;
  customTo: string;
  setCustomTo: (v: string) => void;
  /** resolved iso strings ready to pass to api calls; empty string means unbounded */
  from: string;
  to: string;
  /** false when preset=custom but both dates are not yet selected */
  customReady: boolean;
}

export function useDateRange(): UseDateRangeResult {
  const [preset, setPreset] = useState<DatePreset>("mtd");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  // tick at the next calendar minute boundary, then every 60s, so sliding presets
  // (7d, 30d) advance their upper bound in sync with wall clock minutes rather than
  // drifting by the mount offset.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [minuteTick, setMinuteTick] = useState(() => floorToMinute(new Date()));
  useEffect(() => {
    const now = new Date();
    const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    const timeout = setTimeout(() => {
      setMinuteTick(floorToMinute(new Date()));
      intervalRef.current = setInterval(
        () => setMinuteTick(floorToMinute(new Date())),
        60_000,
      );
    }, msToNextMinute);
    return () => {
      clearTimeout(timeout);
      if (intervalRef.current != null) clearInterval(intervalRef.current);
    };
  }, []);

  const { from, to } = useMemo(() => {
    if (preset !== "custom") return computeRange(preset);
    // treat custom date strings as local-date boundaries so the full day is included
    // regardless of the user's timezone. "from" starts at local midnight, "to" at 23:59:59.999.
    const fromDate = customFrom ? new Date(customFrom + "T00:00:00") : null;
    const toDate = customTo ? new Date(customTo + "T23:59:59.999") : null;
    return {
      from: fromDate ? fromDate.toISOString() : "",
      to: toDate ? toDate.toISOString() : "",
    };
  // minuteTick drives re-evaluation of sliding presets once per minute.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, customFrom, customTo, minuteTick]);

  const customReady = preset !== "custom" || (!!customFrom && !!customTo);

  return {
    preset,
    setPreset,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    from,
    to,
    customReady,
  };
}
