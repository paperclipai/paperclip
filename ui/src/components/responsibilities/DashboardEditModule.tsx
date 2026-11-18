import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Agent,
  ResponsibilityDashboardState,
  ResponsibilityDashboardVersionList,
  ResponsibilityDashboardVersionSummary,
} from "@paperclipai/shared";
import { Loader2, X } from "lucide-react";
import { describeError } from "@/api/errors";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { responsibilityDashboardApi } from "@/api/responsibility-dashboard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { queryKeys } from "@/lib/queryKeys";
import {
  dashboardChangeLine,
  dashboardVersionWho,
  readDismissedUndo,
  writeDismissedUndo,
} from "@/lib/responsibility-dashboard";
import { Link, useNavigate } from "@/lib/router";
import { formatDateTime } from "@/lib/utils";
import { DashboardChangesCard } from "./DashboardChangesCard";

/**
 * The Dashboard's edit module, in the Outline v2 view (experimental
 * `enableResponsibilities`): a person's way to have an agent draft their
 * dashboard, change it, and go back to an earlier version.
 *
 * - Empty dashboard: "Create your custom dashboard" with one button that
 *   starts it with the named agent, and a quiet way to add an area by hand
 *   (the only way when no agent can do it).
 * - Populated: one quiet row below the areas, "Edit your dashboard", with
 *   "Versions" beside it.
 * - While a conversation is open: a line with the way into it. With changes
 *   proposed: the changes, right here, to apply.
 * - Right after a change: what changed, with Undo.
 */

export interface DashboardEditModuleProps {
  companyId: string;
  ownerUserId: string;
  /** No active responsibility and none proposed. */
  empty: boolean;
  agentsById: ReadonlyMap<string, Agent>;
  onAddArea: () => void;
}

/** The module's read and actions: start (or reopen) the conversation, restore a version. */
export function useDashboardConversation(companyId: string, ownerUserId: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const key = queryKeys.responsibilities.dashboard(companyId, ownerUserId);
  const query = useQuery({
    queryKey: key,
    queryFn: () => responsibilityDashboardApi.state(companyId, ownerUserId),
  });
  const start = useMutation({
    mutationFn: (mode: "create" | "edit") => responsibilityDashboardApi.start(companyId, { mode, ownerUserId }),
    onSuccess: (state) => {
      queryClient.setQueryData(key, state);
      if (state.conversation) navigate(`/issues/${state.conversation.identifier ?? state.conversation.issueId}`);
    },
  });
  const restore = useMutation({
    mutationFn: (versionId: string) => responsibilityDashboardApi.restore(versionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.all }),
  });
  return { query, state: query.data ?? null, start, restore };
}

/** "Added 2 areas and 5 responsibilities. Undo", until it is dismissed or another change replaces it. */
function LatestChange({
  change,
  busy,
  onUndo,
}: {
  change: ResponsibilityDashboardVersionSummary;
  busy: boolean;
  onUndo: () => void;
}) {
  const [dismissed, setDismissed] = useState(() => readDismissedUndo());
  if (dismissed === change.id) return null;
  return (
    <div className="flex min-w-0 items-center gap-2" data-dashboard-latest-change={change.cause}>
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">{dashboardChangeLine(change)}</p>
      <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onUndo} data-dashboard-undo="">
        {busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
        Undo
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="text-muted-foreground"
        aria-label="Dismiss"
        onClick={() => {
          writeDismissedUndo(change.id);
          setDismissed(change.id);
        }}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}

/** The saved versions, newest first: when, who, what changed, and Restore. */
export function DashboardVersionList({
  list,
  agentsById,
  restoringId,
  onRestore,
}: {
  list: ResponsibilityDashboardVersionList;
  agentsById: ReadonlyMap<string, Agent>;
  restoringId: string | null;
  onRestore: (versionId: string) => void;
}) {
  if (list.versions.length === 0) return <p className="text-sm text-muted-foreground">No versions yet.</p>;
  const agentName = (id: string) => agentsById.get(id)?.name;
  return (
    <ul className="flex flex-col divide-y divide-border" data-dashboard-versions="">
      {list.versions.map((version, position) => (
        <li key={version.id} className="flex min-w-0 items-center gap-3 py-2.5" data-dashboard-version={version.cause}>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="break-words text-sm text-foreground">{version.summary}</p>
            <p className="text-xs text-muted-foreground">
              {formatDateTime(version.createdAt)} · {dashboardVersionWho(version, agentName)}
            </p>
          </div>
          {position === 0 ? (
            <span className="shrink-0 text-xs text-muted-foreground">Now</span>
          ) : (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={restoringId !== null}
              onClick={() => onRestore(version.id)}
            >
              {restoringId === version.id ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
              Restore
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function VersionsDialog({
  companyId,
  ownerUserId,
  open,
  onOpenChange,
  agentsById,
  restore,
}: {
  companyId: string;
  ownerUserId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentsById: ReadonlyMap<string, Agent>;
  restore: ReturnType<typeof useDashboardConversation>["restore"];
}) {
  const query = useQuery({
    queryKey: queryKeys.responsibilities.dashboardVersions(companyId, ownerUserId),
    queryFn: () => responsibilityDashboardApi.versions(companyId, ownerUserId),
    enabled: open,
    // Opening the list saves changes made by hand first, so read it fresh each time.
    staleTime: 0,
  });
  const versions = useQueryView(query);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Previous versions</DialogTitle>
          <DialogDescription className="sr-only">Saved versions of your dashboard, newest first.</DialogDescription>
        </DialogHeader>
        {versions.kind === "error" ? (
          <QueryErrorState error={versions.error} size="inline" action="load the versions" onRetry={versions.retry} retrying={versions.isFetching} />
        ) : versions.data ? (
          <DashboardVersionList
            list={versions.data}
            agentsById={agentsById}
            restoringId={restore.isPending ? restore.variables ?? null : null}
            onRestore={(versionId) => restore.mutate(versionId)}
          />
        ) : (
          <Loader2 aria-label="Loading" className="size-4 animate-spin text-muted-foreground" />
        )}
        {restore.error ? (
          <p role="alert" className="text-sm text-destructive">Couldn’t restore it. {describeError(restore.error).body}</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** What the module shows, from the state alone, so stories and tests can render each one. */
export function DashboardEditModuleView({
  empty,
  state,
  agentsById,
  starting,
  startError,
  undoing,
  undoError,
  onStart,
  onUndo,
  onAddArea,
  onOpenVersions,
}: {
  empty: boolean;
  state: ResponsibilityDashboardState | null;
  agentsById: ReadonlyMap<string, Agent>;
  starting: boolean;
  startError: unknown;
  undoing: boolean;
  undoError?: unknown;
  onStart: () => void;
  onUndo: (versionId: string) => void;
  onAddArea: () => void;
  onOpenVersions: () => void;
}) {
  const nameOf = (agentId: string | null | undefined) => (agentId ? agentsById.get(agentId)?.name : undefined);
  const proposal = state?.proposal ?? null;
  const talking = !proposal && state?.state === "discussing" && state.conversation ? state.conversation : null;
  const loaded = state !== null;
  const noAgent = loaded && !talking && !proposal && state.defaultAgentId === null;
  const agentName = nameOf(state?.defaultAgentId) ?? "an agent";
  const talkingWith = nameOf(talking?.agentId) ?? "an agent";
  const latest = state?.latestChange ?? null;
  const conversationLink = talking ? (
    <Link to={`/issues/${talking.identifier ?? talking.issueId}`} className="font-medium text-foreground underline-offset-4 hover:underline">
      Open the conversation
    </Link>
  ) : null;
  const error = startError ? (
    <p role="alert" className="text-sm text-destructive">Couldn’t start it. {describeError(startError).body}</p>
  ) : undoError ? (
    <p role="alert" className="text-sm text-destructive">Couldn’t undo it. {describeError(undoError).body}</p>
  ) : null;
  const undo = latest?.previousVersionId ? (
    <LatestChange change={latest} busy={undoing} onUndo={() => onUndo(latest.previousVersionId!)} />
  ) : null;
  const card = proposal ? (
    <DashboardChangesCard interaction={proposal} agentName={nameOf(proposal.createdByAgentId)} showConversationLink />
  ) : null;

  if (empty) {
    return (
      <Card elevation="low" className="gap-4 px-5 py-5" data-dashboard-module="create">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-foreground">Create your custom dashboard</h2>
          <p className="text-sm text-muted-foreground">
            Have an agent research and interview you to generate a custom dashboard of areas and responsibilities that matter to you.
          </p>
        </div>
        {card}
        {talking ? (
          <p className="text-sm text-muted-foreground" data-dashboard-talking="">
            Talking it through with {talkingWith}. {conversationLink}
          </p>
        ) : null}
        {!card && !talking ? (
          noAgent ? (
            <p className="text-sm text-muted-foreground">No agent is free to do this. Add your areas yourself.</p>
          ) : (
            <div>
              <Button disabled={!loaded || starting} onClick={onStart} data-dashboard-start="">
                {starting ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
                Start with {agentName}
              </Button>
            </div>
          )
        ) : null}
        {error}
        {undo}
        <div>
          <Button
            size="sm"
            variant={noAgent ? "outline" : "ghost"}
            className={noAgent ? undefined : "text-muted-foreground"}
            onClick={onAddArea}
            data-dashboard-add-area=""
          >
            Add an area yourself
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-dashboard-module="edit">
      {undo}
      {card}
      {error}
      <div className="flex min-h-11 items-center gap-2 rounded-lg border border-dashed border-border pl-2 pr-2">
        {talking ? (
          <p className="min-w-0 flex-1 px-3 text-sm text-muted-foreground" data-dashboard-talking="">
            Editing it with {talkingWith}. {conversationLink}
          </p>
        ) : noAgent ? (
          <p className="min-w-0 flex-1 px-3 text-sm text-muted-foreground">No agent is free to edit your dashboard.</p>
        ) : (
          <Button
            variant="ghost"
            className="min-w-0 flex-1 justify-start text-muted-foreground"
            disabled={!loaded || starting}
            onClick={onStart}
            data-dashboard-edit=""
          >
            {starting ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            Edit your dashboard
          </Button>
        )}
        <Button size="xs" variant="ghost" className="shrink-0 text-muted-foreground" onClick={onOpenVersions} data-dashboard-versions-open="">
          Versions
        </Button>
      </div>
    </div>
  );
}

export function DashboardEditModule({ companyId, ownerUserId, empty, agentsById, onAddArea }: DashboardEditModuleProps) {
  const { query, state, start, restore } = useDashboardConversation(companyId, ownerUserId);
  const stateView = useQueryView(query);
  const [versionsOpen, setVersionsOpen] = useState(false);
  if (stateView.kind === "error") {
    return (
      <div data-dashboard-edit-module="error">
        <QueryErrorState error={stateView.error} size="inline" action="load your dashboard's changes"
          onRetry={stateView.retry} retrying={stateView.isFetching} />
      </div>
    );
  }
  return (
    <>
      <DashboardEditModuleView
        empty={empty}
        state={state}
        agentsById={agentsById}
        starting={start.isPending}
        startError={start.error}
        undoing={restore.isPending && !versionsOpen}
        undoError={versionsOpen ? null : restore.error}
        onStart={() => start.mutate(empty ? "create" : "edit")}
        onUndo={(versionId) => restore.mutate(versionId)}
        onAddArea={onAddArea}
        onOpenVersions={() => {
          restore.reset();
          setVersionsOpen(true);
        }}
      />
      <VersionsDialog
        companyId={companyId}
        ownerUserId={ownerUserId}
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
        agentsById={agentsById}
        restore={restore}
      />
    </>
  );
}
