import type { PermissionKey } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "../i18n";
import { formatDelegatedPermissions, getSeatPermissionOptions } from "../lib/seat-permissions";

export function SeatPermissionsDialog({
  open,
  seatName,
  selectedPermissions,
  isPending,
  onOpenChange,
  onSelectedPermissionsChange,
  onSubmit,
}: {
  open: boolean;
  seatName?: string | null;
  selectedPermissions: PermissionKey[];
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectedPermissionsChange: (permissions: PermissionKey[]) => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  const seatPermissionOptions = getSeatPermissionOptions();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("seatDialogs.editDelegatedPermissions")}</DialogTitle>
          <DialogDescription>
            {seatName
              ? t("seatDialogs.permissionsDescription", { seatName })
              : t("seatDialogs.permissionsDescriptionFallback")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium">{t("seatDialogs.delegatedPermissions")}</label>
          <div className="space-y-2 rounded-md border border-border p-3">
            {seatPermissionOptions.map((option) => {
              const checked = selectedPermissions.includes(option.key);
              return (
                <label key={option.key} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(next) => {
                      onSelectedPermissionsChange(
                        next
                          ? Array.from(new Set([...selectedPermissions, option.key]))
                          : selectedPermissions.filter((value) => value !== option.key),
                      );
                    }}
                  />
                  <span>{option.label}</span>
                </label>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("seatDialogs.currentPermissions", {
              value: formatDelegatedPermissions(selectedPermissions) || t("common.none"),
            })}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button onClick={onSubmit} disabled={isPending}>
            {isPending ? t("seatDialogs.saving") : t("seatDialogs.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
