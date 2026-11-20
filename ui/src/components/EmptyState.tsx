import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useTx } from "@/i18n/tx";

interface EmptyStateProps {
  icon: LucideIcon;
  /** Large decorative artwork; shares hover/focus with the action below. */
  graphic?: ReactNode;
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
  icon: Icon,
  graphic,
  title,
  message,
  description,
  action,
  onAction,
  hideActionIcon = false,
}: EmptyStateProps) {
  const tx = useTx();
  return (
    <div className={graphic ? "empty-state-artwork flex flex-col items-center justify-center gap-5 py-16 text-center" : "flex flex-col items-center justify-center py-16 text-center"}>
      {graphic ? <div className="empty-state-graphic" aria-hidden="true">{graphic}</div> : <div className="bg-muted/50 p-4 mb-4">
        <Icon className="h-10 w-10 text-muted-foreground/50" />
      </div>}
      {title ? (
        <>
          <p className="text-base font-semibold text-foreground mb-1.5">{tx(title)}</p>
          <p className="text-sm text-muted-foreground mb-4 max-w-md">{tx(message)}</p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-foreground mb-1">{tx(message)}</p>
          {description && <p className="max-w-md text-sm text-muted-foreground mb-4">{tx(description)}</p>}
        </>
      )}
      {action && onAction && (
        <Button onClick={onAction}>
          {!hideActionIcon && <Plus className="h-4 w-4 mr-1.5" />}
          {action}
        </Button>
      )}
    </div>
  );
}
