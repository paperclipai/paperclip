import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function RejectApprovalDialog({
  open,
  onOpenChange,
  isPending,
  onReject,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isPending: boolean;
  onReject: (reason?: string) => void;
}) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject approval</DialogTitle>
          <DialogDescription>
            Explain why so the requesting agent can learn from it. Rejecting without a reason is
            still possible, but requires a deliberate, separate click below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label className="text-xs">Reason</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this being rejected?"
            rows={4}
            autoFocus
          />
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => onReject(undefined)}
            disabled={isPending}
          >
            Reject without reason
          </Button>
          <Button
            variant="destructive"
            onClick={() => onReject(reason.trim() || undefined)}
            disabled={isPending || reason.trim().length === 0}
          >
            {isPending ? "Rejecting..." : "Reject with reason"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
