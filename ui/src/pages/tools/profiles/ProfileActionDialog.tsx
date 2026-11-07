import { useTranslation } from "@/i18n";
import { AlertTriangle } from "lucide-react";
import type { ToolProfileWithDetails } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ProfileActionDialogKind = "archive" | "delete" | "restore";

export function ProfileActionDialog({
  kind,
  profile,
  pending,
  onClose,
  onArchive,
  onRestore,
  onDelete,
}: {
  kind: ProfileActionDialogKind | null;
  profile: ToolProfileWithDetails | null;
  pending: boolean;
  onClose: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  if (!kind || !profile) return null;

  const defaultDeleteBlocked = kind === "delete" && profile.summary.isCompanyDefault;
  const copy = {
    archive: {
      title: translateAgentPage("agents:archive_profile"),
      body: translateAgentPage("agents:this_profile_stops_applying_to_you_can_restore_count", { value1: profile.summary.appliesToAgentCount, count: profile.summary.appliesToAgentCount }),
      confirm: translateAgentPage("agents:archive"),
      action: onArchive,
    },
    restore: {
      title: translateAgentPage("agents:restore_profile"),
      body: translateAgentPage("agents:this_profile_will_be_active_again_and_can"),
      confirm: translateAgentPage("agents:restore"),
      action: onRestore,
    },
    delete: {
      title: translateAgentPage("agents:delete_profile"),
      body: defaultDeleteBlocked
        ? translateAgentPage("agents:this_profile_is_the_organization_default_reassign_the")
        : translateAgentPage("agents:this_permanently_deletes_the_profile_and_removes_count", { value1: profile.summary.assignmentCount, count: profile.summary.assignmentCount }),
      confirm: translateAgentPage("agents:delete_f6fdbe"),
      action: onDelete,
    },
  }[kind];

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>
        {defaultDeleteBlocked ? (
          <div className="flex gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{translateAgentPage("agents:choose_another_access_profile_and_make_it_the")}</span>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{translateAgentPage("agents:cancel")}</Button>
          <Button
            variant={kind === "delete" ? "destructive" : "default"}
            disabled={pending || defaultDeleteBlocked}
            onClick={copy.action}
          >
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
