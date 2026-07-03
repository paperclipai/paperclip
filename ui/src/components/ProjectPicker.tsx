import { useState } from "react";
import type { Project } from "@paperclipai/shared";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { FolderOpen } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Picker for assigning an agent to a project. Mirrors ReportsToPicker.
 *
 * When `required` is true (i.e. the agent has a manager and must be in a project),
 * the picker renders with a warning style and omits the "No project" option.
 */
export function ProjectPicker({
  projects,
  value,
  onChange,
  disabled = false,
  required = false,
  chooseLabel = "Choose project…",
}: {
  projects: Project[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  required?: boolean;
  chooseLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const rows = projects.filter((p) => !p.archivedAt);
  const current = value ? projects.find((p) => p.id === value) : null;
  const missingRequired = required && !current;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors",
            missingRequired && "border-amber-600/45 bg-amber-500/10 text-amber-900 dark:text-amber-200",
            disabled && "opacity-60 cursor-not-allowed",
          )}
          disabled={disabled}
        >
          <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">
            {current ? current.name : missingRequired ? "Project required" : chooseLabel}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="start">
        {!required && (
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
            No project
          </button>
        )}
        {required && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground border-b border-border mb-0.5">
            Agents with a manager must belong to a project.
          </div>
        )}
        {rows.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No projects in this company yet.
          </div>
        )}
        {rows.map((p) => (
          <button
            type="button"
            key={p.id}
            className={cn(
              "flex items-center gap-2 w-full min-w-0 px-2 py-1.5 text-xs rounded hover:bg-accent/50 overflow-hidden",
              p.id === value && "bg-accent",
            )}
            onClick={() => {
              onChange(p.id);
              setOpen(false);
            }}
          >
            {p.color ? (
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: p.color }}
              />
            ) : (
              <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 truncate">{p.name}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
