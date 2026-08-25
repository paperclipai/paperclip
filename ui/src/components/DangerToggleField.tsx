import { useState, type ReactNode } from "react";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

/**
 * A high-consequence toggle that requires an explicit confirm-on-enable
 * consequence dialog (wireframe 07). Turning the switch OFF applies
 * immediately; turning it ON opens a dialog that states the consequence and
 * must be confirmed before the change is applied. The consequence copy is
 * owned by the SecurityEngineer sign-off (PAP-14947) — pass it in, don't
 * invent it here.
 */
export function DangerToggleField({
  label,
  description,
  checked,
  onChange,
  disabled,
  confirmTitle,
  confirmBody,
  confirmActionLabel = "Enable",
  toggleTestId,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Dialog heading shown when enabling. Defaults to `Enable {label}?`. */
  confirmTitle?: string;
  /** The consequence statement shown in the confirm dialog. */
  confirmBody: ReactNode;
  confirmActionLabel?: string;
  toggleTestId?: string;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  function handleToggle(next: boolean) {
    if (next && !checked) {
      // Enabling a dangerous setting always requires confirmation.
      setConfirmOpen(true);
      return;
    }
    // Disabling (or a no-op) applies immediately.
    onChange(next);
  }

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <div className="text-sm">{label}</div>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <ToggleSwitch
        data-testid={toggleTestId}
        checked={checked}
        onCheckedChange={handleToggle}
        disabled={disabled}
        className="mt-0.5 shrink-0"
      />

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              {confirmTitle ?? `Enable ${label}?`}
            </DialogTitle>
            <DialogDescription>{confirmBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid={toggleTestId ? `${toggleTestId}-confirm` : undefined}
              onClick={() => {
                setConfirmOpen(false);
                onChange(true);
              }}
            >
              {confirmActionLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
