import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { casesApi, type CaseDocumentRevision } from "@/api/cases";
import { queryKeys } from "@/lib/queryKeys";
import { buildLineDiff, type DiffRow } from "@/lib/line-diff";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn, relativeTime } from "@/lib/utils";
import { Diff } from "lucide-react";

/** Author + via-issue attribution line for a revision. */
function RevisionByline({ revision }: { revision: CaseDocumentRevision }) {
  const author = revision.actorAgentName ?? (revision.createdByUserId ? "User" : "System");
  return (
    <span className="flex flex-wrap items-center gap-x-1 text-(length:--text-micro) text-muted-foreground">
      <span>{author}</span>
      {revision.issue && (
        <>
          <span aria-hidden>·</span>
          <span>via</span>
          <Link
            to={`/issues/${revision.issue.identifier}`}
            className="font-mono text-foreground/80 hover:underline"
            onClick={(e) => e.stopPropagation()}
            title={revision.issue.title}
          >
            {revision.issue.identifier}
          </Link>
        </>
      )}
    </span>
  );
}

function getRevisionLabel(revision: CaseDocumentRevision) {
  const actor = revision.actorAgentName ?? (revision.createdByUserId ? "board" : "system");
  return `rev ${revision.revisionNumber} - ${relativeTime(revision.createdAt)} - ${actor}`;
}

function CaseDocumentDiffModal({
  documentKey,
  revisions,
  latestRevisionNumber,
  open,
  onOpenChange,
}: {
  documentKey: string;
  revisions: CaseDocumentRevision[];
  latestRevisionNumber: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [leftRevisionId, setLeftRevisionId] = useState<string | null>(null);
  const [rightRevisionId, setRightRevisionId] = useState<string | null>(null);

  const effectiveLeftId = leftRevisionId ?? revisions.find(
    (revision) => revision.revisionNumber === latestRevisionNumber - 1,
  )?.id ?? null;
  const effectiveRightId = rightRevisionId ?? revisions.find(
    (revision) => revision.revisionNumber === latestRevisionNumber,
  )?.id ?? null;
  const leftRevision = revisions.find((revision) => revision.id === effectiveLeftId) ?? null;
  const rightRevision = revisions.find((revision) => revision.id === effectiveRightId) ?? null;
  const diffRows = buildLineDiff(leftRevision?.body ?? "", rightRevision?.body ?? "");
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
      <DialogContent className="!max-w-(--pct-90) flex max-h-(--sz-85vh) w-full flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-4">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              Diff - <span className="font-mono text-sm">{documentKey}</span>
            </DialogTitle>
          </DialogHeader>
          <div className="flex shrink-0 items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-(length:--text-nano) font-medium uppercase tracking-(--tracking-caps) text-red-400">Old</span>
              <Select value={effectiveLeftId ?? ""} onValueChange={setLeftRevisionId}>
                <SelectTrigger className="h-7 w-60 border-border/60 text-xs">
                  <SelectValue placeholder="Select revision" />
                </SelectTrigger>
                <SelectContent>
                  {revisions.map((revision) => (
                    <SelectItem key={revision.id} value={revision.id} className="text-xs">
                      {getRevisionLabel(revision)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-(length:--text-nano) font-medium uppercase tracking-(--tracking-caps) text-green-400">New</span>
              <Select value={effectiveRightId ?? ""} onValueChange={setRightRevisionId}>
                <SelectTrigger className="h-7 w-60 border-border/60 text-xs">
                  <SelectValue placeholder="Select revision" />
                </SelectTrigger>
                <SelectContent>
                  {revisions.map((revision) => (
                    <SelectItem key={revision.id} value={revision.id} className="text-xs">
                      {getRevisionLabel(revision)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto rounded-md border border-border text-xs">
          {!leftRevision || !rightRevision ? (
            <div className="p-6 text-center text-sm text-muted-foreground">Select two revisions to compare.</div>
          ) : leftRevision.id === rightRevision.id ? (
            <div className="p-6 text-center text-sm text-muted-foreground">Both sides are the same revision.</div>
          ) : (
            <div className="font-mono text-xs leading-6">
              <div className="grid grid-cols-(--gtc-1) border-b border-border/60 bg-muted/30 px-3 py-2 text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
                <span>Old</span>
                <span>New</span>
                <span />
                <span>Content</span>
              </div>
              {diffRows.map((row, index) => (
                <div
                  key={`${row.kind}-${index}-${row.oldLineNumber ?? "x"}-${row.newLineNumber ?? "x"}`}
                  className={cn("grid grid-cols-(--gtc-1) gap-0 border-b border-border/30 px-3", lineClassesByKind[row.kind])}
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

/**
 * Revision rail (P4 §2): read-only body document with a per-revision list. The
 * newest revision is selected by default; picking another swaps the rendered
 * body. No editing UI in v1.
 */
export function CaseRevisionRail({
  caseIdentifier,
  documentKey = "body",
}: {
  caseIdentifier: string;
  documentKey?: string;
}) {
  const revisionsQuery = useQuery({
    queryKey: queryKeys.cases.revisions(caseIdentifier, documentKey),
    queryFn: () => casesApi.listRevisions(caseIdentifier, documentKey),
  });
  const revisions = revisionsQuery.data?.revisions ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);

  // Default to the latest revision once loaded; keep a valid selection if the
  // list changes underneath us.
  useEffect(() => {
    if (revisions.length === 0) return;
    if (!selectedId || !revisions.some((r) => r.id === selectedId)) {
      setSelectedId(revisions[0]!.id);
    }
  }, [revisions, selectedId]);

  if (revisionsQuery.isLoading) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Loading revisions…</p>;
  }
  if (revisionsQuery.isError) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Could not load revisions.</p>;
  }
  if (revisions.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No revisions yet.</p>;
  }

  const selected = revisions.find((r) => r.id === selectedId) ?? revisions[0]!;
  const latestRevisionNumber = revisionsQuery.data?.document.latestRevisionNumber ?? selected.revisionNumber;

  return (
    <div className="grid gap-4 md:grid-cols-(--gtc-case-revisions)">
      <aside className="space-y-1">
        <div className="flex items-center justify-between gap-2 px-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Revisions
          </h3>
          {revisions.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => setDiffOpen(true)}
            >
              <Diff className="h-3.5 w-3.5" />
              Diff
            </Button>
          ) : null}
        </div>
        <ol className="space-y-1">
          {revisions.map((rev, index) => (
            <li key={rev.id}>
              <button
                type="button"
                onClick={() => setSelectedId(rev.id)}
                aria-current={rev.id === selected.id}
                className={cn(
                  "w-full rounded-md border px-2.5 py-1.5 text-left transition-colors",
                  rev.id === selected.id
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-accent/50",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">
                    rev {rev.revisionNumber}
                    {index === 0 && (
                      <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-(length:--text-nano) text-muted-foreground">
                        latest
                      </span>
                    )}
                  </span>
                  <span className="text-(length:--text-micro) text-muted-foreground">{relativeTime(rev.createdAt)}</span>
                </div>
                {rev.changeSummary && (
                  <p className="mt-0.5 truncate text-(length:--text-micro) text-muted-foreground" title={rev.changeSummary}>
                    {rev.changeSummary}
                  </p>
                )}
                <RevisionByline revision={rev} />
              </button>
            </li>
          ))}
        </ol>
      </aside>

      <Card className="min-w-0 px-4 py-3">
        <div className="mb-2 flex items-baseline justify-between border-b border-border pb-2">
          <span className="text-sm font-medium">rev {selected.revisionNumber}</span>
          <RevisionByline revision={selected} />
        </div>
        {selected.body ? (
          <MarkdownBody linkIssueReferences linkCaseReferences>
            {selected.body}
          </MarkdownBody>
        ) : (
          <p className="text-sm text-muted-foreground">This revision has no body.</p>
        )}
      </Card>
      {revisions.length > 1 ? (
        <CaseDocumentDiffModal
          documentKey={documentKey}
          revisions={revisions}
          latestRevisionNumber={latestRevisionNumber}
          open={diffOpen}
          onOpenChange={setDiffOpen}
        />
      ) : null}
    </div>
  );
}
