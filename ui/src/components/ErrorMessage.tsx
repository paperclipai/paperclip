import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ErrorMessage({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex items-center gap-3 p-4 rounded-lg bg-destructive/10 text-destructive text-sm">
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span className="flex-1">{message}</span>
      {onRetry && (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
