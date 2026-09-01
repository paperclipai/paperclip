import { useMemo } from "react";
import { SearchableSelect } from "@/components/SearchableSelect";
import {
  buildReusableExecutionWorktreeOptionGroups,
  reusableWorktreeOptionMatches,
  scoreReusableWorktreeOptionMatch,
  type ReusableExecutionWorktreeLike,
  type ReusableWorktreeOption,
} from "@/lib/reusable-execution-worktrees";
import { cn } from "@/lib/utils";

const COMPACT_TRIGGER_CLASS = "h-8 px-2 py-1.5 text-xs font-normal";

interface ReusableExecutionWorktreeSelectProps<TWorktree extends ReusableExecutionWorktreeLike> {
  value: string;
  worktrees: readonly TWorktree[];
  onValueChange: (worktreeId: string, option: ReusableWorktreeOption<TWorktree>) => void;
  placeholder?: string;
  loading?: boolean;
  error?: boolean;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  disablePortal?: boolean;
}

export function ReusableExecutionWorktreeSelect<TWorktree extends ReusableExecutionWorktreeLike>({
  value,
  worktrees,
  onValueChange,
  placeholder = "Choose an existing worktree",
  loading = false,
  error = false,
  disabled = false,
  className,
  triggerClassName,
  disablePortal,
}: ReusableExecutionWorktreeSelectProps<TWorktree>) {
  const groups = useMemo(() => buildReusableExecutionWorktreeOptionGroups(worktrees), [worktrees]);

  return (
    <SearchableSelect<string, ReusableWorktreeOption<TWorktree>>
      value={value}
      groups={groups}
      onValueChange={onValueChange}
      placeholder={placeholder}
      searchPlaceholder="Search worktrees..."
      emptyMessage={error ? "Worktrees failed to load." : "No matching worktrees."}
      loadingMessage="Loading worktrees..."
      loading={loading}
      disabled={disabled}
      className={className}
      triggerClassName={cn(COMPACT_TRIGGER_CLASS, triggerClassName)}
      filterOption={reusableWorktreeOptionMatches}
      scoreOption={scoreReusableWorktreeOptionMatch}
      disablePortal={disablePortal}
      renderOption={(option, { selected }) => (
        <span className="flex min-w-0 flex-col">
          <span className={cn("truncate", selected && "font-medium")}>{option.label}</span>
          <span className="truncate text-(length:--text-micro) text-muted-foreground">
            {option.workspace.status ? `${option.workspace.status} - ` : ""}
            {option.description}
          </span>
        </span>
      )}
    />
  );
}
