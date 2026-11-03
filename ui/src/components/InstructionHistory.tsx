import { t, useTranslation } from "@/i18n";
import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import type { AgentInstructionsFileDetail } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { Button } from "./ui/button";
import { formatDateTime } from "../lib/utils";

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
  useTranslation();
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
  const error = history.error ?? diff.error ?? restore.error;
  return (
    <div className="space-y-3">
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t("oct5Core.s0086")}
      </Button>
      {open && (
        <div className="space-y-3">
          {history.isLoading && (
            <p className="text-sm text-muted-foreground">{t("oct5Core.s0087")}</p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error.message}
            </p>
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
                  {t(`oct5Core.revisionSource_${revision.source}`, { defaultValue: revision.source })} ·{" "}
                  {formatDateTime(revision.createdAt)}
                  {revision.id === currentRevisionId ? t("oct5Core.currentRevision") : ""}
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
              {t("oct5Core.s0088")}
            </Button>
          )}
          {diff.data && (
            <>
              <p className="text-sm text-muted-foreground">{t("oct5Core.s0089")}</p>
              <pre className="whitespace-pre-wrap break-words rounded-md border border-border p-3 font-mono text-sm">
                {diff.data.from.content}
              </pre>
              <p className="text-sm text-muted-foreground">
                {t("oct5Core.s0090")}
              </p>
              <pre className="whitespace-pre-wrap break-words rounded-md border border-border p-3 font-mono text-sm">
                {diff.data.removed && t("oct5Core.removedLines", { content: diff.data.removed })}
                {diff.data.added && t("oct5Core.addedLines", { content: diff.data.added })}
                {!diff.data.removed &&
                  !diff.data.added &&
                  t("oct5Core.s0091")}
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
                {t("oct5Core.s0092")}
              </Button>
              {disabled && (
                <p className="text-sm text-muted-foreground">
                  {t("oct5Core.s0093")}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
