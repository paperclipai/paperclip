import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { casesApi, type CaseDocumentRevision } from "@/api/cases";
import { queryKeys } from "@/lib/queryKeys";
import { Card } from "@/components/ui/card";
import { MarkdownBody } from "@/components/MarkdownBody";
import { cn, relativeTime } from "@/lib/utils";

/** Author + via-issue attribution line for a revision. */
function RevisionByline({ revision }: { revision: CaseDocumentRevision }) {
  const author = revision.actorAgentName ?? (revision.createdByUserId ? "User" : "System");
  return (
    <span className="flex flex-wrap items-center gap-x-1 text-[11px] text-muted-foreground">
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

  return (
    <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
      <aside className="space-y-1">
        <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Revisions
        </h3>
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
                      <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                        latest
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{relativeTime(rev.createdAt)}</span>
                </div>
                {rev.changeSummary && (
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={rev.changeSummary}>
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
    </div>
  );
}
