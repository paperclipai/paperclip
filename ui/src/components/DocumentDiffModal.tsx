import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function getRevisionLabel(revision: DocumentRevision, t: (key: string, options?: { ns?: string }) => string) {
  const actor = revision.createdByUserId
    ? t("actor.board", { ns: "common" })
    : revision.createdByAgentId
      ? t("actor.agent", { ns: "common" })
      : t("actor.system", { ns: "common" });
  return `rev ${revision.revisionNumber} — ${relativeTime(revision.createdAt)} • ${actor}`;
}

export function DocumentDiffModal({
  issueId,
  documentKey,
  latestRevisionNumber,
  open,
  onOpenChange,
}: {
  issueId: string;
  documentKey: string;
  latestRevisionNumber: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: revisions } = useQuery({
    queryKey: queryKeys.issues.documentRevisions(issueId, documentKey),
    queryFn: () => issuesApi.listDocumentRevisions(issueId, documentKey),
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
    removed: "bg-red-500/10 text-red-100",
    added: "bg-green-500/10 text-green-100",
  };

  const markerByKind: Record<DiffRow["kind"], string> = {
    context: " ",
    removed: "-",
    added: "+",
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-[90%] w-full max-h-[85vh] overflow-hidden flex flex-col">
        <DocumentDiffModalContent
          documentKey={documentKey}
          revisions={revisions}
          sortedRevisions={sortedRevisions}
          effectiveLeftId={effectiveLeftId}
          effectiveRightId={effectiveRightId}
          leftRevision={leftRevision}
          rightRevision={rightRevision}
          diffRows={diffRows}
          lineClassesByKind={lineClassesByKind}
          markerByKind={markerByKind}
          setLeftRevisionId={setLeftRevisionId}
          setRightRevisionId={setRightRevisionId}
        />
      </DialogContent>
    </Dialog>
  );
}

function DocumentDiffModalContent({
  documentKey,
  revisions,
  sortedRevisions,
  effectiveLeftId,
  effectiveRightId,
  leftRevision,
  rightRevision,
  diffRows,
  lineClassesByKind,
  markerByKind,
  setLeftRevisionId,
  setRightRevisionId,
}: {
  documentKey: string;
  revisions: DocumentRevision[] | undefined;
  sortedRevisions: DocumentRevision[];
  effectiveLeftId: string | null;
  effectiveRightId: string | null;
  leftRevision: DocumentRevision | null;
  rightRevision: DocumentRevision | null;
  diffRows: DiffRow[];
  lineClassesByKind: Record<DiffRow["kind"], string>;
  markerByKind: Record<DiffRow["kind"], string>;
  setLeftRevisionId: (id: string) => void;
  setRightRevisionId: (id: string) => void;
}) {
  const { t } = useTranslation("common");

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {t("diffModal.title")} — <span className="font-mono text-sm">{documentKey}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-4 shrink-0">
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-red-400">{t("diffModal.oldBadge")}</span>
            <Select
              value={effectiveLeftId ?? ""}
              onValueChange={(value) => setLeftRevisionId(value)}
            >
              <SelectTrigger className="h-7 w-60 text-xs border-border/60">
                <SelectValue placeholder={t("diffModal.selectRevision")} />
              </SelectTrigger>
              <SelectContent>
                {sortedRevisions.map((revision) => (
                  <SelectItem key={revision.id} value={revision.id} className="text-xs">
                    {getRevisionLabel(revision, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-green-400">{t("diffModal.newBadge")}</span>
            <Select
              value={effectiveRightId ?? ""}
              onValueChange={(value) => setRightRevisionId(value)}
            >
              <SelectTrigger className="h-7 w-60 text-xs border-border/60">
                <SelectValue placeholder={t("diffModal.selectRevision")} />
              </SelectTrigger>
              <SelectContent>
                {sortedRevisions.map((revision) => (
                  <SelectItem key={revision.id} value={revision.id} className="text-xs">
                    {getRevisionLabel(revision, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="overflow-auto flex-1 rounded-md border border-border text-xs">
        {!revisions ? (
          <div className="p-6 text-center text-muted-foreground text-sm">{t("diffModal.loadingRevisions")}</div>
        ) : !leftRevision || !rightRevision ? (
          <div className="p-6 text-center text-muted-foreground text-sm">{t("diffModal.selectTwoRevisions")}</div>
        ) : leftRevision.id === rightRevision.id ? (
          <div className="p-6 text-center text-muted-foreground text-sm">{t("diffModal.sameRevision")}</div>
        ) : (
          <div className="font-mono text-[12px] leading-6">
            <div className="grid grid-cols-[56px_56px_24px_minmax(0,1fr)] border-b border-border/60 bg-muted/30 px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              <span>{t("diffModal.oldColumn")}</span>
              <span>{t("diffModal.newColumn")}</span>
              <span />
              <span>{t("diffModal.contentColumn")}</span>
            </div>
              {diffRows.map((row, index) => (
                <div
                  key={`${row.kind}-${index}-${row.oldLineNumber ?? "x"}-${row.newLineNumber ?? "x"}`}
                  className={`grid grid-cols-[56px_56px_24px_minmax(0,1fr)] gap-0 border-b border-border/30 px-3 ${lineClassesByKind[row.kind]}`}
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
    </>
  );
}
