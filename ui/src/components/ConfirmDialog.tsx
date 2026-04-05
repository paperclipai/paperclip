import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertTriangle } from "lucide-react";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  /** When set, user must type this exact string to enable the confirm button. */
  typedConfirmation?: string;
  onConfirm: () => void;
  onCancel?: () => void;
  isPending?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  typedConfirmation,
  onConfirm,
  onCancel,
  isPending,
}: ConfirmDialogProps) {
  const [typedValue, setTypedValue] = useState("");

  // Reset typed value when dialog opens/closes
  useEffect(() => {
    if (!open) setTypedValue("");
  }, [open]);

  const isDestructive = variant === "destructive";
  const needsTypedMatch = Boolean(typedConfirmation);
  const typedMatch = !needsTypedMatch || typedValue === typedConfirmation;

  const handleCancel = () => {
    onCancel?.();
    onOpenChange(false);
  };

  const handleConfirm = () => {
    if (!typedMatch) return;
    onConfirm();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isDestructive && (
              <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
            )}
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {needsTypedMatch && (
          <div className="space-y-2 pt-1">
            <p className="text-sm text-muted-foreground">
              Type <span className="font-mono font-semibold text-foreground">{typedConfirmation}</span> to confirm:
            </p>
            <Input
              value={typedValue}
              onChange={(e) => setTypedValue(e.target.value)}
              placeholder={typedConfirmation}
              autoFocus
              className="font-mono"
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={isPending}>
            {cancelLabel}
          </Button>
          <Button
            variant={isDestructive ? "destructive" : "default"}
            onClick={handleConfirm}
            disabled={!typedMatch || isPending}
          >
            {isPending ? "Processing..." : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
