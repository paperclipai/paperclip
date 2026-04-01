import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { Link } from "@/lib/router";

interface TierLimitModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  message: string;
  limit: string;
  currentPlan: string;
}

export function TierLimitModal({
  open,
  onOpenChange,
  message,
  limit,
  currentPlan,
}: TierLimitModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            <DialogTitle>Plan Limit Reached</DialogTitle>
          </div>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>

        <div className="bg-muted/50 rounded p-3 text-sm space-y-1">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Current plan</span>
            <span className="font-medium capitalize">{currentPlan}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Limit</span>
            <span className="font-medium">{limit}</span>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Link to="/settings/billing">
            <Button onClick={() => onOpenChange(false)}>
              Upgrade Now
            </Button>
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}
