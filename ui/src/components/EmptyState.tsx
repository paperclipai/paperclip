import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon: LucideIcon;
  title?: string;
  message: string;
  action?: string;
  onAction?: () => void;
}

export function EmptyState({ icon: Icon, title, message, action, onAction }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-muted/50 p-4 mb-4">
        <Icon className="h-10 w-10 text-muted-foreground/50" />
      </div>
      {title ? <p className="mb-1 text-sm font-semibold text-foreground">{title}</p> : null}
      <p className="text-sm text-muted-foreground mb-4">{message}</p>
      {action && onAction && (
        <Button onClick={onAction}>
          <Plus className="h-4 w-4 mr-1.5" />
          {action}
        </Button>
      )}
    </div>
  );
}
