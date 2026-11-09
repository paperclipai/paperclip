import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import type { AgentInstructionsFileDetail } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { describeError } from "../api/errors";
import { Button } from "./ui/button";
import { QueryErrorState, useQueryView } from "./QueryView";
import { useTranslation } from "@/i18n";

export function InstructionHistory({
  agentId,
  companyId,
  path,
  currentRevisionId,
  disabled,
  onRestored,
}: {
  agentId: string;
  companyId?: string;
  path: string;
  currentRevisionId: string;
  disabled: boolean;
  onRestored: (file: AgentInstructionsFileDetail) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const history = useInfiniteQuery({
    queryKey: ["instruction-history", agentId, path, currentRevisionId],
    queryFn: ({ pageParam }) =>
      agentsApi.instructionHistory(agentId, path, companyId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: open,
  });
  const diff = useQuery({
    queryKey: ["instruction-diff", agentId, path, selected, currentRevisionId],
    queryFn: () =>
      agentsApi.instructionDiff(
        agentId,
        path,
        selected!,
        currentRevisionId,
        companyId,
      ),
    enabled: open && Boolean(selected),
  });
  const restore = useMutation({
    mutationFn: () =>
      agentsApi.restoreInstructions(
        agentId,
        { path, revisionId: selected!, baseRevisionId: currentRevisionId },
        companyId,
      ),
    onSuccess: (file) => {
      setSelected(null);
      onRestored(file);
    },
  });
  // Read the two reads through the shared view so cached history stays visible
  // while a transient refetch fails;a no-data failure shows copy with Retry.

  const historyView = useQueryView(history);
  const diffView = useQueryView(diff);
  return (
    <div className="space-y-3">
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t("agents.instructionHistory.history")}
      </Button>
      {open && (
        <div className="space-y-3">
          {historyView.kind === "error" && (
            <QueryErrorState
              size="panel"
              error={historyView.error}
              action={t("agents.instructionHistory.loadHistory")}
              onRetry={historyView.retry}
              retrying={historyView.isFetching}
            />
          )}
          {diffView.kind === "error" && (
            <QueryErrorState
              size="panel"
              error={diffView.error}
              action={t("agents.instructionHistory.loadDiff")}
              onRetry={diffView.retry}
              retrying={diffView.isFetching}
            />
          )}
{restore.isError && ( // query-error-ok: mutation result
            <p role="alert" className="text-sm text-destructive">{describeError(restore.error).body}</p>
          )}
          {(historyView.kind === "loading" || historyView.kind === "reconnecting") && (
            <p role="status" className="text-sm text-muted-foreground">{t("agents.instructionHistory.loading")}</p>
          )}
          {history.data?.pages
            .flatMap((page) => page.revisions)
            .map((revision) => (
              <div key={revision.id} className="flex items-center gap-3">
                <Button
                  type="button"
                  size="sm"
                  variant={selected === revision.id ? "secondary" : "ghost"}
                  onClick={() => setSelected(revision.id)}
                >
                  <span className="font-mono">{revision.id.slice(0, 8)}</span>
                </Button>
                <span className="text-sm text-muted-foreground">
                  {revision.source} ·{" "}
                  {new Date(revision.createdAt).toLocaleString()}
                  {revision.id === currentRevisionId ? t("agents.instructionHistory.currentSuffix") : ""}
                </span>
              </div>
            ))}
          {history.hasNextPage && (
            <Button
              type="button"
              variant="ghost"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              {t("agents.instructionHistory.olderRevisions")}
            </Button>
          )}
          {diff.data && (
            <>
              <p className="text-sm text-muted-foreground">{t("agents.instructionHistory.selectedRevision")}</p>
              <pre className="whitespace-pre-wrap break-words rounded-md border border-border p-3 font-mono text-sm">
                {diff.data.from.content}
              </pre>
              <p className="text-sm text-muted-foreground">
                {t("agents.instructionHistory.changesFrom")}
              </p>
              <pre className="whitespace-pre-wrap break-words rounded-md border border-border p-3 font-mono text-sm">
                {diff.data.removed && `${t("agents.instructionHistory.removed")}:\n${diff.data.removed}\n`}
                {diff.data.added && `${t("agents.instructionHistory.added")}:\n${diff.data.added}`}
                {!diff.data.removed &&
                  !diff.data.added &&
                  t("agents.instructionHistory.noChanges")}
              </pre>
              <Button
                type="button"
                disabled={
                  disabled ||
                  restore.isPending ||
                  selected === currentRevisionId
                }
                onClick={() => restore.mutate()}
              >
                {t("agents.instructionHistory.restore")}
              </Button>
              {disabled && (
                <p className="text-sm text-muted-foreground">
                  {t("agents.instructionHistory.saveFirst")}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
