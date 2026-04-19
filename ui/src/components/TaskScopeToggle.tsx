import { cn } from "../lib/utils";

export type TaskScope = "all" | "my";

export function TaskScopeToggle({
  value,
  onChange,
  showMy,
}: {
  value: TaskScope;
  onChange: (value: TaskScope) => void;
  showMy: boolean;
}) {
  if (!showMy) return null;

  return (
    <div className="inline-flex rounded-md border border-border p-0.5" aria-label="Task scope">
      {(["all", "my"] as const).map((scope) => (
        <button
          key={scope}
          type="button"
          className={cn(
            "min-w-12 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
            value === scope
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
          onClick={() => onChange(scope)}
        >
          {scope === "all" ? "All" : "My"}
        </button>
      ))}
    </div>
  );
}
