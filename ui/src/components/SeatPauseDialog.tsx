import type { SeatPauseReason } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatSeatPauseReason } from "../lib/seat-pause";
import { useI18n } from "../i18n";

type OperatorManagedSeatPauseReason = Exclude<SeatPauseReason, "budget_enforcement">;

const pauseReasonOptions: OperatorManagedSeatPauseReason[] = ["manual_admin", "maintenance"];

export function SeatPauseDialog({
  open,
  seatName,
  pauseReason,
  isPending,
  onOpenChange,
  onPauseReasonChange,
  onSubmit,
}: {
  open: boolean;
  seatName?: string | null;
  pauseReason: OperatorManagedSeatPauseReason;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onPauseReasonChange: (reason: OperatorManagedSeatPauseReason) => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("seatDialogs.pauseSeat")}</DialogTitle>
          <DialogDescription>
            {seatName
              ? t("seatDialogs.pauseDescription", { seatName })
              : t("seatDialogs.pauseDescriptionFallback")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium">{t("seatDialogs.pauseReason")}</label>
          <select
            value={pauseReason}
            onChange={(event) => onPauseReasonChange(event.target.value as OperatorManagedSeatPauseReason)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {pauseReasonOptions.map((option) => (
              <option key={option} value={option}>
                {formatSeatPauseReason(option)}
              </option>
            ))}
          </select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button onClick={onSubmit} disabled={isPending}>
            {isPending ? t("seatDialogs.saving") : t("common.pauseSeat")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
