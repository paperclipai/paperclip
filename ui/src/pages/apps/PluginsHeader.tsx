import { ChevronDown, ChevronRight } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ANALYTICS_MASK_CLASS } from "@/lib/analytics/privacy";
import { useReviewCount } from "./useReviewCount";

export type PluginsAddOption = { id: string; title: string; description: string; href: string };

/** Opens the Review page, and counts the requests waiting for the user's OK when there are any. */
function ReviewButton() {
  const count = useReviewCount();
  return (
    <Button asChild variant="ghost" className="h-9 shrink-0 gap-2 px-3 text-muted-foreground">
      <Link to="/apps/review" aria-label={count > 0 ? `${count} to review, open Review` : "Open Review"}>
        {count > 0 ? (
          <span className="inline-flex h-6 items-center rounded-md bg-(--status-task-todo)/15 px-2 text-xs font-normal text-(--status-task-icon-todo) tabular-nums">
            {count} to review
          </span>
        ) : (
          "Review"
        )}
        <ChevronRight className="size-4" aria-hidden />
      </Link>
    </Button>
  );
}

/** Page header for the Plugins marketplace: title, the Review shortcut, and the Add menu for bringing your own. */
export function PluginsHeader({ options, onNavigate }: { options: PluginsAddOption[]; onNavigate: (href: string) => void }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-2xl leading-8 font-semibold tracking-tight text-foreground">Plugins</p>
        <p className="text-sm leading-5 text-muted-foreground">
          Connect the apps your agents work in. Some come with skills you can add along the way.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ReviewButton />
        {options.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" className="h-9 shrink-0 px-4">
                Add
                <ChevronDown className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={`w-72 ${ANALYTICS_MASK_CLASS}`}>
              {options.map((option) => (
                <DropdownMenuItem key={option.id} className="flex flex-col items-start gap-0.5 py-2" onSelect={() => onNavigate(option.href)}>
                  <span className="text-sm font-semibold text-foreground">{option.title}</span>
                  <span className="text-xs text-muted-foreground">{option.description}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}
