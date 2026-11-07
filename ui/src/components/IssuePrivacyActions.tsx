import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Lock, Users } from "lucide-react";
import { useTranslation } from "@/i18n";
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
import { describeError } from "@/api/errors";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useQueryView } from "./QueryView";
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
  const { t } = useTranslation();
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
  const constraintsView = useQueryView(constraintsQuery);
  const publicBlockedReason = constraintsView.kind === "error"
    ? t("issues.IssuePrivacyActions.checkFailed")
    : constraintsView.kind === "loading" || constraintsView.kind === "reconnecting" || constraintsView.isFetching
      ? t("issues.IssuePrivacyActions.checking")
      : constraintsView.data?.publicBlockedBy === "parent"
        ? t("issues.IssuePrivacyActions.blockedParent")
        : constraintsView.data?.publicBlockedBy === "project"
          ? t("issues.IssuePrivacyActions.blockedProject")
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
        title: visibility === "private" ? t("issues.IssuePrivacyActions.nowPrivate") : t("issues.IssuePrivacyActions.nowPublic"),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({ title: t("issues.IssuePrivacyActions.changeFailed"), body: describeError(error).body, tone: "error" });
    },
  });

  function withTooltip(node: React.ReactNode, blockedReason?: string | null) {
    if (canManage && !blockedReason) return node;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="block w-full" tabIndex={0}>{node}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">{canManage ? blockedReason : t("issues.IssuePrivacyActions.nonSetterTooltip")}</TooltipContent>
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
              <Users className="h-4 w-4" aria-hidden="true" /> {t("issues.IssuePrivacyActions.share")}
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
              <Globe className="h-4 w-4" aria-hidden="true" /> {t("issues.IssuePrivacyActions.makePublic")}
            </button>,
            publicBlockedReason,
          )}
          {canManage && constraintsView.kind === "error" ? (
            <button type="button" className={MENU_ITEM_CLASS} onClick={() => {
              constraintsView.retry();
            }}>{t("issues.IssuePrivacyActions.retryAccessCheck")}</button>
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
            <Lock className="h-4 w-4" aria-hidden="true" /> {t("issues.IssuePrivacyActions.makePrivate")}
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
            <AlertDialogTitle>{t("issues.IssuePrivacyActions.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("issues.IssuePrivacyActions.confirmDescription")}{" "}
              {constraintsQuery.data?.leavesPersonalProject
                ? t("issues.IssuePrivacyActions.leavesPersonalProject") : null}
              <span className="font-semibold text-foreground">{t("issues.IssuePrivacyActions.seenByOthers")}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("issues.IssuePrivacyActions.keepPrivate")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                visibilityMutation.mutate("open");
              }}
              disabled={visibilityMutation.isPending || Boolean(publicBlockedReason)}
            >
              {visibilityMutation.isPending ? t("issues.IssuePrivacyActions.makingPublic") : t("issues.IssuePrivacyActions.makePublic")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
