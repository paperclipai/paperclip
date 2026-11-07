import { t, useTranslation } from "@/i18n";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import type { DocumentRevision } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { buildLineDiff, type DiffRow } from "../lib/line-diff";
import { relativeTime } from "../lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function getRevisionLabel(revision: DocumentRevision) {
  const actor = revision.createdByUserId
    ? t("final-components-a:board_859169b3")
    : revision.createdByAgentId
      ? t("final-components-a:agent_d4f0bc5a")
      : t("final-components-a:system_bbc5e661");
  return t("final-components-a:revRevisionTimeActor_bf5f0ff1", { revision: revision.revisionNumber, time: relativeTime(revision.createdAt), actor: actor });
}

export function DocumentDiffModal({
  issueId,
  documentKey,
  latestRevisionNumber,
  open,
  onOpenChange,
  revisionsQueryKey,
  revisionsQueryFn,
}: {
  issueId?: string;
  documentKey: string;
  latestRevisionNumber: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  revisionsQueryKey?: QueryKey;
  revisionsQueryFn?: () => Promise<DocumentRevision[]>;
}) {
  useTranslation("task-components");
  const { data: revisions } = useQuery({
    queryKey: revisionsQueryKey ?? queryKeys.issues.documentRevisions(issueId ?? "", documentKey),
    queryFn: () => revisionsQueryFn ? revisionsQueryFn() : issuesApi.listDocumentRevisions(issueId ?? "", documentKey),
    enabled: open,
  });

  const sortedRevisions = useMemo(() => {
    if (!revisions) return [];
    return [...revisions].sort((a, b) => b.revisionNumber - a.revisionNumber);
  }, [revisions]);

  // Default: compare previous (latestRevisionNumber - 1) with current (latestRevisionNumber)
  const [leftRevisionId, setLeftRevisionId] = useState<string | null>(null);
  const [rightRevisionId, setRightRevisionId] = useState<string | null>(null);

  const effectiveLeftId = leftRevisionId ?? sortedRevisions.find(
    (r) => r.revisionNumber === latestRevisionNumber - 1,
  )?.id ?? null;

  const effectiveRightId = rightRevisionId ?? sortedRevisions.find(
    (r) => r.revisionNumber === latestRevisionNumber,
  )?.id ?? null;

  const leftRevision = sortedRevisions.find((r) => r.id === effectiveLeftId) ?? null;
  const rightRevision = sortedRevisions.find((r) => r.id === effectiveRightId) ?? null;

  const leftBody = leftRevision?.body ?? "";
  const rightBody = rightRevision?.body ?? "";
  const diffRows = useMemo(() => buildLineDiff(leftBody, rightBody), [leftBody, rightBody]);

  const lineClassesByKind: Record<DiffRow["kind"], string> = {
    context: "bg-transparent",
    removed: "bg-red-500/10 text-red-900 dark:text-red-100",
    added: "bg-green-500/10 text-green-900 dark:text-green-100",
  };

  const markerByKind: Record<DiffRow["kind"], string> = {
    context: " ",
    removed: "-",
    added: "+",
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-(--pct-90) w-full max-h-(--sz-85vh) overflow-hidden flex flex-col">
        <div className="flex items-center justify-between gap-4">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t("task-components:diff_6b2cacfd")}{" "}<span className="font-mono text-sm">{documentKey}</span>
            </DialogTitle>
          </DialogHeader>

          <div className="flex items-center gap-4 shrink-0">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-(length:--text-nano) uppercase tracking-wider text-red-400">{t("task-components:old_bca97160")}</Badge>
              <Select
                value={effectiveLeftId ?? ""}
                onValueChange={(value) => setLeftRevisionId(value)}
              >
                <SelectTrigger className="h-7 w-60 text-xs border-border/60">
                  <SelectValue placeholder={t("task-components:selectRevision_4c843151")} />
                </SelectTrigger>
                <SelectContent>
                  {sortedRevisions.map((revision) => (
                    <SelectItem key={revision.id} value={revision.id} className="text-xs">
                      {getRevisionLabel(revision)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="border-green-500/30 bg-green-500/10 text-(length:--text-nano) uppercase tracking-wider text-green-400">{t("task-components:new_18fdd549")}</Badge>
              <Select
                value={effectiveRightId ?? ""}
                onValueChange={(value) => setRightRevisionId(value)}
              >
                <SelectTrigger className="h-7 w-60 text-xs border-border/60">
                  <SelectValue placeholder={t("task-components:selectRevision_4c843151")} />
                </SelectTrigger>
                <SelectContent>
                  {sortedRevisions.map((revision) => (
                    <SelectItem key={revision.id} value={revision.id} className="text-xs">
                      {getRevisionLabel(revision)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div className="overflow-auto flex-1 rounded-md border border-border text-xs">
          {!revisions ? (
            <div className="p-6 text-center text-muted-foreground text-sm">{t("task-components:loadingRevisions_c3cd7185")}</div>
          ) : !leftRevision || !rightRevision ? (
            <div className="p-6 text-center text-muted-foreground text-sm">{t("task-components:selectTwoRevisionsToCompare_e64fab56")}</div>
          ) : leftRevision.id === rightRevision.id ? (
            <div className="p-6 text-center text-muted-foreground text-sm">{t("task-components:bothSidesAreTheSameRevision_5c3e0d37")}</div>
          ) : (
            <div className="font-mono text-xs leading-6">
              <div className="grid grid-cols-(--gtc-1) border-b border-border/60 bg-muted/30 px-3 py-2 text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">
                <span>{t("task-components:old_bca97160")}</span>
                <span>{t("task-components:new_18fdd549")}</span>
                <span />
                <span>{t("task-components:content_47bd2907")}</span>
              </div>
              {diffRows.map((row, index) => (
                <div
                  key={`${row.kind}-${index}-${row.oldLineNumber ?? "x"}-${row.newLineNumber ?? "x"}`}
                  className={`grid grid-cols-(--gtc-1) gap-0 border-b border-border/30 px-3 ${lineClassesByKind[row.kind]}`}
                >
                  <span className="select-none border-r border-border/30 pr-3 text-right text-muted-foreground">
                    {row.oldLineNumber ?? ""}
                  </span>
                  <span className="select-none border-r border-border/30 px-3 text-right text-muted-foreground">
                    {row.newLineNumber ?? ""}
                  </span>
                  <span className="select-none px-3 text-center text-muted-foreground">
                    {markerByKind[row.kind]}
                  </span>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 py-0 text-inherit">
                    {row.text.length > 0 ? row.text : " "}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
