import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon: LucideIcon;
  message: string;
  description?: string;
  action?: string;
  onAction?: () => void;
}

export function EmptyState({ icon: Icon, message, description, action, onAction }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center animate-page-enter">
      <div className="p-5 mb-5 border border-dashed border-border/80 text-primary/50">
        <Icon className="h-10 w-10" />
      </div>
      <p className="text-sm text-muted-foreground mb-1 max-w-sm">{message}</p>
      {description && (
        <p className="text-xs text-muted-foreground/70 mb-5 max-w-md leading-relaxed">{description}</p>
      )}
      {!description && <div className="mb-4" />}
      {action && onAction && (
        <Button onClick={onAction}>
          <Plus className="h-4 w-4 mr-1.5" />
          {action}
        </Button>
      )}
    </div>
  );
}
