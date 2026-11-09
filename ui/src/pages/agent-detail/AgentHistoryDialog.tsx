import { useState } from "react";
import { t } from "@/i18n";
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
  name: "name",
  title: "title",
  role: "role",
  reportsTo: "reporting line",
  capabilities: "capabilities",
  adapterType: "harness",
  adapterConfig: "harness settings",
  runtimeConfig: "runtime settings",
  budgetMonthlyCents: "budget",
  permissions: "permissions",
  metadata: "metadata",
};

export function revisionSummary(revision: Pick<AgentConfigRevision, "changedKeys" | "rolledBackFromRevisionId">): string {
  if (revision.rolledBackFromRevisionId) return t("agents.detail.history.restoredEarlier", { defaultValue: "Restored an earlier version" });
  if (revision.changedKeys.length === 0) return t("agents.detail.history.noTrackedChanges", { defaultValue: "Saved with no tracked changes" });
  const labels = revision.changedKeys.map((key) => t(`agents.detail.history.keyLabels.${key}`, { defaultValue: KEY_LABELS[key] ?? key }));
  const sentence = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return t("agents.detail.history.changedSentence", { sentence, defaultValue: `Changed ${sentence}` });
}

function useRevisionAuthor(agent: AgentDetailRecord, companyId: string | undefined) {
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
      return agents?.find((candidate) => candidate.id === revision.createdByAgentId)?.name ?? "An agent";
    }
    if (revision.createdByUserId && revision.createdByUserId !== "local-board") {
      const entry = directory?.users.find((candidate) => candidate.principalId === revision.createdByUserId);
      return entry?.user?.name?.trim() || entry?.user?.email || "Former member";
    }
    return "Board";
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
      : t("agents.detail.history.restoreError", { defaultValue: "Could not restore that version." })
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-(--agent-detail-dialog-max-h) flex-col gap-5 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-base">{t("agents.detail.history.dialogTitle", { defaultValue: "Agent history" })}</DialogTitle>
          <DialogDescription>{t("agents.detail.history.dialogDescription", { name: agent.name, defaultValue: `Every saved change to ${agent.name}’s identity and configuration. Restore any version.` })}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">{error instanceof Error ? error.message : t("agents.detail.history.loadError", { defaultValue: "Could not load agent history." })}</p>
        ) : isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">{t("agents.detail.history.loading", { defaultValue: "Loading agent history…" })}</p>
        ) : (revisions ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("agents.detail.history.noSavedChanges", { defaultValue: "No saved changes yet." })}</p>
        ) : (
          <div className="min-h-0 overflow-y-auto rounded-lg border border-border">
            <div className={`${agentTableHeadClass} grid-cols-(--agent-detail-history-cols)`}>
              <span>{t("agents.detail.history.thConfiguration", { defaultValue: "Configuration" })}</span>
              <span>{t("agents.detail.history.thTeamMember", { defaultValue: "Team member" })}</span>
              <span>{t("agents.detail.history.thDateConfigured", { defaultValue: "Date configured" })}</span>
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
                  <RotateCcw />
                  {t("agents.detail.history.btnRestore", { defaultValue: "Restore" })}
                </Button>
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
            <AlertDialogTitle>{t("agents.detail.history.confirmTitle", { defaultValue: "Restore this version?" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending
                ? t("agents.detail.history.confirmDescription", { name: agent.name, date: formatDate(pending.createdAt), defaultValue: `Continuing will restore ${agent.name}’s identity and configuration to the version saved on ${formatDate(pending.createdAt)}. Anything changed since then will be replaced. The current version stays in Agent history.` })
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending ? (
            <div className="flex flex-col gap-2 rounded-lg bg-(--agent-detail-tile) p-4">
              <span className="text-xs text-muted-foreground">
                {t("agents.detail.history.metaLine", { date: formatDate(pending.createdAt), author: authorOf(pending), defaultValue: `${formatDate(pending.createdAt)} · By: ${authorOf(pending)}` })}
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
            <AlertDialogCancel>{t("agents.detail.history.cancel", { defaultValue: "Cancel" })}</AlertDialogCancel>
            <AlertDialogAction
              disabled={rollback.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (pending) rollback.mutate(pending.id);
              }}
            >
              <RotateCcw />
              {rollback.isPending ? t("agents.detail.history.restoring", { defaultValue: "Restoring…" }) : t("agents.detail.history.btnRestoreVersion", { defaultValue: "Restore version" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
