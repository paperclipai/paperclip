import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Copy, GripHorizontal, Minus, Plus, RotateCcw } from "lucide-react";
import {
  EASING_PRESETS,
  MOTION_TOKENS,
  MOTION_TOKEN_EXPORT_FALLBACK,
  MOTION_TOKEN_GROUPS,
  parseCssTimeMs,
  type MotionTokenDef,
} from "./motion-tokens";

const POS_KEY = "tc-tweak-pos";
const OVERRIDES_KEY = "tc-tweak-overrides";

function readComputed(name: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function loadSession<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveSession(key: string, value: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* session storage unavailable — panel still works, just not persisted */
  }
}

/**
 * Hand-rolled motion tweak panel (dev/flag only). Floating, draggable,
 * minimizable overlay that lists every motion token, writes changes live to the
 * CSS custom properties (no reload), exports a paste-ready :root block, and
 * persists position + overrides for the session only. No third-party GUI lib —
 * one file, one dev guard, trivial to strip out later.
 */
export function TweakPanel() {
  const [pos, setPos] = useState<{ x: number; y: number }>(() =>
    loadSession(POS_KEY, { x: 24, y: 24 }),
  );
  const [minimized, setMinimized] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Record<string, string>>(() =>
    loadSession(OVERRIDES_KEY, {}),
  );
  const [exportText, setExportText] = useState<string | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  // Initialize display values from computed styles, then re-apply any saved
  // session overrides so a reload-free session keeps its tuning.
  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const t of MOTION_TOKENS) initial[t.name] = readComputed(t.name);
    for (const [name, value] of Object.entries(overrides)) {
      document.documentElement.style.setProperty(name, value);
      initial[name] = value;
    }
    setValues(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setToken = useCallback((name: string, value: string) => {
    document.documentElement.style.setProperty(name, value);
    setValues((v) => ({ ...v, [name]: value }));
    setOverrides((o) => {
      const next = { ...o, [name]: value };
      saveSession(OVERRIDES_KEY, next);
      return next;
    });
  }, []);

  const resetAll = useCallback(() => {
    for (const name of Object.keys(overrides)) {
      document.documentElement.style.removeProperty(name);
    }
    setOverrides({});
    saveSession(OVERRIDES_KEY, {});
    const refreshed: Record<string, string> = {};
    for (const t of MOTION_TOKENS) refreshed[t.name] = readComputed(t.name);
    setValues(refreshed);
  }, [overrides]);

  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent) => {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    },
    [pos],
  );

  const onHeaderPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const next = { x: e.clientX - dragRef.current.dx, y: e.clientY - dragRef.current.dy };
    setPos(next);
  }, []);

  const onHeaderPointerUp = useCallback(() => {
    if (dragRef.current) {
      dragRef.current = null;
      saveSession(POS_KEY, pos);
    }
  }, [pos]);

  const buildExport = useCallback(() => {
    const lines = MOTION_TOKENS.map((t) => {
      const val = values[t.name] || readComputed(t.name);
      return `  ${t.name}: ${val};`;
    });
    setExportText(`:root {\n${lines.join("\n")}\n}\n`);
  }, [values]);

  const grouped = useMemo(() => {
    const map: Record<string, MotionTokenDef[]> = {};
    for (const g of MOTION_TOKEN_GROUPS) map[g] = [];
    for (const t of MOTION_TOKENS) map[t.group].push(t);
    return map;
  }, []);

  return (
    <div
      className="fixed z-50 w-72 select-none rounded-lg border border-border bg-card text-card-foreground shadow-lg"
      style={{ left: pos.x, top: pos.y }}
      data-testid="task-chat-tweak-panel"
    >
      <div
        className="flex cursor-grab items-center gap-2 rounded-t-lg border-b border-border bg-muted/50 px-2 py-1.5 text-xs font-medium active:cursor-grabbing"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
      >
        <GripHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
        <span>Motion tweak panel</span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" title="Reset all" onClick={resetAll} className="rounded p-0.5 hover:bg-accent">
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={minimized ? "Expand" : "Minimize"}
            onClick={() => setMinimized((m) => !m)}
            className="rounded p-0.5 hover:bg-accent"
          >
            {minimized ? <Plus className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {minimized ? null : (
        <div className="max-h-(--sz-tweak-panel-max) overflow-y-auto p-2">
          {MOTION_TOKEN_GROUPS.map((group) => (
            <div key={group} className="mb-3">
              <p className="mb-1 text-(length:--text-nano) font-semibold uppercase tracking-wide text-muted-foreground">{group}</p>
              <div className="flex flex-col gap-2">
                {grouped[group].map((t) => (
                  <div key={t.name} data-token={t.name} className="flex flex-col gap-1">
                    <div className="flex items-center justify-between text-(length:--text-micro)">
                      <span className="truncate font-mono text-muted-foreground">{t.name.replace("--motion-", "")}</span>
                      <span className="ml-2 shrink-0 tabular-nums">
                        {t.kind === "time" ? `${Math.round(parseCssTimeMs(values[t.name] ?? "0"))}ms` : ""}
                      </span>
                    </div>
                    {t.kind === "time" ? (
                      <input
                        type="range"
                        aria-label={t.name}
                        min={t.min ?? 0}
                        max={t.max ?? 1000}
                        step={t.step ?? 10}
                        value={Math.round(parseCssTimeMs(values[t.name] ?? "0"))}
                        onChange={(e) => setToken(t.name, `${e.target.value}ms`)}
                        className="h-1.5 w-full"
                      />
                    ) : (
                      <select
                        aria-label={t.name}
                        value={values[t.name] ?? ""}
                        onChange={(e) => setToken(t.name, e.target.value)}
                        className="w-full rounded border border-border bg-background px-1 py-0.5 text-(length:--text-micro)"
                      >
                        {EASING_PRESETS.every((p) => p.value !== (values[t.name] ?? "")) && values[t.name] ? (
                          <option value={values[t.name]}>{values[t.name]}</option>
                        ) : null}
                        {EASING_PRESETS.map((p) => (
                          <option key={p.value} value={p.value}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="mt-1 flex gap-2">
            <button
              type="button"
              onClick={buildExport}
              className="flex flex-1 items-center justify-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
            >
              <Copy className="h-3.5 w-3.5" />
              Copy as @theme
            </button>
          </div>

          {exportText ? (
            <textarea
              readOnly
              data-testid="task-chat-tweak-export"
              className="mt-2 h-32 w-full resize-none rounded border border-border bg-muted/40 p-2 font-mono text-(length:--text-nano)"
              value={exportText}
              onFocus={(e) => {
                e.currentTarget.select();
                void navigator.clipboard?.writeText(exportText).catch(() => {});
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Build the :root export string from arbitrary token values. Exposed for the
 * finish-line test that asserts export produces valid CSS. Kept in sync with
 * the panel's own export.
 */
export function buildTweakExport(values: Record<string, string>): string {
  const lines = MOTION_TOKENS.map((t) => `  ${t.name}: ${values[t.name] ?? MOTION_TOKEN_EXPORT_FALLBACK};`);
  return `:root {\n${lines.join("\n")}\n}\n`;
}
