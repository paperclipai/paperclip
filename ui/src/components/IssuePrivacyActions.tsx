import { t, useTranslation } from "@/i18n";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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


/**
 * Privacy actions for the task `⋯` menu. Renders the menu buttons plus the
 * two dialogs. The render prop keeps this component outside the menu's
 * unmounting content, so dialogs survive the menu closing. `closeMenu` collapses the parent popover when an item that
 * opens a dialog is clicked.
 *
 * Setter rules (locked decision, server-gated via
 * `resolveManagedIssueForPrivacy`): only the responsible user + admins can
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
  children,
}: {
  issue: Pick<Issue, "id" | "identifier" | "visibility"> & Partial<Pick<Issue, "privacyParentIssueId" | "projectId">>;
  companyId: string;
  canManage: boolean;
  closeMenu: () => void;
  implicitPrincipals?: ShareSheetImplicitPrincipal[];
  children: (menuItems: React.ReactNode) => React.ReactNode;
}) {
  useTranslation();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [shareOpen, setShareOpen] = useState(false);
  const [makePublicOpen, setMakePublicOpen] = useState(false);
  const isPrivate = issue.visibility === "private";
  const constraintsQuery = useQuery({
    queryKey: [...queryKeys.issues.privacyConstraints(issue.id), issue.privacyParentIssueId ?? null, issue.projectId ?? null],
    queryFn: () => issuesApi.privacyConstraints(issue.id),
    enabled: canManage && isPrivate,
  });
  const publicBlockedReason = constraintsQuery.isError
    ? t("oct19Tasks.privacyCheckFailed")
    : !constraintsQuery.data || constraintsQuery.isFetching
      ? t("oct19Tasks.privacyChecking")
      : constraintsQuery.data.publicBlockedBy === "parent"
        ? t("oct19Tasks.privateParentBlocksPublic")
        : constraintsQuery.data.publicBlockedBy === "project"
          ? t("oct19Tasks.privateProjectBlocksPublic")
          : null;

  const visibilityMutation = useMutation({
    mutationFn: (visibility: IssueVisibility) => issuesApi.setVisibility(issue.id, visibility),
    onSuccess: (_result, visibility) => {
      // Privacy can change descendants and remove a task from a private project.
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(companyId) });
      if (issue.identifier) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.identifier) });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.accessGrants(issue.id) });
      setMakePublicOpen(false);
      pushToast({
        title: visibility === "private" ? t("oct19Tasks.nowPrivate") : t("oct19Tasks.nowPublic"),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({ title: t("oct19Tasks.visibilityFailed"), body: (error as Error).message, tone: "error" });
    },
  });

  function withTooltip(node: React.ReactNode, blockedReason?: string | null) {
    if (canManage && !blockedReason) return node;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="block w-full" tabIndex={0}>{node}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">{canManage ? blockedReason : t("oct19Tasks.onlyOwnerPrivacy")}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <TooltipProvider>
      {children(isPrivate ? (
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
              <Users className="h-4 w-4" aria-hidden="true" /> {t("oct19Tasks.share")}
            </button>,
          )}
          {withTooltip(
            <button
              type="button"
              className={cn(MENU_ITEM_CLASS, "text-destructive")}
              disabled={!canManage || Boolean(publicBlockedReason)}
              onClick={() => {
                closeMenu();
                setMakePublicOpen(true);
              }}
            >
              <Globe className="h-4 w-4" aria-hidden="true" /> {t("oct19Tasks.makePublic")}
            </button>,
            publicBlockedReason,
          )}
          {canManage && constraintsQuery.isError ? (
            <button type="button" className={MENU_ITEM_CLASS} onClick={() => {
              void constraintsQuery.refetch();
            }}>{t("oct19Tasks.retryAccessCheck")}</button>
          ) : null}
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
            <Lock className="h-4 w-4" aria-hidden="true" /> {t("oct19Tasks.makePrivate")}
          </button>,
        )
      ))}

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
            <AlertDialogTitle>{t("oct19Tasks.confirmPublic")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("oct19Tasks.publicConsequences")}{" "}
              {constraintsQuery.data?.leavesPersonalProject
                ? t("oct19Tasks.leavesPersonalProject") : null}
              <span className="font-semibold text-foreground">{t("oct19Tasks.disclosureWarning")}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("oct19Tasks.keepPrivate")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                visibilityMutation.mutate("open");
              }}
              disabled={visibilityMutation.isPending || Boolean(publicBlockedReason)}
            >
              {visibilityMutation.isPending ? t("oct19Tasks.makingPublic") : t("oct19Tasks.makePublic")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
