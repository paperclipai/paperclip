import { useId, useState } from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TaskChatItem } from "./task-chat-model";

/** One MCP server that the harness could not start for this run. */
export interface TaskChatMcpStartupFailure {
  id: string;
  serverName: string;
  /** Provider-reported reason, already bounded by the runner. */
  reason: string | null;
}

export const MCP_STARTUP_FAILED_CATEGORY = "mcp_server_startup_failed";

function detailValue(item: Extract<TaskChatItem, { kind: "protocol" }>, label: string) {
  if (item.surface !== "provider_activity") return undefined;
  return item.details.find((detail) => detail.label === label)?.value;
}

function isMcpStartupFailure(item: TaskChatItem): item is Extract<TaskChatItem, { kind: "protocol"; surface: "provider_activity" }> {
  return item.kind === "protocol"
    && item.surface === "provider_activity"
    && item.family === "provider_notice"
    && detailValue(item, "Category") === MCP_STARTUP_FAILED_CATEGORY;
}

/**
 * Lifts MCP startup failures out of a run's items so they render once as the
 * run-health banner instead of as inline notice rows. Later reports for the
 * same server replace earlier ones.
 */
export function partitionRunHealthItems(items: readonly TaskChatItem[]): {
  failures: TaskChatMcpStartupFailure[];
  rest: TaskChatItem[];
} {
  const byServer = new Map<string, TaskChatMcpStartupFailure>();
  const rest: TaskChatItem[] = [];
  for (const item of items) {
    if (!isMcpStartupFailure(item)) {
      rest.push(item);
      continue;
    }
    const serverName = detailValue(item, "server") ?? "An";
    byServer.set(serverName, { id: item.id, serverName, reason: detailValue(item, "reason") ?? null });
  }
  // Keep the caller's array identity when nothing was lifted out.
  return { failures: [...byServer.values()], rest: byServer.size === 0 ? (items as TaskChatItem[]) : rest };
}

function failureLine(failure: TaskChatMcpStartupFailure) {
  return (
    <>
      <span className="font-medium text-foreground">{failure.serverName}</span>
      <span> MCP server failed to start</span>
      {failure.reason ? <span className="text-muted-foreground">: {failure.reason}</span> : null}
    </>
  );
}

/**
 * Run-level health warning shown directly under the runner header. A failed
 * MCP server explains a whole class of runs where the agent says it cannot
 * reach its tools, so it stays visible above the transcript instead of
 * scrolling away as one more activity row.
 */
export function TaskChatRunHealthBanner({ failures }: { failures: readonly TaskChatMcpStartupFailure[] }) {
  const [open, setOpen] = useState(false);
  const listId = `task-chat-run-health-${useId().replaceAll(":", "")}`;
  if (failures.length === 0) return null;
  const single = failures.length === 1 ? failures[0] : null;
  return (
    <div
      role="status"
      className="my-1 flex min-w-0 flex-col gap-1 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground"
      data-testid="task-chat-run-health-banner"
    >
      <button
        type="button"
        className="group/health flex min-w-0 items-center gap-2 text-left"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        <TriangleAlert className="size-(--sz-protocol-notice-icon) shrink-0 text-(--status-task-icon-todo)" aria-hidden />
        <span className={cn("min-w-0 flex-1", open ? "whitespace-normal break-words" : "truncate")}>
          {single ? failureLine(single) : (
            <>
              <span className="font-medium text-foreground">{failures.length} MCP servers</span>
              <span> failed to start: </span>
              <span className="text-muted-foreground">{failures.map((failure) => failure.serverName).join(", ")}</span>
            </>
          )}
        </span>
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 transition-transform", open ? "rotate-90" : "opacity-60 group-hover/health:opacity-100")}
          aria-hidden
        />
      </button>
      {open ? (
        <div id={listId} className="flex flex-col gap-1 pl-5">
          {single ? null : failures.map((failure) => (
            <p key={failure.id} className="min-w-0 whitespace-pre-wrap break-words">{failureLine(failure)}</p>
          ))}
          <p>The agent ran without these tools. Fix the server&apos;s command or credentials, then try again.</p>
        </div>
      ) : null}
    </div>
  );
}
