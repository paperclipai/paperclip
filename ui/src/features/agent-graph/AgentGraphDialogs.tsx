import type { AgentGraphDraft } from "@paperclipai/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import { roleLabel } from "./AgentGraphNodes";

export interface PendingReparent {
  agentId: string;
  agentName: string;
  fromName: string | null;
  toId: string | null;
  toName: string | null;
  fromId: string | null;
  origin: "edit" | "undo" | "redo";
}

export function ReparentDialog({
  pending,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  pending: PendingReparent | null;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && !busy && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Change reporting line?</AlertDialogTitle>
          <AlertDialogDescription>
            {pending
              ? `${pending.agentName} will ${pending.toName ? `report to ${pending.toName}` : "have no manager"} instead of ${pending.fromName ? `reporting to ${pending.fromName}` : "having no manager"}. This changes the organization for everyone, follows your permissions, and is recorded in the activity log.`
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {busy ? "Saving…" : "Change reporting line"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function HireDraftDialog({
  draft,
  managerName,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  draft: AgentGraphDraft | null;
  managerName: string | null;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={draft !== null} onOpenChange={(open) => !open && !busy && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Request hire for {draft?.name ?? "this draft"}?</AlertDialogTitle>
          <AlertDialogDescription>
            This sends a hire request through the normal hiring flow. If the organization requires board approval, the
            agent stays pending until the board approves it. Budget, credentials, environment variables, instructions
            and permissions are not copied. Set them on the agent after the hire.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {draft ? (
          <dl className="grid grid-cols-3 gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Role</dt>
            <dd className="col-span-2">{draft.title ?? roleLabel(draft.role)}</dd>
            <dt className="text-muted-foreground">Adapter</dt>
            <dd className="col-span-2">{getAdapterLabel(draft.adapterType)}{draft.model ? ` · ${draft.model}` : ""}</dd>
            <dt className="text-muted-foreground">Reports to</dt>
            <dd className="col-span-2">{managerName ?? "No manager"}</dd>
          </dl>
        ) : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {busy ? "Sending…" : "Request hire"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
