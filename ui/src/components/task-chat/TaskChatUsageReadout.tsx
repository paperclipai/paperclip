import { cn } from "@/lib/utils";
import { Gauge } from "lucide-react";
import type { TaskChatUsageItem } from "./task-chat-model";

/**
 * Second-tier live token/cost readout (ACP UsageUpdate). Concrete progress —
 * context fill %, tokens, and cost — rather than an indeterminate spinner.
 * Recedes to metadata weight so it never competes with message content.
 */
export function TaskChatUsageReadout({ item }: { item: TaskChatUsageItem }) {
  const { used, size, inputTokens, outputTokens, costUsd } = item.usage;
  const contextWindowSize = typeof size === "number" && size > 0 ? size : null;
  const pct = contextWindowSize ? Math.min(100, Math.round((used / contextWindowSize) * 100)) : 0;
  return (
    <div className="flex flex-col gap-1 px-1 py-1 text-(length:--text-micro) text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <Gauge className="h-3 w-3" />
        {item.label ? <span className="font-medium">{item.label}</span> : null}
        {contextWindowSize ? (
          <span>
            {used.toLocaleString()}/{contextWindowSize.toLocaleString()} ctx ({pct}%)
          </span>
        ) : null}
        {inputTokens != null || outputTokens != null ? (
          <span>
            · ↑{(inputTokens ?? 0).toLocaleString()} ↓{(outputTokens ?? 0).toLocaleString()}
          </span>
        ) : null}
        {costUsd != null ? <span>· ${costUsd.toFixed(4)}</span> : null}
      </div>
      {item.detail ? <div>{item.detail}</div> : null}
      {contextWindowSize ? (
        <div className="h-1 w-full overflow-hidden rounded-full bg-border">
          <div
            className={cn("h-full rounded-full bg-(--status-agent-running)")}
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
