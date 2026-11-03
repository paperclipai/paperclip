import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi } from "../../api/heartbeats";
import { redactCommandText as redactCommandSecretText } from "@paperclipai/adapter-utils";
import { cn, relativeTime } from "../../lib/utils";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { type HeartbeatRun, type WorkspaceOperation } from "@paperclipai/shared";
import { redactHomePathUserSegments, redactHomePathUserSegmentsInValue } from "@paperclipai/adapter-utils";
import { Badge } from "@/components/ui/badge";

export const RUN_LOG_PAGE_BYTES = 256_000;

const REDACTED_ENV_VALUE = "***REDACTED***";

const SECRET_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;

const COMMAND_ENV_KEY_RE = /(^command$|^cmd$|command[-_]?line|resolved[-_]?command|PAPERCLIP_RESOLVED_COMMAND)/i;

const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;

export function redactPathText(value: string, censorUsernameInLogs: boolean) {
  return redactHomePathUserSegments(value, { enabled: censorUsernameInLogs });
}

export function redactPathValue<T>(value: T, censorUsernameInLogs: boolean): T {
  return redactHomePathUserSegmentsInValue(value, { enabled: censorUsernameInLogs });
}

function redactCommandText(value: string, censorUsernameInLogs: boolean): string {
  return redactPathText(redactCommandSecretText(value, REDACTED_ENV_VALUE), censorUsernameInLogs);
}

function shouldRedactSecretValue(key: string, value: unknown): boolean {
  if (SECRET_ENV_KEY_RE.test(key)) return true;
  if (typeof value !== "string") return false;
  return JWT_VALUE_RE.test(value);
}

function redactEnvValue(key: string, value: unknown, censorUsernameInLogs: boolean): string {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "secret_ref"
  ) {
    return "***SECRET_REF***";
  }
  if (shouldRedactSecretValue(key, value)) return REDACTED_ENV_VALUE;
  if (value === null || value === undefined) return "";
  if (typeof value === "string" && COMMAND_ENV_KEY_RE.test(key)) return redactCommandText(value, censorUsernameInLogs);
  if (typeof value === "string") return redactPathText(value, censorUsernameInLogs);
  try {
    return JSON.stringify(redactPathValue(value, censorUsernameInLogs));
  } catch {
    return redactPathText(String(value), censorUsernameInLogs);
  }
}

function formatEnvForDisplay(envValue: unknown, censorUsernameInLogs: boolean): string {
  const env = asRecord(envValue);
  if (!env) return "<unable-to-parse>";

  const keys = Object.keys(env);
  if (keys.length === 0) return "<empty>";

  return keys
    .sort()
    .map((key) => `${key}=${redactEnvValue(key, env[key], censorUsernameInLogs)}`)
    .join("\n");
}

export const LIVE_SCROLL_BOTTOM_TOLERANCE_PX = 32;

export type ScrollContainer = Window | HTMLElement;

function isWindowContainer(container: ScrollContainer): container is Window {
  return container === window;
}

function isElementScrollContainer(element: HTMLElement): boolean {
  const overflowY = window.getComputedStyle(element).overflowY;
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

export function findScrollContainer(anchor: HTMLElement | null): ScrollContainer {
  let parent = anchor?.parentElement ?? null;
  while (parent) {
    if (isElementScrollContainer(parent)) return parent;
    parent = parent.parentElement;
  }
  return window;
}

export function readScrollMetrics(container: ScrollContainer): { scrollHeight: number; distanceFromBottom: number } {
  if (isWindowContainer(container)) {
    const pageHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
    );
    const viewportBottom = window.scrollY + window.innerHeight;
    return {
      scrollHeight: pageHeight,
      distanceFromBottom: Math.max(0, pageHeight - viewportBottom),
    };
  }

  const viewportBottom = container.scrollTop + container.clientHeight;
  return {
    scrollHeight: container.scrollHeight,
    distanceFromBottom: Math.max(0, container.scrollHeight - viewportBottom),
  };
}

export function scrollToContainerBottom(container: ScrollContainer, behavior: ScrollBehavior = "auto") {
  if (isWindowContainer(container)) {
    const pageHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
    );
    window.scrollTo({ top: pageHeight, behavior });
    return;
  }

  container.scrollTo({ top: container.scrollHeight, behavior });
}

export type RunLogChunk = {
  seq?: number;
  ts: string;
  stream: "stdout" | "stderr" | "system";
  chunk: string;
};

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildHeartbeatProgressLogLine(
  payload: Record<string, unknown>,
  fallbackTimestamp: string,
): RunLogChunk | null {
  const message = asNonEmptyString(payload.message);
  if (!message) return null;
  const phase = asNonEmptyString(payload.phase);
  const ts = asNonEmptyString(payload.updatedAt) ?? fallbackTimestamp;
  const chunk = phase ? `[${phase}] ${message}` : message;
  return { ts, stream: "system", chunk };
}

export function heartbeatProgressLogLineKey(line: RunLogChunk): string {
  return `${line.ts}\u0000${line.stream}\u0000${line.chunk}`;
}

export function shouldPollRunShellLog(status: HeartbeatRun["status"]): boolean {
  return status === "running";
}

export function RunInvocationCard({
  payload,
  censorUsernameInLogs,
}: {
  payload: Record<string, unknown>;
  censorUsernameInLogs: boolean;
}) {
  const rawCommandLine = [
    typeof payload.command === "string" ? payload.command : null,
    ...(Array.isArray(payload.commandArgs)
      ? payload.commandArgs.filter((value): value is string => typeof value === "string")
      : []),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const commandLine = rawCommandLine ? redactCommandText(rawCommandLine, censorUsernameInLogs) : "";

  const hasAdvancedDetails =
    commandLine.length > 0
    || (Array.isArray(payload.commandNotes) && payload.commandNotes.length > 0)
    || payload.prompt !== undefined
    || payload.context !== undefined
    || payload.env !== undefined;

  return (
    <div className="rounded-lg border border-border bg-background/60 p-3 space-y-2">
      <div className="text-xs font-medium text-muted-foreground">Invocation</div>
      {typeof payload.adapterType === "string" && (
        <div className="text-xs"><span className="text-muted-foreground">Adapter: </span>{payload.adapterType}</div>
      )}
      {typeof payload.cwd === "string" && (
        <div className="text-xs break-all"><span className="text-muted-foreground">Working dir: </span><span className="font-mono">{payload.cwd}</span></div>
      )}
      {hasAdvancedDetails && (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors group">
            <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
            Details
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2 space-y-2">
            {commandLine && (
              <div className="text-xs break-all">
                <span className="text-muted-foreground">Command: </span>
                <span className="font-mono">{commandLine}</span>
              </div>
            )}
            {Array.isArray(payload.commandNotes) && payload.commandNotes.length > 0 && (
              <div>
                <div className="text-xs text-muted-foreground mb-1">Command notes</div>
                <ul className="list-disc pl-5 space-y-1">
                  {payload.commandNotes
                    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
                    .map((note, idx) => (
                      <li key={`${idx}-${note}`} className="text-xs break-all font-mono">
                        {note}
                      </li>
                    ))}
                </ul>
              </div>
            )}
            {payload.prompt !== undefined && (
              <div>
                <div className="text-xs text-muted-foreground mb-1">Prompt</div>
                <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap">
                  {typeof payload.prompt === "string"
                    ? redactPathText(payload.prompt, censorUsernameInLogs)
                    : JSON.stringify(redactPathValue(payload.prompt, censorUsernameInLogs), null, 2)}
                </pre>
              </div>
            )}
            {payload.context !== undefined && (
              <div>
                <div className="text-xs text-muted-foreground mb-1">Context</div>
                <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap">
                  {JSON.stringify(redactPathValue(payload.context, censorUsernameInLogs), null, 2)}
                </pre>
              </div>
            )}
            {payload.env !== undefined && (
              <div>
                <div className="text-xs text-muted-foreground mb-1">Environment</div>
                <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap font-mono">
                  {formatEnvForDisplay(payload.env, censorUsernameInLogs)}
                </pre>
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function parseStoredLogContent(content: string): RunLogChunk[] {
  const parsed: RunLogChunk[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as { ts?: unknown; stream?: unknown; chunk?: unknown };
      const stream =
        raw.stream === "stderr" || raw.stream === "system" ? raw.stream : "stdout";
      const chunk = typeof raw.chunk === "string" ? raw.chunk : "";
      const ts = typeof raw.ts === "string" ? raw.ts : new Date().toISOString();
      if (!chunk) continue;
      parsed.push({ ts, stream, chunk });
    } catch {
      // Ignore malformed log lines.
    }
  }
  return parsed;
}

function workspaceOperationPhaseLabel(phase: WorkspaceOperation["phase"]) {
  switch (phase) {
    case "worktree_prepare":
      return "Worktree setup";
    case "workspace_config_freshness":
      return "Config freshness";
    case "workspace_provision":
      return "Provision";
    case "workspace_teardown":
      return "Teardown";
    case "worktree_cleanup":
      return "Worktree cleanup";
    default:
      return phase;
  }
}

function workspaceOperationStatusTone(status: WorkspaceOperation["status"]) {
  switch (status) {
    case "succeeded":
      return "border-green-500/20 bg-green-500/10 text-green-700 dark:text-green-300";
    case "failed":
      return "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300";
    case "running":
      return "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300";
    case "skipped":
      return "border-yellow-500/20 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300";
    default:
      return "border-border bg-muted/40 text-muted-foreground";
  }
}

function WorkspaceOperationStatusBadge({ status }: { status: WorkspaceOperation["status"] }) {
  return (
    <Badge variant="outline"
      className={cn(
        "text-(length:--text-micro) capitalize",
        workspaceOperationStatusTone(status),
      )}
    >
      {status.replace("_", " ")}
    </Badge>
  );
}

function WorkspaceOperationLogViewer({
  operation,
  censorUsernameInLogs,
}: {
  operation: WorkspaceOperation;
  censorUsernameInLogs: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { data: logData, isLoading, error } = useQuery({
    queryKey: ["workspace-operation-log", operation.id],
    queryFn: () => heartbeatsApi.workspaceOperationLog(operation.id),
    enabled: open && Boolean(operation.logRef),
    refetchInterval: open && operation.status === "running" ? 2000 : false,
  });

  const chunks = useMemo(
    () => (logData?.content ? parseStoredLogContent(logData.content) : []),
    [logData?.content],
  );

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="text-(length:--text-micro) text-muted-foreground underline underline-offset-2 hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide full log" : "Show full log"}
      </button>
      {open && (
        <div className="rounded-md border border-border bg-background/70 p-2">
          {isLoading && <div className="text-xs text-muted-foreground">Loading log...</div>}
          {error && (
            <div className="text-xs text-destructive">
              {error instanceof Error ? error.message : "Failed to load workspace operation log"}
            </div>
          )}
          {!isLoading && !error && chunks.length === 0 && (
            <div className="text-xs text-muted-foreground">No persisted log lines.</div>
          )}
          {chunks.length > 0 && (
            <div className="max-h-64 overflow-y-auto rounded bg-neutral-100 p-2 font-mono text-xs dark:bg-neutral-950">
              {chunks.map((chunk, index) => (
                <div key={`${chunk.ts}-${index}`} className="flex gap-2">
                  <span className="shrink-0 text-neutral-500">
                    {new Date(chunk.ts).toLocaleTimeString("en-US", { hour12: false })}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 w-14",
                      chunk.stream === "stderr"
                        ? "text-red-600 dark:text-red-300"
                        : chunk.stream === "system"
                          ? "text-blue-600 dark:text-blue-300"
                          : "text-muted-foreground",
                    )}
                  >
                    [{chunk.stream}]
                  </span>
                  <span className="whitespace-pre-wrap break-all">{redactPathText(chunk.chunk, censorUsernameInLogs)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function WorkspaceOperationsSection({
  operations,
  censorUsernameInLogs,
}: {
  operations: WorkspaceOperation[];
  censorUsernameInLogs: boolean;
}) {
  if (operations.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-background/60 p-3 space-y-3">
      <div className="text-xs font-medium text-muted-foreground">
        Workspace ({operations.length})
      </div>
      <div className="space-y-3">
        {operations.map((operation) => {
          const metadata = asRecord(operation.metadata);
          return (
            <div key={operation.id} className="rounded-md border border-border/70 bg-background/70 p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-sm font-medium">{workspaceOperationPhaseLabel(operation.phase)}</div>
                <WorkspaceOperationStatusBadge status={operation.status} />
                <div className="text-(length:--text-micro) text-muted-foreground">
                  {relativeTime(operation.startedAt)}
                  {operation.finishedAt && ` to ${relativeTime(operation.finishedAt)}`}
                </div>
              </div>
              {operation.command && (
                <div className="text-xs break-all">
                  <span className="text-muted-foreground">Command: </span>
                  <span className="font-mono">{operation.command}</span>
                </div>
              )}
              {operation.cwd && (
                <div className="text-xs break-all">
                  <span className="text-muted-foreground">Working dir: </span>
                  <span className="font-mono">{operation.cwd}</span>
                </div>
              )}
              {(asNonEmptyString(metadata?.branchName)
                || asNonEmptyString(metadata?.baseRef)
                || asNonEmptyString(metadata?.worktreePath)
                || asNonEmptyString(metadata?.repoRoot)
                || asNonEmptyString(metadata?.cleanupAction)) && (
                <div className="grid gap-1 text-xs sm:grid-cols-2">
                  {asNonEmptyString(metadata?.branchName) && (
                    <div><span className="text-muted-foreground">Branch: </span><span className="font-mono">{metadata?.branchName as string}</span></div>
                  )}
                  {asNonEmptyString(metadata?.baseRef) && (
                    <div><span className="text-muted-foreground">Base ref: </span><span className="font-mono">{metadata?.baseRef as string}</span></div>
                  )}
                  {asNonEmptyString(metadata?.worktreePath) && (
                    <div className="break-all"><span className="text-muted-foreground">Worktree: </span><span className="font-mono">{metadata?.worktreePath as string}</span></div>
                  )}
                  {asNonEmptyString(metadata?.repoRoot) && (
                    <div className="break-all"><span className="text-muted-foreground">Repo root: </span><span className="font-mono">{metadata?.repoRoot as string}</span></div>
                  )}
                  {asNonEmptyString(metadata?.cleanupAction) && (
                    <div><span className="text-muted-foreground">Cleanup: </span><span className="font-mono">{metadata?.cleanupAction as string}</span></div>
                  )}
                </div>
              )}
              {typeof metadata?.created === "boolean" && (
                <div className="text-xs text-muted-foreground">
                  {metadata.created ? "Created by this run" : "Reused existing workspace"}
                </div>
              )}
              {operation.stderrExcerpt && operation.stderrExcerpt.trim() && (
                <div>
                  <div className="mb-1 text-xs text-red-700 dark:text-red-300">stderr excerpt</div>
                  <pre className="rounded-md bg-red-50 p-2 text-xs whitespace-pre-wrap break-all text-red-800 dark:bg-neutral-950 dark:text-red-100">
                    {redactPathText(operation.stderrExcerpt, censorUsernameInLogs)}
                  </pre>
                </div>
              )}
              {operation.stdoutExcerpt && operation.stdoutExcerpt.trim() && (
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">stdout excerpt</div>
                  <pre className="rounded-md bg-neutral-100 p-2 text-xs whitespace-pre-wrap break-all dark:bg-neutral-950">
                    {redactPathText(operation.stdoutExcerpt, censorUsernameInLogs)}
                  </pre>
                </div>
              )}
              {operation.logRef && (
                <WorkspaceOperationLogViewer
                  operation={operation}
                  censorUsernameInLogs={censorUsernameInLogs}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
