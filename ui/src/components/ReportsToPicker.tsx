import { useState } from "react";
import type { Agent } from "@penclipai/shared";
import { useTranslation } from "react-i18next";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { User } from "lucide-react";
import { cn } from "../lib/utils";
import { roleLabels } from "./agent-config-primitives";
import { AgentIcon } from "./AgentIconPicker";
import { displaySeededName } from "../lib/seeded-display";

export function ReportsToPicker({
  agents,
  value,
  onChange,
  disabled = false,
  excludeAgentIds = [],
  disabledEmptyLabel,
  chooseLabel,
}: {
  agents: Agent[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  excludeAgentIds?: string[];
  disabledEmptyLabel?: string;
  chooseLabel?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const exclude = new Set(excludeAgentIds);
  const rows = agents.filter(
    (a) => a.status !== "terminated" && !exclude.has(a.id),
  );
  const current = value ? agents.find((a) => a.id === value) : null;
  const terminatedManager = current?.status === "terminated";
  const unknownManager = Boolean(value && !current);
  const resolvedDisabledEmptyLabel =
    disabledEmptyLabel ??
    t("Reports to: N/A (CEO)", {
      defaultValue: "Reports to: N/A (CEO)",
    });
  const resolvedChooseLabel =
    chooseLabel ??
    t("Reports to...", {
      defaultValue: "Reports to...",
    });
  const currentName = current ? displaySeededName(current.name) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
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
              <span className="min-w-0 truncate text-muted-foreground">
                {t("Unknown manager (stale ID)", {
                  defaultValue: "Unknown manager (stale ID)",
                })}
              </span>
            </>
          ) : current ? (
            <>
              <AgentIcon icon={current.icon} className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span
                className={cn(
                  "min-w-0 truncate",
                  terminatedManager && "text-amber-900 dark:text-amber-200",
                )}
              >
                {terminatedManager
                  ? t("Reports to {{name}} (terminated)", {
                      defaultValue: "Reports to {{name}} (terminated)",
                      name: currentName,
                    })
                  : t("Reports to {{name}}", {
                      defaultValue: "Reports to {{name}}",
                      name: currentName,
                    })}
              </span>
            </>
          ) : (
            <>
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">
                {disabled ? resolvedDisabledEmptyLabel : resolvedChooseLabel}
              </span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-1" align="start">
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
          {t("No manager", {
            defaultValue: "No manager",
          })}
        </button>
        {terminatedManager && (
          <div className="flex min-w-0 items-center gap-2 overflow-hidden px-2 py-1.5 text-xs text-muted-foreground border-b border-border mb-0.5">
            <AgentIcon icon={current.icon} className="shrink-0 h-3 w-3" />
            <span className="min-w-0 truncate">
              {t("Current: {{name}} (terminated)", {
                defaultValue: "Current: {{name}} (terminated)",
                name: currentName,
              })}
            </span>
          </div>
        )}
        {unknownManager && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground border-b border-border mb-0.5">
            {t("Saved manager is missing from this company. Choose a new manager or clear.", {
              defaultValue:
                "Saved manager is missing from this company. Choose a new manager or clear.",
            })}
          </div>
        )}
        {rows.map((a) => (
          <button
            type="button"
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
            <AgentIcon icon={a.icon} className="shrink-0 h-3 w-3 text-muted-foreground" />
            <span className="min-w-0 truncate">{displaySeededName(a.name)}</span>
            <span className="text-muted-foreground ml-auto shrink-0">{roleLabels[a.role] ?? a.role}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
