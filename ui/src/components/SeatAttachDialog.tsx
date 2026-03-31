import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "../i18n";

export function SeatAttachDialog({
  open,
  seatName,
  userId,
  memberOptions,
  isLoadingMembers,
  isPending,
  onOpenChange,
  onUserIdChange,
  onSubmit,
}: {
  open: boolean;
  seatName?: string | null;
  userId: string;
  memberOptions: Array<{ userId: string; membershipRole: string | null }>;
  isLoadingMembers: boolean;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onUserIdChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("seatDialogs.attachHumanOperator")}</DialogTitle>
          <DialogDescription>
            {seatName
              ? t("seatDialogs.attachDescription", { seatName })
              : t("seatDialogs.attachDescriptionFallback")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium">{t("seatDialogs.companyMember")}</label>
          <select
            value={userId}
            onChange={(event) => onUserIdChange(event.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">{t("seatDialogs.selectMember")}</option>
            {memberOptions.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.userId}{member.membershipRole ? ` (${member.membershipRole})` : ""}
              </option>
            ))}
          </select>
          {isLoadingMembers ? (
            <p className="text-xs text-muted-foreground">{t("seatDialogs.loadingActiveMembers")}</p>
          ) : memberOptions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("seatDialogs.noActiveMembers")}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button onClick={onSubmit} disabled={!userId.trim() || isPending || isLoadingMembers || memberOptions.length === 0}>
            {isPending ? t("seatDialogs.attaching") : t("common.attach")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
