import { Check, ChevronDown, Sparkles } from "lucide-react";
import type { SavedTaskView } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  TASK_VIEW_GROUPS,
  isTaskViewKey,
  taskView,
  type TaskSurfaceViewKey,
} from "@/lib/task-views";
import { findSavedTaskView, savedTaskViewKey } from "@/lib/saved-task-views";
import { cn } from "@/lib/utils";

/**
 * The single control that replaced both the Inbox tab bar and the implicit
 * "all tasks" default on Tasks (PAP-670). One menu, grouped by scope, so the
 * nav does not have to grow a row every time a view is added.
 *
 * The user's own saved views are a third group in the same menu, for the same
 * reason: a view someone defined is still just a view.
 */
export function TaskViewsMenu({
  value,
  onChange,
  badgeCount,
  savedViews,
  onAddStarterViews,
  addStarterViewsPending = false,
}: {
  value: TaskSurfaceViewKey;
  onChange: (next: TaskSurfaceViewKey) => void;
  /** Unread count surfaced next to the My-work group, mirroring the nav badge. */
  badgeCount?: number;
  /** The signed-in user's saved views for this collection, if any are loaded. */
  savedViews?: readonly SavedTaskView[];
  /** Offered only when the user has no saved views yet. */
  onAddStarterViews?: () => void;
  addStarterViewsPending?: boolean;
}) {
  const activeSavedView = findSavedTaskView(savedViews, value);
  const activeLabel = isTaskViewKey(value)
    ? taskView(value).label
    // A `saved:` key whose view has not loaded (or was deleted elsewhere)
    // reads as "View" rather than leaking the raw id into the button.
    : activeSavedView?.name ?? "View";
  const hasSavedViews = (savedViews?.length ?? 0) > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1.5"
          aria-label={`Change view — currently ${activeLabel}`}
        >
          <span className="max-w-(--sz-160px) truncate font-medium">{activeLabel}</span>
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-(--sz-85vh) w-(--sz-260px) overflow-y-auto">
        {TASK_VIEW_GROUPS.map((group, groupIndex) => (
          <div key={group.label}>
            {groupIndex > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="flex items-center justify-between gap-2">
              <span>{group.label}</span>
              {groupIndex === 0 && badgeCount != null && badgeCount > 0 ? (
                <span className="rounded-full bg-primary px-1.5 text-(length:--text-nano) leading-tight text-primary-foreground">
                  {badgeCount > 99 ? "99+" : badgeCount}
                </span>
              ) : null}
            </DropdownMenuLabel>
            {group.views.map((view) => {
              const selected = view.key === value;
              return (
                <DropdownMenuItem
                  key={view.key}
                  onSelect={() => onChange(view.key)}
                  className="items-start gap-2"
                  aria-current={selected ? "true" : undefined}
                >
                  <Check
                    aria-hidden="true"
                    className={cn("mt-0.5 size-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")}
                  />
                  <span className="min-w-0">
                    <span className={cn("block truncate", selected && "font-medium")}>{view.label}</span>
                    <span className="block text-(length:--text-nano) text-muted-foreground">{view.hint}</span>
                  </span>
                </DropdownMenuItem>
              );
            })}
          </div>
        ))}

        {hasSavedViews || onAddStarterViews ? (
          <div>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Saved views</DropdownMenuLabel>
            {savedViews?.map((view) => {
              const key = savedTaskViewKey(view.id);
              const selected = key === value;
              return (
                <DropdownMenuItem
                  key={view.id}
                  onSelect={() => onChange(key)}
                  className="items-start gap-2"
                  aria-current={selected ? "true" : undefined}
                >
                  <Check
                    aria-hidden="true"
                    className={cn("mt-0.5 size-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")}
                  />
                  <span className={cn("min-w-0 truncate", selected && "font-medium")}>{view.name}</span>
                </DropdownMenuItem>
              );
            })}
            {!hasSavedViews && onAddStarterViews ? (
              <DropdownMenuItem
                disabled={addStarterViewsPending}
                onSelect={(event) => {
                  event.preventDefault();
                  onAddStarterViews();
                }}
                className="items-start gap-2"
              >
                <Sparkles aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate">Add starter views</span>
                  <span className="block text-(length:--text-nano) text-muted-foreground">
                    Ready to start, Active, Needs me and more — rename or delete any of them
                  </span>
                </span>
              </DropdownMenuItem>
            ) : null}
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
