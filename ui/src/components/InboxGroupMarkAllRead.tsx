import { useState } from "react";
import { CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type InboxGroupMarkAllReadProps = {
  groupLabel: string;
  unreadCount: number;
  pending?: boolean;
  onConfirm: () => void;
};

/** "Mark all as read" for one inbox group header, with one confirm step. */
export function InboxGroupMarkAllRead({
  groupLabel,
  unreadCount,
  pending = false,
  onConfirm,
}: InboxGroupMarkAllReadProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (unreadCount === 0) return null;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        title={`Mark all in ${groupLabel} as read`}
        aria-label={`Mark all in ${groupLabel} as read`}
        disabled={pending}
        onClick={(event) => {
          event.stopPropagation();
          setConfirmOpen(true);
        }}
      >
        <CheckCheck />
        <span className="hidden sm:inline">{pending ? "Marking…" : "Mark all as read"}</span>
      </Button>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md" onClick={(event) => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Mark all in {groupLabel} as read?</DialogTitle>
            <DialogDescription>
              This will mark {unreadCount} unread {unreadCount === 1 ? "item" : "items"} in {groupLabel} as read.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirmOpen(false);
                onConfirm();
              }}
            >
              Mark all as read
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
