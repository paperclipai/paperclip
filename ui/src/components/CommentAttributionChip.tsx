import { t, useTranslation, Trans } from "@/i18n";
import { UserCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "../lib/utils";

/**
 * "for {user}" chip on an agent comment posted to a task the agent does not own
 * (the open cross-task write design (attribution)).
 *
 * Cross-issue agent writes are open by default, so a thread can now contain
 * comments from agents that are not the assignee. The chip answers the question
 * that raises — *whose authority is this riding?* — by naming the responsible
 * user the run acted on behalf of. Rendered beside the already-visible author
 * name, it reads as "Fable · for Dotta"; the agent's own identity comes from the
 * surrounding header, so this component never repeats it.
 *
 * Terminology matches the rest of the app: "on behalf of {user}" / "responsible
 * user", never "impersonate".
 */
/**
 * Tooltip copy for the chip. Exported so the wording is unit-testable without
 * driving Radix's portal open.
 */
export function commentAttributionTooltip(agentName: string, userName: string): string {
  return (
    t("final-components-b:agentName_posted_this_on_behalf_of_userName_agentName_is_not_assigned__2c9927", { agentName, userName })
  );
}

export function CommentAttributionChip({
  agentName,
  userName,
  className,
}: {
  /** Author agent's display name — used in the tooltip, not the chip face. */
  agentName?: string | null;
  /** Responsible user's display name. Without it there is nothing to attribute. */
  userName?: string | null;
  className?: string;
}) {
  useTranslation("task-components");
  const user = userName?.trim();
  if (!user) return null;
  const agent = agentName?.trim() || "This agent";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          data-testid="comment-attribution-chip"
          aria-label={t("task-components:postedOnBehalfOf_b3e43753", { value1: user })}
          // `Badge` renders a span, which is not focusable — without this a
          // sighted keyboard user can never open the explanation. Radix opens
          // the tooltip on focus as well as hover.
          tabIndex={0}
          className={cn(
            "inline-flex max-w-40 items-center gap-1 whitespace-nowrap border-border px-1.5 py-0",
            "text-(length:--text-nano) font-medium tracking-normal text-muted-foreground",
            className,
          )}
        >
          <UserCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate"><Trans ns="task-components" i18nKey="sentence_412bba4532b2" components={{ part1: <>{user}</> }} /></span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">
        {commentAttributionTooltip(agent, user)}
      </TooltipContent>
    </Tooltip>
  );
}
