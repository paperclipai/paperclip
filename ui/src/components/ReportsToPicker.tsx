import { AgentAvatar } from "@/components/AgentAvatar";
import { useState } from "react";
import type { Agent } from "@paperclipai/shared";
import { SelectPopover, SelectPopoverItem } from "@/components/ui/select";
import { User } from "lucide-react";
import { cn } from "../lib/utils";
import { roleLabels } from "./agent-config-primitives";

export function ReportsToPicker({
  agents,
  value,
  onChange,
  disabled = false,
  compact = true,
  excludeAgentIds = [],
  disabledEmptyLabel = "Reports to: N/A (CEO)",
  chooseLabel = "Reports to...",
}: {
  agents: Agent[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  compact?: boolean;
  excludeAgentIds?: string[];
  disabledEmptyLabel?: string;
  chooseLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const exclude = new Set(excludeAgentIds);
  const rows = agents.filter(
    (a) => a.status !== "terminated" && !exclude.has(a.id),
  );
  const current = value ? agents.find((a) => a.id === value) : null;
  const terminatedManager = current?.status === "terminated";
  const unknownManager = Boolean(value && !current);

  return (
    <SelectPopover aria-label="Reports to" value={value ?? ""}
      open={open} onOpenChange={setOpen} disabled={disabled}
      className={cn(compact && "w-auto max-w-full data-[size=default]:h-auto px-2 py-1 text-xs", terminatedManager && "border-amber-600/45 bg-amber-500/5")}
      displayValue={<span className="inline-flex min-w-0 items-center gap-1.5">{unknownManager ? (
            <>
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate text-muted-foreground">Unknown manager (stale ID)</span>
            </>
          ) : current ? (
            <>
              <AgentAvatar agent={current} size={16} className="h-3 w-3 shrink-0 text-muted-foreground"/>
              <span
                className={cn(
                  "min-w-0 truncate",
                  terminatedManager && "text-amber-900 dark:text-amber-200",
                )}
              >
                {`Reports to ${current.name}${terminatedManager ? " (terminated)" : ""}`}
              </span>
            </>
          ) : (
            <>
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">
                {disabled ? disabledEmptyLabel : chooseLabel}
              </span>
            </>
          )}</span>}
    >
      <div role="listbox" aria-label="Reports to">
        <SelectPopoverItem
          selected={value === null}
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
            value === null && "bg-accent",
          )}
          onClick={() => {
            onChange(null);
            setOpen(false);
          }}
        >
          No manager
        </SelectPopoverItem>
        {terminatedManager && (
          <div className="flex min-w-0 items-center gap-2 overflow-hidden px-2 py-1.5 text-xs text-muted-foreground border-b border-border mb-0.5">
            <AgentAvatar agent={current} size={16} className="shrink-0 h-3 w-3"/>
            <span className="min-w-0 truncate">
              Current: {current.name} (terminated)
            </span>
          </div>
        )}
        {unknownManager && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground border-b border-border mb-0.5">
            Saved manager is missing from this organization. Choose a new manager or clear.
          </div>
        )}
        {rows.map((a) => (
          <SelectPopoverItem
            selected={a.id === value}
            key={a.id}
            className={cn(
              "flex items-center gap-2 w-full min-w-0 px-2 py-1.5 text-xs rounded hover:bg-accent/50 overflow-hidden",
              a.id === value && "bg-accent",
            )}
            onClick={() => {
              onChange(a.id);
              setOpen(false);
            }}
          >
            <AgentAvatar agent={a} size={16} className="shrink-0 h-3 w-3 text-muted-foreground"/>
            <span className="min-w-0 truncate">{a.name}</span>
            <span className="text-muted-foreground ml-auto shrink-0">{roleLabels[a.role] ?? a.role}</span>
          </SelectPopoverItem>
        ))}
      </div>
    </SelectPopover>
  );
}
