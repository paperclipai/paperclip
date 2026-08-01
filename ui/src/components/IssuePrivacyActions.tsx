import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Globe, Lock, Users } from "lucide-react";
import type { Issue, IssueVisibility } from "@paperclipai/shared";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { issuesApi } from "@/api/issues";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { IssueShareSheet, type ShareSheetImplicitPrincipal } from "./IssueShareSheet";

const MENU_ITEM_CLASS =
  "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";

const NON_SETTER_TOOLTIP =
  "Only the task owner or an admin can change who can see this task.";

/**
 * Privacy actions for the task `⋯` menu. Renders the menu buttons plus the
 * two portalled dialogs (share sheet + make-public confirm) so they survive
 * the menu closing. `closeMenu` collapses the parent popover when an item that
 * opens a dialog is clicked.
 *
 * Setter rules (locked decision, server-gated via
 * `resolveIssuePrivacyManagementRoot`): only the responsible user + admins can
 * change visibility or grants. Non-setters see the items disabled with a
 * tooltip. Make-**public** always confirms (one-way disclosure); make-private
 * never does.
 */
export function IssuePrivacyActions({
  issue,
  companyId,
  canManage,
  closeMenu,
  implicitPrincipals = [],
}: {
  issue: Pick<Issue, "id" | "identifier" | "visibility">;
  companyId: string;
  canManage: boolean;
  closeMenu: () => void;
  implicitPrincipals?: ShareSheetImplicitPrincipal[];
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [shareOpen, setShareOpen] = useState(false);
  const [makePublicOpen, setMakePublicOpen] = useState(false);
  const isPrivate = issue.visibility === "private";

  const visibilityMutation = useMutation({
    mutationFn: (visibility: IssueVisibility) => issuesApi.setVisibility(issue.id, visibility),
    onSuccess: (_result, visibility) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
      if (issue.identifier) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.identifier) });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.accessGrants(issue.id) });
      setMakePublicOpen(false);
      pushToast({
        title: visibility === "private" ? "Task is now private" : "Task is now public",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({ title: "Couldn't change visibility", body: (error as Error).message, tone: "error" });
    },
  });

  function withTooltip(node: React.ReactNode) {
    if (canManage) return node;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="block w-full">{node}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">{NON_SETTER_TOOLTIP}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <TooltipProvider>
      {isPrivate ? (
        <>
          {withTooltip(
            <button
              type="button"
              className={MENU_ITEM_CLASS}
              disabled={!canManage}
              onClick={() => {
                closeMenu();
                setShareOpen(true);
              }}
            >
              <Users className="h-4 w-4" aria-hidden="true" /> Share…
            </button>,
          )}
          {withTooltip(
            <button
              type="button"
              className={cn(MENU_ITEM_CLASS, "text-destructive")}
              disabled={!canManage}
              onClick={() => {
                closeMenu();
                setMakePublicOpen(true);
              }}
            >
              <Globe className="h-4 w-4" aria-hidden="true" /> Make public
            </button>,
          )}
        </>
      ) : (
        withTooltip(
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            disabled={!canManage || visibilityMutation.isPending}
            onClick={() => {
              closeMenu();
              visibilityMutation.mutate("private");
            }}
          >
            <Lock className="h-4 w-4" aria-hidden="true" /> Make private
          </button>,
        )
      )}

      <IssueShareSheet
        issueId={issue.id}
        companyId={companyId}
        canManage={canManage}
        open={shareOpen}
        onOpenChange={setShareOpen}
        implicitPrincipals={implicitPrincipals}
      />

      <AlertDialog open={makePublicOpen} onOpenChange={setMakePublicOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make this task public?</AlertDialogTitle>
            <AlertDialogDescription>
              Everyone in the company will be able to read this task, its comments, documents, and
              run history — including every subtask.{" "}
              <span className="font-semibold text-foreground">This can't be undone.</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep private</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                visibilityMutation.mutate("open");
              }}
              disabled={visibilityMutation.isPending}
            >
              {visibilityMutation.isPending ? "Making public…" : "Make public"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
