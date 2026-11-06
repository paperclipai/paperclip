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
import { useTranslation } from "@/i18n";

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
  const { t } = useTranslation();
  if (!kind || !profile) return null;

  const defaultDeleteBlocked = kind === "delete" && profile.summary.isCompanyDefault;
  const copy = {
    archive: {
      title: t("tools.profiles.dialogs.archiveTitle", { defaultValue: "Archive profile" }),
      body: t("tools.profiles.dialogs.archiveBody", {
        count: profile.summary.appliesToAgentCount,
        agentWord:
          profile.summary.appliesToAgentCount === 1
            ? t("common.agent", { defaultValue: "agent" })
            : t("common.agents", { defaultValue: "agents" }),
        defaultValue: `This profile stops applying to ${profile.summary.appliesToAgentCount} ${profile.summary.appliesToAgentCount === 1 ? "agent" : "agents"}. You can restore it later.`,
      }),
      confirm: t("tools.profiles.index.archive", { defaultValue: "Archive" }),
      action: onArchive,
    },
    restore: {
      title: t("tools.profiles.dialogs.restoreTitle", { defaultValue: "Restore profile" }),
      body: t("tools.profiles.dialogs.restoreBody", {
        defaultValue: "This profile will be active again and can be assigned to agents.",
      }),
      confirm: t("tools.profiles.index.restore", { defaultValue: "Restore" }),
      action: onRestore,
    },
    delete: {
      title: t("tools.profiles.dialogs.deleteTitle", { defaultValue: "Delete profile" }),
      body: defaultDeleteBlocked
        ? t("tools.profiles.dialogs.deleteBlocked", {
            defaultValue:
              "This profile is the organization default. Reassign the organization default to another profile before deleting it.",
          })
        : t("tools.profiles.dialogs.deleteBody", {
            count: profile.summary.assignmentCount,
            assignmentWord: profile.summary.assignmentCount === 1 ? "assignment" : "assignments",
            defaultValue: `This permanently deletes the profile and removes ${profile.summary.assignmentCount} ${profile.summary.assignmentCount === 1 ? "assignment" : "assignments"}.`,
          }),
      confirm: t("tools.profiles.index.delete", { defaultValue: "Delete" }),
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
            <span>
              {t("tools.profiles.dialogs.deleteBlockedNote", {
                defaultValue: "Choose another access profile and make it the organization default first.",
              })}
            </span>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel", { defaultValue: "Cancel" })}
          </Button>
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
