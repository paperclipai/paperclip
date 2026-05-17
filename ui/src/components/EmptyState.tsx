import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon: LucideIcon;
  message: string;
  action?: string;
  onAction?: () => void;
}

export function EmptyState({ icon: Icon, message, action, onAction }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {/* Nothing-Phone glyph: concentric dotted ring around the icon. Two
          dashed rings + a third solid border give a faint LED-ring feel. */}
      <div className="relative mb-6 flex h-24 w-24 items-center justify-center">
        <span className="absolute inset-0 rounded-full border border-dashed border-muted-foreground/30" aria-hidden="true" />
        <span className="absolute inset-2 rounded-full border border-dotted border-muted-foreground/20" aria-hidden="true" />
        <span className="absolute inset-4 rounded-full border border-muted-foreground/15" aria-hidden="true" />
        <Icon className="h-9 w-9 text-muted-foreground/60" />
      </div>
      <p className="font-display text-base text-muted-foreground mb-5">{message}</p>
      {action && onAction && (
        <Button onClick={onAction}>
          <Plus className="h-4 w-4 mr-1.5" />
          {action}
        </Button>
      )}
    </div>
  );
}
