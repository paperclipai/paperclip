import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlyphRing } from "./NothingAesthetic";

interface EmptyStateProps {
  icon: LucideIcon;
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
  title,
  message,
  description,
  action,
  onAction,
  hideActionIcon = false,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {/* Nothing-Phone glyph: concentric dotted ring around the icon. Two
          dashed rings + a third solid border give a faint LED-ring feel. */}
      <div className="relative mb-6 flex h-24 w-24 items-center justify-center">
        <GlyphRing tone="muted" className="absolute inset-0 h-full w-full text-muted-foreground/70" />
        <span className="absolute inset-6 rounded-full border border-dotted border-muted-foreground/20" aria-hidden="true" />
        <Icon className="h-9 w-9 text-muted-foreground/60" />
      </div>
      {title ? (
        <>
          <p className="text-base font-semibold text-foreground mb-1.5">{title}</p>
          <p className="text-sm text-muted-foreground mb-4 max-w-md">{message}</p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-foreground mb-1">{message}</p>
          {description && <p className="max-w-md text-sm text-muted-foreground mb-4">{description}</p>}
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
