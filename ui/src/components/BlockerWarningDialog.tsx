import { Link2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { StatusIcon } from "./StatusIcon";
import type { IssueRelationIssueSummary } from "@paperclipai/shared";

const ACTIVE_STATUSES = new Set(["in_progress", "in_review", "done"]);

export function shouldWarnOnStatusChange(
  nextStatus: string,
  blockedBy?: IssueRelationIssueSummary[],
): boolean {
  if (!ACTIVE_STATUSES.has(nextStatus)) return false;
  if (!blockedBy?.length) return false;
  return blockedBy.some(
    (blocker) => blocker.status !== "done" && blocker.status !== "cancelled",
  );
}

interface BlockerWarningDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nextStatus: string;
  blockedBy: IssueRelationIssueSummary[];
  onConfirm: () => void;
}

export function BlockerWarningDialog({
  open,
  onOpenChange,
  nextStatus,
  blockedBy,
  onConfirm,
}: BlockerWarningDialogProps) {
  const unresolved = blockedBy.filter(
    (blocker) => blocker.status !== "done" && blocker.status !== "cancelled",
  );

  const targetLabel = nextStatus.replace(/_/g, " ");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-muted-foreground" />
            This issue has unresolved dependencies
          </DialogTitle>
          <DialogDescription>
            Moving this issue to <span className="font-medium">{targetLabel}</span> will let work
            begin before its blockers are done. The issue will not auto-unblock if you change its
            status now.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">
            Blocked by ({unresolved.length})
          </div>
          <ul className="space-y-1.5 max-h-60 overflow-y-auto">
            {unresolved.map((blocker) => (
              <li
                key={blocker.id}
                className="flex items-center gap-2 text-sm rounded border border-border px-2 py-1.5"
              >
                <StatusIcon status={blocker.status} />
                <span className="font-mono text-xs text-muted-foreground shrink-0">
                  {blocker.identifier ?? blocker.id.slice(0, 8)}
                </span>
                <span className="truncate">{blocker.title}</span>
              </li>
            ))}
          </ul>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            Change anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
