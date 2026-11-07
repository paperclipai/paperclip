import { t as finalPagesT } from "@/i18n";
import { t as translateAgentPage, useTranslation } from "@/i18n";
import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentConfigRevision, AgentDetail as AgentDetailRecord } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { accessApi } from "@/api/access";
import { AgentChip, agentTableHeadClass, agentTableRowClass } from "@/components/agent-detail/AgentPanels";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { useNavigate } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { formatDate } from "@/lib/utils";
import { syncAgentRouteAfterRename } from "./agent-route";

const KEY_LABELS: Record<string, string> = {
  get name() { return finalPagesT("final-pages:name_82a353"); },
  get title() { return translateAgentPage("agents:title"); },
  get role() { return finalPagesT("final-pages:role_4b168d"); },
  get reportsTo() { return finalPagesT("final-pages:reporting_line_58d6cb"); },
  get capabilities() { return finalPagesT("final-pages:capabilities_3fc0e5"); },
  get adapterType() { return finalPagesT("final-pages:harness_49f756"); },
  get adapterConfig() { return translateAgentPage("agents:harness_settings"); },
  get runtimeConfig() { return finalPagesT("final-pages:runtime_settings_553569"); },
  get budgetMonthlyCents() { return translateAgentPage("agents:budget_81e4a5"); },
  get permissions() { return translateAgentPage("agents:permissions_7e9272"); },
  get metadata() { return translateAgentPage("agents:metadata"); },
};

export function revisionSummary(revision: Pick<AgentConfigRevision, "changedKeys" | "rolledBackFromRevisionId">): string {
  if (revision.rolledBackFromRevisionId) return translateAgentPage("agents:restored_an_earlier_version");
  if (revision.changedKeys.length === 0) return translateAgentPage("agents:saved_with_no_tracked_changes");
  const labels = revision.changedKeys.map((key) => KEY_LABELS[key] ?? key);
  const sentence = labels.length === 1 ? labels[0] : translateAgentPage("agents:and_38c2f9", { value1: labels.slice(0, -1).join(", "), value2: labels[labels.length - 1] });
  return translateAgentPage("agents:changed_ca0475", { value1: sentence });
}

function useRevisionAuthor(agent: AgentDetailRecord, companyId: string | undefined) {
  const { t: translateAgentPage } = useTranslation("agents");
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId ?? agent.companyId),
    queryFn: () => agentsApi.list(companyId ?? agent.companyId),
  });
  const { data: directory } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(agent.companyId),
    queryFn: () => accessApi.listUserDirectory(agent.companyId),
  });
  return (revision: AgentConfigRevision) => {
    if (revision.createdByAgentId) {
      return agents?.find((candidate) => candidate.id === revision.createdByAgentId)?.name ?? translateAgentPage("agents:an_agent");
    }
    if (revision.createdByUserId && revision.createdByUserId !== "local-board") {
      const entry = directory?.users.find((candidate) => candidate.principalId === revision.createdByUserId);
      return entry?.user?.name?.trim() || entry?.user?.email || translateAgentPage("agents:former_member");
    }
    return translateAgentPage("agents:board");
  };
}

export function AgentHistoryDialog({
  agent,
  companyId,
  open,
  onOpenChange,
}: {
  agent: AgentDetailRecord;
  companyId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState<AgentConfigRevision | null>(null);
  const authorOf = useRevisionAuthor(agent, companyId);
  const { data: revisions, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.configRevisions(agent.id),
    queryFn: () => agentsApi.listConfigRevisions(agent.id, companyId),
    enabled: open,
  });
  const rollback = useMutation({
    mutationFn: (revisionId: string) => agentsApi.rollbackConfigRevision(agent.id, revisionId, companyId),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agent.id) });
      setPending(null);
      if (!syncAgentRouteAfterRename(queryClient, navigate, agent, updated, "overview")) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      }
    },
  });
  const restoreError = rollback.error
    ? rollback.error instanceof Error && rollback.error.message
      ? rollback.error.message
      : translateAgentPage("agents:could_not_restore_that_version")
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-(--agent-detail-dialog-max-h) flex-col gap-5 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-base">{translateAgentPage("agents:agent_history")}</DialogTitle>
          <DialogDescription>{translateAgentPage("agents:every_saved_change_to")}{" "}{agent.name}{translateAgentPage("agents:s_identity_and_configuration_restore_any_version")}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">{error instanceof Error ? error.message : translateAgentPage("agents:could_not_load_agent_history")}</p>
        ) : isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">{translateAgentPage("agents:loading_agent_history")}</p>
        ) : (revisions ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{translateAgentPage("agents:no_saved_changes_yet")}</p>
        ) : (
          <div className="min-h-0 overflow-y-auto rounded-lg border border-border">
            <div className={`${agentTableHeadClass} grid-cols-(--agent-detail-history-cols)`}>
              <span>{translateAgentPage("agents:configuration")}</span>
              <span>{translateAgentPage("agents:team_member")}</span>
              <span>{translateAgentPage("agents:date_configured")}</span>
              <span aria-hidden />
            </div>
            {(revisions ?? []).map((revision) => (
              <div key={revision.id} className={`${agentTableRowClass} grid-cols-(--agent-detail-history-cols)`}>
                <span className="min-w-0">
                  <span className="block text-sm text-foreground">{revisionSummary(revision)}</span>
                  {revision.changedKeys.length > 0 ? (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {revision.changedKeys.map((key) => (
                        <AgentChip key={key} mono>
                          {key}
                        </AgentChip>
                      ))}
                    </span>
                  ) : null}
                </span>
                <span className="truncate text-sm text-foreground">{authorOf(revision)}</span>
                <span className="truncate text-sm tabular-nums text-muted-foreground">{formatDate(revision.createdAt)}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="-mr-2.5 justify-self-end"
                  onClick={() => {
                    rollback.reset();
                    setPending(revision);
                  }}
                  disabled={rollback.isPending}
                >
                  <RotateCcw />{translateAgentPage("agents:restore")}</Button>
              </div>
            ))}
          </div>
        )}
        {restoreError && pending === null ? (
          <p role="alert" className="text-sm text-destructive">{restoreError}</p>
        ) : null}
      </DialogContent>
      <AlertDialog open={pending !== null} onOpenChange={(next) => (next ? undefined : setPending(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{translateAgentPage("agents:restore_this_version")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending
                ? translateAgentPage("agents:continuing_will_restore_s_identity_and_configuration_to", { value1: agent.name, value2: formatDate(pending.createdAt) })
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending ? (
            <div className="flex flex-col gap-2 rounded-lg bg-(--agent-detail-tile) p-4">
              <span className="text-xs text-muted-foreground">
                {formatDate(pending.createdAt)}{" "}{translateAgentPage("agents:by_029307")}{" "}{authorOf(pending)}
              </span>
              <span className="text-sm text-foreground">{revisionSummary(pending)}</span>
              {pending.changedKeys.length > 0 ? (
                <span className="flex flex-wrap gap-1">
                  {pending.changedKeys.map((key) => (
                    <AgentChip key={key} mono>
                      {key}
                    </AgentChip>
                  ))}
                </span>
              ) : null}
            </div>
          ) : null}
          {restoreError ? (
            <p role="alert" className="text-sm text-destructive">{restoreError}</p>
          ) : null}
          <AlertDialogFooter className="sm:justify-between">
            <AlertDialogCancel>{translateAgentPage("agents:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={rollback.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (pending) rollback.mutate(pending.id);
              }}
            >
              <RotateCcw />
              {rollback.isPending ? translateAgentPage("agents:restoring") : translateAgentPage("agents:restore_version")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
