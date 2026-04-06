import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DocumentRevision } from "@paperclipai/shared";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
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

function getRevisionLabel(revision: DocumentRevision) {
  const actor = revision.createdByUserId
    ? "board"
    : revision.createdByAgentId
      ? "agent"
      : "system";
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[90vw] w-full max-h-[85vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between gap-4">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              Diff — <span className="font-mono text-sm">{documentKey}</span>
            </DialogTitle>
          </DialogHeader>

          <div className="flex items-center gap-4 shrink-0">
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-red-400">Old</span>
              <Select
                value={effectiveLeftId ?? ""}
                onValueChange={(value) => setLeftRevisionId(value)}
              >
                <SelectTrigger className="h-7 w-60 text-xs border-border/60">
                  <SelectValue placeholder="Select revision" />
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
              <span className="rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-green-400">New</span>
              <Select
                value={effectiveRightId ?? ""}
                onValueChange={(value) => setRightRevisionId(value)}
              >
                <SelectTrigger className="h-7 w-60 text-xs border-border/60">
                  <SelectValue placeholder="Select revision" />
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
            <div className="p-6 text-center text-muted-foreground text-sm">Loading revisions...</div>
          ) : !leftRevision || !rightRevision ? (
            <div className="p-6 text-center text-muted-foreground text-sm">Select two revisions to compare.</div>
          ) : leftRevision.id === rightRevision.id ? (
            <div className="p-6 text-center text-muted-foreground text-sm">Both sides are the same revision.</div>
          ) : (
            <ReactDiffViewer
              oldValue={leftBody}
              newValue={rightBody}
              splitView={false}
              compareMethod={DiffMethod.WORDS}
              useDarkTheme
              leftTitle={`rev ${leftRevision.revisionNumber}`}
              rightTitle={`rev ${rightRevision.revisionNumber}`}
              styles={{
                variables: {
                  dark: {
                    diffViewerBackground: "transparent",
                    gutterBackground: "hsl(var(--muted) / 0.3)",
                    addedBackground: "hsl(142 70% 25% / 0.3)",
                    addedGutterBackground: "hsl(142 70% 25% / 0.4)",
                    removedBackground: "hsl(0 70% 30% / 0.3)",
                    removedGutterBackground: "hsl(0 70% 30% / 0.4)",
                    wordAddedBackground: "hsl(142 70% 35% / 0.5)",
                    wordRemovedBackground: "hsl(0 70% 40% / 0.5)",
                    addedGutterColor: "hsl(var(--foreground))",
                    removedGutterColor: "hsl(var(--foreground))",
                    gutterColor: "hsl(var(--muted-foreground))",
                    codeFoldGutterBackground: "hsl(var(--muted) / 0.2)",
                    codeFoldBackground: "hsl(var(--muted) / 0.1)",
                    emptyLineBackground: "transparent",
                    codeFoldContentColor: "hsl(var(--muted-foreground))",
                  },
                },
                contentText: {
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                  fontSize: "12px",
                  lineHeight: "1.5",
                  wordBreak: "break-word" as const,
                  whiteSpace: "pre-wrap" as const,
                },
                gutter: {
                  minWidth: "40px",
                  whiteSpace: "nowrap" as const,
                },
                line: {
                  wordBreak: "break-word" as const,
                },
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
