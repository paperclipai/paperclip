import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  LinkResponsibility,
  ResponsibilityDetail as ResponsibilityDetailData,
  UpdateResponsibility,
} from "@paperclipai/shared";
import { describeError } from "@/api/errors";
import { responsibilitiesApi } from "@/api/responsibilities";
import { PageSkeleton } from "@/components/PageSkeleton";
import { QueryView } from "@/components/QueryView";
import { useAgentDirectory } from "@/components/responsibilities/AgentsWorking";
import { useResponsibilityAreas } from "@/components/responsibilities/AreaDialogs";
import { ResponsibilityDelegateDialog } from "@/components/responsibilities/ResponsibilityDelegateDialog";
import { ResponsibilityOneScreen } from "@/components/responsibilities/ResponsibilityOneScreen";
import { ResponsibilityOneScreenV2 } from "@/components/responsibilities/ResponsibilityOneScreenV2";
import {
  ResponsibilityPageLayout,
  type ResponsibilityPageActions,
  type ResponsibilityPageLayoutProps,
  type UnlinkRequest,
} from "@/components/responsibilities/ResponsibilityPageLayout";
import { ResponsibilityScorecard } from "@/components/responsibilities/ResponsibilityScorecard";
import { ResponsibilityWhatsMoving } from "@/components/responsibilities/ResponsibilityWhatsMoving";
import { usePageView } from "@/components/responsibilities/usePageView";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useResolvedViewerId } from "@/hooks/useResolvedViewerId";
import { useCompany } from "@/context/CompanyContext";
import { Link, useNavigate, useParams } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import {
  RESPONSIBILITY_PAGE_DEFAULT_VIEW,
  RESPONSIBILITY_PAGE_VIEW_OPTIONS,
} from "@/lib/responsibility-views";

interface NewTaskLaunch {
  defaultTitle: string;
  projectId?: string | null;
}

/**
 * The page's data and mutations for one responsibility, so any layout can
 * take them: agents, areas, saving fields and status, removing (with undo)
 * and deleting.
 */
function useResponsibilityPage(responsibility: ResponsibilityDetailData, companyId: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [removed, setRemoved] = useState<{ label: string; relink: LinkResponsibility } | null>(null);
  const directory = useAgentDirectory(companyId);
  const areasQuery = useResponsibilityAreas(companyId);
  const detailKey = [...queryKeys.responsibilities.detail(responsibility.id), companyId, responsibility.ownerUserId];
  const refreshAll = () => queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.all });

  const update = useMutation({
    mutationFn: (patch: UpdateResponsibility) => responsibilitiesApi.update(responsibility.id, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData<ResponsibilityDetailData>(detailKey, (old) => (old ? { ...old, ...updated } : old));
      void refreshAll();
    },
  });
  const remove = useMutation({
    mutationFn: () => responsibilitiesApi.remove(responsibility.id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: detailKey });
      void queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.overviews(companyId) });
      navigate("/responsibilities");
    },
  });
  const unlink = useMutation({
    mutationFn: (request: UnlinkRequest) => responsibilitiesApi.unlink(responsibility.id, request.linkId),
    onSuccess: (_link, request) => {
      setRemoved({ label: request.label, relink: request.relink });
      void refreshAll();
    },
  });
  const relink = useMutation({
    mutationFn: (body: LinkResponsibility) => responsibilitiesApi.link(responsibility.id, body),
    onSuccess: () => {
      setRemoved(null);
      void refreshAll();
    },
  });
  return { directory, areas: areasQuery.data ?? [], update, remove, unlink, relink, removed, navigate };
}

function ResponsibilityView({ responsibility, companyId }: { responsibility: ResponsibilityDetailData; companyId: string }) {
  const page = useResponsibilityPage(responsibility, companyId);
  const { update, remove, unlink, relink, removed, navigate } = page;
  const [newTask, setNewTask] = useState<NewTaskLaunch | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // One page, no switch between views. Editing the bar from an older view and
  // reviewing a proposal visit the full layout.
  const { view, visiting, visit, leave } = usePageView(RESPONSIBILITY_PAGE_VIEW_OPTIONS, RESPONSIBILITY_PAGE_DEFAULT_VIEW);
  const now = useMemo(() => new Date(), []);

  // "Edit the bar" outside the full layout runs the full layout's own bar
  // flow: the one the bar card owns (talking it through with an agent, or its
  // private dialog when no agent can), so this stays the single seam to
  // repoint when that flow changes.
  const pendingBarEdit = useRef(false);
  useEffect(() => {
    if (!pendingBarEdit.current || view !== "full") return;
    pendingBarEdit.current = false;
    const frame = requestAnimationFrame(() => {
      const card = document.getElementById("responsibility-bar");
      card?.scrollIntoView?.({ block: "start" });
      card?.querySelector<HTMLButtonElement>("button[data-bar-edit-primary]")?.click();
    });
    return () => cancelAnimationFrame(frame);
  }, [view]);
  const editBar = () => {
    pendingBarEdit.current = true;
    visit("full");
  };

  const actions: ResponsibilityPageActions = {
    saveTitle: (title) => update.mutateAsync({ title }),
    saveDescription: (description) => update.mutateAsync({ description }),
    setStatus: (status) => update.mutate({ status }),
    requestDelete: () => setConfirmDelete(true),
    newTask: setNewTask,
    unlink: (request) => unlink.mutate(request),
    unlinkingId: unlink.isPending ? unlink.variables?.linkId ?? null : null,
    onProposalReviewed: ({ dismissed }) => {
      if (dismissed.length > 0) navigate("/responsibilities");
    },
  };

  const notices = (
    <>
      {update.error ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn’t save the change. {describeError(update.error).body}
        </p>
      ) : null}
      {removed ? (
        <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>Removed “{removed.label}” from this responsibility. It still exists, and stays under any other responsibility it is filed under.</span>
          <Button size="xs" variant="ghost" disabled={relink.isPending} onClick={() => relink.mutate(removed.relink)}>
            Undo
          </Button>
        </div>
      ) : null}
      {unlink.error ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn’t remove it from this responsibility. {describeError(unlink.error).body}
        </p>
      ) : null}
      {relink.error ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn’t put it back. {describeError(relink.error).body}
        </p>
      ) : null}
    </>
  );

  const layoutProps: ResponsibilityPageLayoutProps = {
    responsibility,
    companyId,
    agents: page.directory.agents,
    agentsById: page.directory.byId,
    areas: page.areas,
    now,
    actions,
    notices,
  };
  const viewProps = {
    ...layoutProps,
    onReviewProposal: () => visit("full"),
    onEditBar: responsibility.status === "dismissed" ? undefined : editBar,
  };

  return (
    <>
      <div className="flex flex-col gap-3">
        {visiting ? (
          <div className="mx-auto flex w-full max-w-5xl justify-end">
            <Button variant="ghost" onClick={leave} data-responsibility-back="">
              Back
            </Button>
          </div>
        ) : null}
        {view === "scorecard" ? (
          <ResponsibilityScorecard {...viewProps} />
        ) : view === "moving" ? (
          <ResponsibilityWhatsMoving {...viewProps} />
        ) : view === "one_screen" ? (
          <ResponsibilityOneScreen {...viewProps} />
        ) : view === "one_screen_v2" ? (
          <ResponsibilityOneScreenV2 {...viewProps} />
        ) : (
          <ResponsibilityPageLayout {...layoutProps} />
        )}
      </div>

      {newTask ? (
        <ResponsibilityDelegateDialog
          open
          onOpenChange={(open) => {
            if (!open) setNewTask(null);
          }}
          companyId={companyId}
          responsibility={{ id: responsibility.id, title: responsibility.title }}
          defaultTitle={newTask.defaultTitle}
          projectId={newTask.projectId ?? null}
        />
      ) : null}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {responsibility.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the responsibility, its bar and its number. The projects, tasks and routines filed under it
              stay. To stop owning it but keep its history, let it go instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {remove.error ? (
            <p role="alert" className="text-sm text-destructive">
              Couldn’t delete it. {describeError(remove.error).body}
            </p>
          ) : null}
          <AlertDialogFooter className="items-center sm:justify-between">
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending ? "Deleting…" : "Delete responsibility"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** One responsibility: loads it and hands it to the page layout. */
export function ResponsibilityDetail() {
  const { responsibilityId } = useParams<{ responsibilityId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { userId } = useResolvedViewerId();
  const detailQuery = useQuery({
    queryKey: [...queryKeys.responsibilities.detail(responsibilityId ?? "__none__"), selectedCompanyId, userId],
    queryFn: () => responsibilitiesApi.get(responsibilityId!),
    enabled: !!responsibilityId && !!selectedCompanyId && !!userId,
  });
  const title = detailQuery.data?.title;

  useEffect(() => {
    setBreadcrumbs([
      { label: "Dashboard", href: "/responsibilities" },
      ...(title ? [{ label: title }] : []),
    ]);
  }, [setBreadcrumbs, title]);

  if (!selectedCompanyId || !responsibilityId) return null;

  return (
    <QueryView
      query={detailQuery}
      size="page"
      action="load this responsibility"
      loading={<PageSkeleton variant="detail" />}
      notFound={
        <div className="mx-auto flex max-w-xl flex-col items-start gap-3 py-10">
          <h1 className="text-xl font-semibold text-foreground">This responsibility is not available</h1>
          <p className="text-sm text-muted-foreground">It may have been deleted, or it belongs to someone else.</p>
          <Button asChild variant="outline">
            <Link to="/responsibilities">Back to the dashboard</Link>
          </Button>
        </div>
      }
    >
      {(responsibility) =>
        responsibility.companyId === selectedCompanyId ? (
          <ResponsibilityView responsibility={responsibility} companyId={selectedCompanyId} />
        ) : (
          <div className="mx-auto flex max-w-xl flex-col items-start gap-3 py-10">
            <h1 className="text-xl font-semibold text-foreground">This responsibility belongs to another organization</h1>
            <Button asChild variant="outline">
              <Link to="/responsibilities">Back to the dashboard</Link>
            </Button>
          </div>
        )
      }
    </QueryView>
  );
}
