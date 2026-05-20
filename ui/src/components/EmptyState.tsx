import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon: LucideIcon;
  message?: string;
  title?: string;
  description?: string;
  action?: string;
  onAction?: () => void;
}

export function EmptyState({ icon: Icon, message, title, description, action, onAction }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-muted/50 p-4 mb-4">
        <Icon className="h-10 w-10 text-muted-foreground/50" />
      </div>
      {title && <h3 className="text-base font-medium mb-1">{title}</h3>}
      {description && <p className="text-sm text-muted-foreground mb-4">{description}</p>}
      {message && !description && <p className="text-sm text-muted-foreground mb-4">{message}</p>}
      {action && onAction && (
        <Button onClick={onAction}>
          <Plus className="h-4 w-4 mr-1.5" />
          {action}
        </Button>
      )}
    </div>
  );
}
