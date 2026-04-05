import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon: LucideIcon;
  message: string;
  action?: string;
  onAction?: () => void;
  secondaryAction?: string;
  onSecondaryAction?: () => void;
}

export function EmptyState({ icon: Icon, message, action, onAction, secondaryAction, onSecondaryAction }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-muted/50 p-4 mb-4">
        <Icon className="h-10 w-10 text-muted-foreground/50" />
      </div>
      <p className="text-sm text-muted-foreground mb-4">{message}</p>
      <div className="flex items-center gap-2">
        {action && onAction && (
          <Button onClick={onAction}>
            <Plus className="h-4 w-4 mr-1.5" />
            {action}
          </Button>
        )}
        {secondaryAction && onSecondaryAction && (
          <Button variant="outline" onClick={onSecondaryAction}>
            {secondaryAction}
          </Button>
        )}
      </div>
    </div>
  );
}
