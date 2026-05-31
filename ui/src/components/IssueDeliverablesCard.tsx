import type { Issue, IssueDocumentSummary } from "@paperclipai/shared";
import { isSystemIssueDocumentKey } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import type { RunForIssue } from "../api/activity";
import { Button } from "@/components/ui/button";
import { CheckCircle2, ExternalLink, FileText, Search } from "lucide-react";

const MAX_VISIBLE_DOCUMENTS = 6;
const MAX_VISIBLE_REFS = 6;

export type DeliverableDocument = {
  issueId: string;
  issuePathId: string;
  issueTitle: string;
  issueIdentifier: string | null;
  document: IssueDocumentSummary;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isReadableDocument(document: IssueDocumentSummary) {
  if (isSystemIssueDocumentKey(document.key)) return false;
  return true;
}

function issuePathId(issue: Issue) {
  return issue.identifier ?? issue.id;
}

function displayDocumentTitle(document: IssueDocumentSummary) {
  return document.title?.trim() || document.key.replace(/[-_]+/g, " ");
}

function collectDocuments(issue: Issue, childIssues: Issue[]): DeliverableDocument[] {
  const issues = [issue, ...childIssues];
  return issues.flatMap((entry) =>
    (entry.documentSummaries ?? [])
      .filter(isReadableDocument)
      .map((document) => ({
        issueId: entry.id,
        issuePathId: issuePathId(entry),
        issueIdentifier: entry.identifier ?? null,
        issueTitle: entry.title,
        document,
      })),
  ).sort((a, b) => {
    const aTime = new Date(a.document.updatedAt).getTime();
    const bTime = new Date(b.document.updatedAt).getTime();
    return bTime - aTime;
  });
}

function collectRefs(value: unknown, refs = new Set<string>()) {
  if (typeof value === "string") {
    const matches = value.match(/\b(?:kb|operational_log):(?:article|topic-brief|editorial-pass)[a-z0-9._-]*@v\d+\b/gi) ?? [];
    for (const match of matches) refs.add(match);
    return refs;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
    return refs;
  }
  const record = asRecord(value);
  if (record) {
    for (const item of Object.values(record)) collectRefs(item, refs);
  }
  return refs;
}

function collectKatailystRefs(runs?: RunForIssue[]) {
  const refs = new Set<string>();
  for (const run of runs ?? []) {
    collectRefs(run.resultJson, refs);
  }
  return [...refs].slice(0, MAX_VISIBLE_REFS);
}

export function IssueDeliverablesCard({
  issue,
  childIssues,
  runs,
}: {
  issue: Issue;
  childIssues: Issue[];
  runs?: RunForIssue[];
}) {
  const documents = collectDocuments(issue, childIssues);
  const katailystRefs = collectKatailystRefs(runs);
  const visibleDocuments = documents.slice(0, MAX_VISIBLE_DOCUMENTS);
  const doneChildrenWithDocuments = childIssues.filter((child) =>
    child.status === "done" && (child.documentSummaries ?? []).some(isReadableDocument),
  ).length;

  const hasVisibleOutput = visibleDocuments.length > 0 || katailystRefs.length > 0;

  return (
    <section className="rounded-xl border border-sky-500/25 bg-sky-500/10 p-4 text-sky-950 shadow-sm dark:text-sky-100" aria-label="Readable output">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mt-0.5 rounded-full bg-background/75 p-2 text-current shadow-sm">
          {hasVisibleOutput ? <CheckCircle2 className="h-4 w-4" /> : <Search className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-current/70">Readable output</div>
          <h3 className="text-base font-semibold leading-6 text-current">
            {hasVisibleOutput ? "Open the draft or topic brief here" : "No readable draft is attached yet"}
          </h3>
          <p className="text-sm leading-6 text-current/80">
            {hasVisibleOutput
              ? "Approval should happen from the actual writing below — not from run logs or status cards."
              : "The run may have reported progress, but Paperclip does not have a readable document attached to this issue yet."}
          </p>
        </div>
      </div>

      {visibleDocuments.length > 0 ? (
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {visibleDocuments.map((item) => (
            <Link
              key={`${item.issueId}:${item.document.key}`}
              to={`${createIssueDetailPath(item.issuePathId)}#document-${encodeURIComponent(item.document.key)}`}
              className="group rounded-lg border border-current/10 bg-background/75 p-3 text-foreground shadow-sm transition hover:border-sky-400/50 hover:bg-background"
            >
              <div className="flex items-start gap-2">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-sky-600 dark:text-sky-300" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold group-hover:underline">{displayDocumentTitle(item.document)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {item.issueIdentifier ?? item.issueTitle} · updated {new Date(item.document.updatedAt).toLocaleDateString()}
                  </div>
                </div>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </div>
            </Link>
          ))}
        </div>
      ) : null}

      {katailystRefs.length > 0 ? (
        <div className="mt-3 rounded-lg border border-current/10 bg-background/60 p-3 text-foreground">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filed in Katailyst</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {katailystRefs.map((ref) => (
              <code key={ref} className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{ref}</code>
            ))}
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            These refs mean the work was filed outside Paperclip. The next fix is to mirror those drafts back here automatically.
          </p>
        </div>
      ) : null}

      {!hasVisibleOutput ? (
        <div className="mt-3 rounded-lg border border-current/10 bg-background/70 p-3 text-sm text-foreground">
          Ask the worker to: <strong>save the article or topic brief as an issue document before asking for approval.</strong>
        </div>
      ) : null}

      {childIssues.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-current/75">
          <span>{childIssues.length} child tasks</span>
          <span>·</span>
          <span>{doneChildrenWithDocuments} done with readable documents</span>
          {documents.length > MAX_VISIBLE_DOCUMENTS ? <span>· {documents.length - MAX_VISIBLE_DOCUMENTS} more documents below</span> : null}
        </div>
      ) : null}
    </section>
  );
}
