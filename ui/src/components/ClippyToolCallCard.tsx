import { useState } from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { cn } from "../lib/utils";

interface Props {
  name: string;
  input: unknown;
  result?: { ok: boolean; data: unknown };
  status?: "pending" | "completed" | "denied";
}

export function ClippyToolCallCard({ name, input, result, status = "completed" }: Props) {
  const [open, setOpen] = useState(false);
  const inputSummary = oneLineSummary(input);
  const tone =
    status === "pending"
      ? "border-blue-300 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30"
      : status === "denied"
        ? "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30"
        : result && !result.ok
          ? "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/30"
          : "border-border bg-muted/40";

  return (
    <div className={cn("my-2 rounded-md border text-xs", tone)}>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <Wrench className="h-3 w-3 shrink-0" />
        <span className="font-mono font-medium">{name}</span>
        <span className="truncate text-muted-foreground">({inputSummary})</span>
        {status === "pending" && (
          <span className="ml-auto text-[10px] text-blue-700 dark:text-blue-400">running…</span>
        )}
        {status === "denied" && (
          <span className="ml-auto text-[10px] text-amber-700 dark:text-amber-500">denied</span>
        )}
        {result && !result.ok && status === "completed" && (
          <span className="ml-auto text-[10px] text-red-700 dark:text-red-400">error</span>
        )}
      </button>
      {open && (
        <div className="space-y-2 border-t border-current/10 px-2 py-2">
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Input</div>
            <pre className="max-h-48 overflow-auto rounded bg-background/60 p-1.5 text-[11px]">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
          {result && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">
                {result.ok ? "Result" : "Error"}
              </div>
              <pre className="max-h-72 overflow-auto rounded bg-background/60 p-1.5 text-[11px]">
                {typeof result.data === "string"
                  ? result.data
                  : JSON.stringify(result.data, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function oneLineSummary(input: unknown): string {
  if (input == null) return "";
  if (typeof input !== "object") return String(input);
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return "";
  const summary = entries
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === "string" ? `"${truncate(v, 30)}"` : truncate(JSON.stringify(v), 30)}`)
    .join(", ");
  return entries.length > 3 ? `${summary}, …` : summary;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
