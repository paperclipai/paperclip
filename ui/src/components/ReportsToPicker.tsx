import { AgentAvatar } from "@/components/AgentAvatar";
import { useState, type ReactElement } from "react";
import type { Agent } from "@paperclipai/shared";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { User } from "lucide-react";
import { cn } from "../lib/utils";
import { roleLabels } from "./agent-config-primitives";
import { useTranslation } from "@/i18n";

export function ReportsToPicker({
  agents,
  value,
  onChange,
  disabled = false,
  excludeAgentIds = [],
  disabledEmptyLabel,
  chooseLabel,
  trigger,
  disabledAgentIds = [],
}: {
  agents: Agent[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  excludeAgentIds?: string[];
  disabledEmptyLabel?: string;
  chooseLabel?: string;
  trigger?: ReactElement;
  disabledAgentIds?: string[];
}) {
  const { t } = useTranslation();
  const emptyLabel = disabledEmptyLabel ?? t("agents.ReportsToPicker.disabledEmptyLabel");
  const pickerLabel = chooseLabel ?? t("agents.ReportsToPicker.chooseLabel");
  const [open, setOpen] = useState(false);
  const exclude = new Set(excludeAgentIds);
  const rows = agents.filter(
    (a) => a.status !== "terminated" && !exclude.has(a.id),
  );
  const current = value ? agents.find((a) => a.id === value) : null;
  const terminatedManager = current?.status === "terminated";
  const unknownManager = Boolean(value && !current);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? <button
          type="button"
          className={cn(
            "inline-flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors",
            terminatedManager && "border-amber-600/45 bg-amber-500/5",
            disabled && "opacity-60 cursor-not-allowed",
          )}
          disabled={disabled}
        >
          {unknownManager ? (
            <>
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate text-muted-foreground">{t("agents.ReportsToPicker.unknownManager")}</span>
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
                {terminatedManager ? t("agents.ReportsToPicker.reportsToTerminated", { name: current.name }) : t("agents.ReportsToPicker.reportsTo", { name: current.name })}
              </span>
            </>
          ) : (
            <>
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">
                {disabled ? emptyLabel : pickerLabel}
              </span>
            </>
          )}
        </button>}
      </PopoverTrigger>
      <PopoverContent className={trigger ? "w-64 max-h-80 overflow-y-auto p-1" : "w-48 p-1"} align="start" aria-label="Choose manager">
        <button
          type="button"
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
            value === null && "bg-accent",
          )}
          onClick={() => {
            onChange(null);
            setOpen(false);
          }}
        >
          {t("agents.ReportsToPicker.noManager")}
        </button>
        {terminatedManager && (
          <div className="flex min-w-0 items-center gap-2 overflow-hidden px-2 py-1.5 text-xs text-muted-foreground border-b border-border mb-0.5">
            <AgentAvatar agent={current} size={16} className="shrink-0 h-3 w-3"/>
            <span className="min-w-0 truncate">
              {t("agents.ReportsToPicker.currentTerminated", { name: current.name })}
            </span>
          </div>
        )}
        {unknownManager && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground border-b border-border mb-0.5">
            {t("agents.ReportsToPicker.missingManager")}
          </div>
        )}
        {rows.map((a) => (
          <button
            type="button"
            key={a.id}
            disabled={disabledAgentIds.includes(a.id)}
            title={disabledAgentIds.includes(a.id) ? "Would create a reporting loop" : undefined}
            className={cn(
              "flex items-center gap-2 w-full min-w-0 px-2 py-1.5 text-xs rounded hover:bg-accent/50 overflow-hidden disabled:opacity-50 disabled:cursor-not-allowed",
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
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
