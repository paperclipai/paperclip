import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  /** Retained for callers that supplied a section icon before the shared brand artwork. */
  icon?: LucideIcon;
  /** Large decorative artwork; shares hover/focus with the action below. */
  graphic?: ReactNode;
  placement?: "center" | "upper";
  /** Optional bold heading rendered above the message. */
  title?: string;
  message: string;
  /** Optional secondary line rendered under the primary message. */
  description?: string;
  action?: string;
  onAction?: () => void;
  /** Hide the leading "+" glyph on the action button (e.g. for a "Set up" CTA). */
  hideActionIcon?: boolean;
}

export function EmptyState({
  graphic,
  placement = "center",
  title,
  message,
  description,
  action,
  onAction,
  hideActionIcon = false,
}: EmptyStateProps) {
  return (
    <div className="empty-state empty-state-artwork grid w-full flex-1 justify-items-center text-center" data-placement={placement}>
      <div className={cn("flex flex-col items-center justify-center gap-5", placement === "center" && "py-6")}>
        <div className="empty-state-graphic" aria-hidden="true">
          {graphic ?? <span className="empty-state-logo" />}
        </div>
        <div className="max-w-md space-y-1.5">
          {title && <p className="text-base font-semibold text-foreground">{title}</p>}
          <p className="whitespace-pre-line text-sm text-muted-foreground">{message}</p>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {action && onAction && (
          <Button onClick={onAction}>
            {!hideActionIcon && <Plus className="h-4 w-4 mr-1.5" />}
            {action}
          </Button>
        )}
      </div>
    </div>
  );
}
