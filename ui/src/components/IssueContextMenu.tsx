import { useRef, useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ContextMenu } from "radix-ui";
import { Check, Trash2 } from "lucide-react";
import { ISSUE_STATUSES, type Issue, type IssueStatus } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { StatusIcon } from "./StatusIcon";
import { Button } from "./ui/button";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "./ui/alert-dialog";

const statusLabel = (status: IssueStatus) => status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const itemClassName = "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

/** Shares collection actions without adding layout elements around cards or rows. */
export function IssueContextMenu({ issue, children }: { issue: Issue; children: ReactElement }) {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const trigger = useRef<HTMLElement>(null);
  const identifier = issue.identifier ?? issue.id;

  async function mutate(status?: IssueStatus) {
    if (busy.current || status === issue.status) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      if (status) await issuesApi.update(issue.id, { status });
      else await issuesApi.remove(issue.id);
      setConfirmDelete(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(issue.companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(issue.companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(issue.companyId) });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Please try again.";
      setError(`Could not ${status ? "move" : "delete"} task. ${message}`);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger
          asChild
          ref={trigger}
          disabled={pending}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            event.stopPropagation();
            const bounds = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", {
              bubbles: true, cancelable: true, clientX: bounds.left, clientY: bounds.bottom,
            }));
          }}
        >
          {children}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            aria-label={`Actions for ${identifier}`}
            className="z-50 min-w-48 max-h-(--radix-context-menu-content-available-height) overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            onCloseAutoFocus={(event) => {
              // The confirmation owns focus while it is open.
              if (confirmDelete) event.preventDefault();
            }}
          >
            <ContextMenu.Label className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              Move to
            </ContextMenu.Label>
            {ISSUE_STATUSES.map((status) => (
              <ContextMenu.Item
                key={status}
                aria-label={statusLabel(status)}
                disabled={pending || status === issue.status}
                className={itemClassName}
                onSelect={() => void mutate(status)}
              >
                <StatusIcon status={status} />
                <span className="flex-1">{statusLabel(status)}</span>
                {status === issue.status && <Check className="size-4" aria-label="Current status" />}
              </ContextMenu.Item>
            ))}
            <ContextMenu.Separator className="-mx-1 my-1 h-px bg-border" />
            <ContextMenu.Item
              disabled={pending}
              className={`${itemClassName} text-destructive focus:bg-destructive/10 focus:text-destructive`}
              onSelect={() => { setError(null); setConfirmDelete(true); }}
            >
              <Trash2 className="size-4" />
              Delete task…
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <AlertDialog
        open={confirmDelete || error !== null}
        onOpenChange={(open) => {
          if (!open && !busy.current) { setConfirmDelete(false); setError(null); }
        }}
      >
        <AlertDialogContent onCloseAutoFocus={(event) => {
          event.preventDefault();
          const element = trigger.current;
          (element?.querySelector<HTMLElement>("a, button, [tabindex]") ?? element)?.focus();
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmDelete ? "Delete task?" : "Could not move task"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete
                ? `Delete ${identifier}: ${issue.title}? This permanently deletes the task and its comments and attachments. This cannot be undone.`
                : `The status of ${identifier} was not changed. Close this message and try again.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <AlertDialogFooter className="sm:justify-between">
            <AlertDialogCancel disabled={pending}>{confirmDelete ? "Cancel" : "Close"}</AlertDialogCancel>
            {confirmDelete && (
              <Button variant="destructive" disabled={pending} onClick={() => void mutate()}>
                {pending ? "Deleting…" : "Delete task"}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
