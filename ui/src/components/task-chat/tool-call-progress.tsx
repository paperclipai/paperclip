import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  boundToolCallProgressMessage,
  normalizeToolCallProgress,
  toolCallProgressFraction,
  type ToolCallProgressSnapshot,
} from "@paperclipai/shared";
import { mcpAppsApi } from "@/api/mcpApps";
import { useSecondTick } from "@/hooks/useSecondTick";
import { useCompanyLiveEvent } from "@/context/LiveUpdatesProvider";
import { queryKeys } from "@/lib/queryKeys";
import { cn, formatDurationMs } from "@/lib/utils";
import type { TaskChatToolItem } from "./task-chat-model";

/**
 * Live progress for a running connected-app tool call. The provider streams
 * MCP progress to Paperclip, which publishes it on the run's live events and
 * saves the latest on the call (read once, for a reload mid-call).
 */

/** The run whose rows are showing, when known; progress from other runs is ignored. */
const ToolCallProgressRunContext = createContext<string | null>(null);

export function ToolCallProgressRunProvider({ runId, children }: { runId: string | null | undefined; children: ReactNode }) {
  return <ToolCallProgressRunContext.Provider value={runId ?? null}>{children}</ToolCallProgressRunContext.Provider>;
}

/** Lowercase words joined by "_", so "mcp.kv-demo-1a:slow" and "mcp_kv_demo_1a_slow" compare equal. */
function comparableToolName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Whether a transcript row's tool name ("mcp__paperclip__<gateway tool>") is
 * the gateway tool a call reported. Agents may rewrite characters their tool
 * names cannot hold, so names are compared word by word, as a whole suffix.
 */
export function toolCallNameMatches(rawName: string | undefined, toolName: string): boolean {
  if (!rawName || !toolName) return false;
  const row = comparableToolName(rawName);
  const tool = comparableToolName(toolName);
  return Boolean(tool) && (row === tool || row.endsWith(`_${tool}`));
}

/** A live event payload as a snapshot, or null when it is not one. Values are checked again here. */
export function readToolCallProgressEvent(payload: Record<string, unknown>): ToolCallProgressSnapshot | null {
  const invocationId = typeof payload.invocationId === "string" ? payload.invocationId : null;
  const runId = typeof payload.runId === "string" ? payload.runId : null;
  const toolName = typeof payload.toolName === "string" ? payload.toolName : null;
  const nativeToolName = typeof payload.nativeToolName === "string" ? payload.nativeToolName : null;
  const startedAt = typeof payload.startedAt === "string" && Number.isFinite(Date.parse(payload.startedAt)) ? payload.startedAt : null;
  if (!invocationId || !runId || !toolName || !startedAt) return null;
  const updatedAt = typeof payload.updatedAt === "string" && Number.isFinite(Date.parse(payload.updatedAt)) ? new Date(payload.updatedAt) : new Date();
  const progress = normalizeToolCallProgress(payload, updatedAt);
  if (!progress) return null;
  return { ...progress, invocationId, runId, toolName, nativeToolName, startedAt, done: payload.done === true };
}

/** Whether a row is a call of this tool, under its gateway name or the native runner's name for it. */
export function rowShowsTool(item: Pick<TaskChatToolItem, "rawName" | "name" | "appToolName">, entry: Pick<ToolCallProgressSnapshot, "toolName" | "nativeToolName">): boolean {
  // A wrapper call (OpenCode's paperclip_call_assigned_tool) is matched by the tool it runs.
  return [item.appToolName, item.rawName ?? item.name].some((rowName) => Boolean(rowName) && (
    toolCallNameMatches(rowName, entry.toolName)
    || (Boolean(entry.nativeToolName) && toolCallNameMatches(rowName, entry.nativeToolName!))));
}

/** The progress for a row: the latest unfinished call of the same tool, in the same run when known. */
export function pickToolCallProgress(
  entries: Iterable<ToolCallProgressSnapshot>,
  item: Pick<TaskChatToolItem, "rawName" | "name" | "appToolName">,
  runId: string | null,
): ToolCallProgressSnapshot | null {
  let best: ToolCallProgressSnapshot | null = null;
  for (const entry of entries) {
    if (entry.done || (runId && entry.runId !== runId)) continue;
    if (!rowShowsTool(item, entry)) continue;
    if (!best || entry.startedAt > best.startedAt) best = entry;
  }
  return best;
}

/** Running calls kept per chat; the oldest are forgotten first. */
const MAX_TRACKED_CALLS = 50;
/** Finished call ids remembered per chat, so a delayed read cannot revive one. */
const MAX_REMEMBERED_FINISHED = 500;

/**
 * The chat's known tool call progress. Rows subscribe only while running, so a
 * burst of updates re-renders the running row, never the whole chat.
 */
export class ToolCallProgressStore {
  #entries = new Map<string, ToolCallProgressSnapshot>();
  #finished = new Set<string>();
  #listeners = new Set<() => void>();
  #onWanted: () => void;
  constructor(onWanted: () => void = () => undefined) { this.#onWanted = onWanted; }
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };
  /** A running row asks once for the saved progress (a reload mid-call). */
  want() { this.#onWanted(); }
  entries() { return this.#entries.values(); }
  /**
   * Keeps the newer update of each running call. A finished call is removed
   * and remembered (bounded, apart from shown progress), so a later "running"
   * snapshot of it, from a delayed read, never brings its progress back.
   */
  put(snapshot: ToolCallProgressSnapshot) {
    const id = snapshot.invocationId;
    if (this.#finished.has(id)) return;
    if (snapshot.done) {
      this.#finished.add(id);
      while (this.#finished.size > MAX_REMEMBERED_FINISHED) this.#finished.delete(this.#finished.values().next().value!);
      if (!this.#entries.delete(id)) return;
    } else {
      const previous = this.#entries.get(id);
      if (previous && previous.updatedAt > snapshot.updatedAt) return;
      this.#entries.delete(id);
      this.#entries.set(id, snapshot);
      while (this.#entries.size > MAX_TRACKED_CALLS) this.#entries.delete(this.#entries.keys().next().value!);
    }
    for (const listener of this.#listeners) listener();
  }
}

const ToolCallProgressStoreContext = createContext<ToolCallProgressStore | null>(null);

/**
 * One per task chat: listens for the task's tool call progress on the shared
 * live socket, and reads the saved progress once, only when a call is running.
 */
export function ToolCallProgressProvider({ issueId, children }: { issueId: string | null | undefined; children: ReactNode }) {
  const [wantedFor, setWantedFor] = useState<string | null>(null);
  // A new store (and a fresh read) per task and per mount: updates sent while the
  // chat was closed are only in the saved snapshot.
  const store = useMemo(() => new ToolCallProgressStore(() => setWantedFor(issueId ?? null)), [issueId]);
  const saved = useQuery({
    queryKey: queryKeys.toolCallProgress(issueId ?? ""),
    queryFn: () => mcpAppsApi.toolCallProgress(issueId!),
    enabled: Boolean(issueId) && wantedFor === issueId,
    // Read again whenever a chat with a running call mounts; live events cover the rest.
    staleTime: 0,
    refetchOnMount: "always",
    // Live events are not handled while the tab is hidden; read again on return.
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    // Finished calls arrive as done; a call missing from the read is never dropped,
    // since a running call may not have saved its first update yet.
    for (const entry of saved.data ?? []) store.put(entry);
  }, [saved.data, store]);
  useCompanyLiveEvent((event) => {
    if (event.type !== "heartbeat.run.tool_progress" || !issueId || event.payload?.issueId !== issueId) return;
    const snapshot = readToolCallProgressEvent(event.payload);
    if (snapshot) store.put(snapshot);
  });
  return <ToolCallProgressStoreContext.Provider value={store}>{children}</ToolCallProgressStoreContext.Provider>;
}

const noSubscription = () => () => undefined;

/** Progress for a running tool row; null for any other row, which never re-renders for progress. */
export function useToolCallProgress(item: TaskChatToolItem): ToolCallProgressSnapshot | null {
  const store = useContext(ToolCallProgressStoreContext);
  const runId = useContext(ToolCallProgressRunContext);
  const running = item.status === "in_progress" && store !== null;
  useEffect(() => { if (running) store!.want(); }, [running, store]);
  return useSyncExternalStore(
    running ? store!.subscribe : noSubscription,
    () => (running ? pickToolCallProgress(store!.entries(), item, runId) : null),
  );
}

/**
 * The running row's progress: a bar that fills when the total is known (a
 * quiet sweep otherwise), the provider's latest message as plain text, and
 * elapsed time.
 */
export function TaskChatToolProgress({ progress, nowMs }: { progress: ToolCallProgressSnapshot; nowMs?: number }) {
  // The shared one-second ticker, only while no fixed time is given.
  useSecondTick(nowMs === undefined);
  const now = nowMs ?? Date.now();
  const fraction = toolCallProgressFraction(progress);
  const percent = fraction === null ? null : Math.round(fraction * 100);
  // Rendered as text only: React escapes it, and it is bounded again here.
  const message = boundToolCallProgressMessage(progress.message);
  const elapsed = formatDurationMs(Math.max(0, now - Date.parse(progress.startedAt)));
  return (
    <div
      className="ml-1.5 mt-0.5 flex min-w-0 max-w-full flex-col gap-1 border-l-2 border-border py-1 pl-2.5"
      data-testid="task-chat-tool-progress"
    >
      <div
        role="progressbar"
        aria-label={message ?? "Working"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        className="relative h-1 w-full overflow-hidden rounded-sm bg-muted"
      >
        <div
          data-testid={percent === null ? "task-chat-tool-progress-indeterminate" : "task-chat-tool-progress-fill"}
          className={cn(
            "absolute inset-y-0 left-0 rounded-sm bg-(--status-agent-running)",
            percent === null ? "tool-call-progress-sweep" : "tool-call-progress-fill",
          )}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <div className="flex min-w-0 items-baseline gap-2 text-(length:--text-micro) leading-4 text-muted-foreground">
        {message ? (
          <span className="min-w-0 flex-1 truncate" data-testid="task-chat-tool-progress-message">{message}</span>
        ) : <span className="flex-1" />}
        {percent !== null ? <span className="shrink-0 tabular-nums">{percent}%</span> : null}
        <span className="shrink-0 tabular-nums" data-testid="task-chat-tool-progress-elapsed">{elapsed}</span>
      </div>
    </div>
  );
}
