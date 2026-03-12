import { useMemo, useState } from "react";
import type { TranscriptEntry } from "../../adapters";
import { MarkdownBody } from "../MarkdownBody";
import { cn } from "../../lib/utils";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  TerminalSquare,
  User,
  Wrench,
} from "lucide-react";

export type TranscriptMode = "nice" | "raw";

type RawTranscriptLine = {
  ts: string;
  stream: "stdout" | "stderr" | "system";
  chunk: string;
};

interface RunTranscriptViewProps {
  entries: TranscriptEntry[];
  rawLines?: RawTranscriptLine[];
  mode?: TranscriptMode;
  className?: string;
  emptyMessage?: string;
}

type NiceTranscriptRow =
  | { id: string; type: "assistant" | "thinking" | "user"; ts: string; text: string }
  | { id: string; type: "tool_call"; ts: string; name: string; input: unknown }
  | { id: string; type: "tool_result"; ts: string; content: string; isError: boolean }
  | { id: string; type: "result"; ts: string; text: string; metrics: string }
  | { id: string; type: "event"; ts: string; label: string; text: string; tone: "info" | "warn" | "error" };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}...` : value;
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeToolResult(content: string, isError: boolean): string {
  if (!content.trim()) return isError ? "Tool failed." : "Tool completed.";
  const record = asRecord((() => {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  })());
  if (!record) return truncate(compactWhitespace(content), 220);

  const direct = [
    record.summary,
    record.result,
    record.message,
    record.error,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return direct ? truncate(compactWhitespace(direct), 220) : truncate(compactWhitespace(content), 220);
}

function toNiceRows(entries: TranscriptEntry[]): NiceTranscriptRow[] {
  return entries.map((entry, index) => {
    const id = `${entry.ts}-${entry.kind}-${index}`;
    if (entry.kind === "assistant" || entry.kind === "thinking" || entry.kind === "user") {
      return {
        id,
        type: entry.kind,
        ts: entry.ts,
        text: entry.text,
      };
    }
    if (entry.kind === "tool_call") {
      return {
        id,
        type: "tool_call",
        ts: entry.ts,
        name: entry.name,
        input: entry.input,
      };
    }
    if (entry.kind === "tool_result") {
      return {
        id,
        type: "tool_result",
        ts: entry.ts,
        content: entry.content,
        isError: entry.isError,
      };
    }
    if (entry.kind === "result") {
      return {
        id,
        type: "result",
        ts: entry.ts,
        text: entry.text,
        metrics: `in ${entry.inputTokens} | out ${entry.outputTokens} | cached ${entry.cachedTokens} | $${entry.costUsd.toFixed(6)}`,
      };
    }
    return {
      id,
      type: "event",
      ts: entry.ts,
      label: entry.kind,
      text: entry.kind === "stdout" || entry.kind === "stderr" || entry.kind === "system"
        ? entry.text
        : entry.kind === "init"
          ? `model ${entry.model}${entry.sessionId ? `, session ${entry.sessionId}` : ""}`
          : formatUnknown(entry),
      tone:
        entry.kind === "stderr"
          ? "error"
          : entry.kind === "system"
            ? "warn"
            : "info",
    };
  });
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

function RawTranscript({ rawLines }: { rawLines: RawTranscriptLine[] }) {
  if (rawLines.length === 0) {
    return <div className="text-neutral-500">No persisted transcript for this run.</div>;
  }

  return (
    <div className="space-y-1">
      {rawLines.map((line, index) => (
        <div key={`${line.ts}-${line.stream}-${index}`} className="grid grid-cols-[auto_auto_1fr] gap-x-3">
          <span className="w-16 text-neutral-400">{formatTime(line.ts)}</span>
          <span
            className={cn(
              "w-14",
              line.stream === "stderr"
                ? "text-red-600 dark:text-red-300"
                : line.stream === "system"
                  ? "text-blue-600 dark:text-blue-300"
                  : "text-neutral-500",
            )}
          >
            {line.stream}
          </span>
          <span className="whitespace-pre-wrap break-words">{line.chunk}</span>
        </div>
      ))}
    </div>
  );
}

function NiceTranscript({ rows }: { rows: NiceTranscriptRow[] }) {
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

  const toggleRow = (rowId: string) => {
    setExpandedRows((current) => ({ ...current, [rowId]: !current[rowId] }));
  };

  return (
    <div className="space-y-2">
      {rows.map((row) => {
        if (row.type === "assistant") {
          return (
            <div key={row.id} className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
              <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                <User className="h-3.5 w-3.5" />
                Assistant
                <span className="text-muted-foreground">{formatTime(row.ts)}</span>
              </div>
              <MarkdownBody className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 text-sm">
                {row.text}
              </MarkdownBody>
            </div>
          );
        }

        if (row.type === "thinking") {
          return (
            <div key={row.id} className="rounded-lg border border-dashed border-border bg-muted/30 p-3">
              <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                <CircleAlert className="h-3.5 w-3.5" />
                Thinking
                <span>{formatTime(row.ts)}</span>
              </div>
              <div className="whitespace-pre-wrap break-words text-sm italic text-muted-foreground">
                {row.text}
              </div>
            </div>
          );
        }

        if (row.type === "user") {
          return (
            <div key={row.id} className="rounded-lg border border-border bg-background/60 p-3">
              <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                <User className="h-3.5 w-3.5" />
                User
                <span>{formatTime(row.ts)}</span>
              </div>
              <div className="whitespace-pre-wrap break-words text-sm">{row.text}</div>
            </div>
          );
        }

        if (row.type === "tool_call") {
          const expanded = Boolean(expandedRows[row.id]);
          return (
            <div key={row.id} className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
              <button
                type="button"
                className="flex w-full items-center gap-2 text-left text-[11px] uppercase tracking-wide text-amber-700 dark:text-amber-300"
                onClick={() => toggleRow(row.id)}
              >
                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                <Wrench className="h-3.5 w-3.5" />
                {row.name}
                <span className="text-muted-foreground">{formatTime(row.ts)}</span>
              </button>
              {expanded ? (
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-background/70 p-2 text-[11px]">
                  {JSON.stringify(row.input, null, 2)}
                </pre>
              ) : (
                <div className="mt-2 text-sm text-muted-foreground">
                  {truncate(compactWhitespace(formatUnknown(row.input)), 220) || "No tool input."}
                </div>
              )}
            </div>
          );
        }

        if (row.type === "tool_result") {
          const expanded = Boolean(expandedRows[row.id]);
          return (
            <div
              key={row.id}
              className={cn(
                "rounded-lg border p-3",
                row.isError
                  ? "border-red-500/20 bg-red-500/5"
                  : "border-sky-500/20 bg-sky-500/5",
              )}
            >
              <button
                type="button"
                className="flex w-full items-center gap-2 text-left text-[11px] uppercase tracking-wide"
                onClick={() => toggleRow(row.id)}
              >
                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {row.isError ? <CircleAlert className="h-3.5 w-3.5 text-red-600 dark:text-red-300" /> : <Check className="h-3.5 w-3.5 text-sky-600 dark:text-sky-300" />}
                <span className={row.isError ? "text-red-700 dark:text-red-300" : "text-sky-700 dark:text-sky-300"}>
                  Tool result
                </span>
                <span className="text-muted-foreground">{formatTime(row.ts)}</span>
              </button>
              {expanded ? (
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-background/70 p-2 text-[11px]">
                  {row.content}
                </pre>
              ) : (
                <div className="mt-2 text-sm text-muted-foreground">
                  {summarizeToolResult(row.content, row.isError)}
                </div>
              )}
            </div>
          );
        }

        if (row.type === "result") {
          return (
            <div key={row.id} className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3">
              <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-cyan-700 dark:text-cyan-300">
                <TerminalSquare className="h-3.5 w-3.5" />
                Result
                <span className="text-muted-foreground">{formatTime(row.ts)}</span>
              </div>
              <div className="text-xs text-muted-foreground">{row.metrics}</div>
              {row.text ? (
                <div className="mt-2 whitespace-pre-wrap break-words text-sm">{row.text}</div>
              ) : null}
            </div>
          );
        }

        if (row.type === "event") {
          return (
            <div key={row.id} className="rounded-lg border border-border/60 bg-background/40 p-3">
              <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                <TerminalSquare className="h-3.5 w-3.5" />
                {row.label}
                <span>{formatTime(row.ts)}</span>
              </div>
              <div
                className={cn(
                  "whitespace-pre-wrap break-words text-sm",
                  row.tone === "error"
                    ? "text-red-700 dark:text-red-300"
                    : row.tone === "warn"
                      ? "text-amber-700 dark:text-amber-300"
                      : "text-muted-foreground",
                )}
              >
                {row.text}
              </div>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}

export function RunTranscriptView({
  entries,
  rawLines = [],
  mode = "nice",
  className,
  emptyMessage = "No transcript available.",
}: RunTranscriptViewProps) {
  const rows = useMemo(() => toNiceRows(entries), [entries]);

  if (entries.length === 0 && rawLines.length === 0) {
    return <div className={cn("text-neutral-500", className)}>{emptyMessage}</div>;
  }

  return (
    <div className={cn(className, "space-y-2")}>
      {mode === "raw" ? <RawTranscript rawLines={rawLines} /> : <NiceTranscript rows={rows} />}
    </div>
  );
}
