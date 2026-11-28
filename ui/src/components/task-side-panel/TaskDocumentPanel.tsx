import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IssueDocument } from "@paperclipai/shared";
import { ArrowUpRight, FileQuestion, Loader2 } from "lucide-react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { DocumentAnnotationsCountChip, IssueDocumentAnnotations } from "@/components/IssueDocumentAnnotations";
import { DocumentMarkdownBody } from "@/components/DocumentMarkdownBody";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { queryKeys } from "@/lib/queryKeys";
import { DocumentMarkdownActions } from "@/components/DocumentMarkdownActions";
import { documentDisplayTitle } from "@/lib/issue-artifacts";
import { createIssueDetailPath } from "@/lib/issueDetailBreadcrumb";
import { Link, useLocation } from "@/lib/router";

type HeadingNode = { type: string; value?: string; children?: HeadingNode[] };

function headingText(node: HeadingNode): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value ?? "";
  if (node.type === "break") return " ";
  return node.children?.map(headingText).join("") ?? "";
}

function startsWithMatchingHeading(body: string, title: string): boolean {
  if (!body || !title) return false;
  const first = fromMarkdown(body).children.find((node) =>
    node.type !== "definition" && !(node.type === "html" && /^<!--[\s\S]*-->$/.test(node.value.trim())),
  );
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  return first?.type === "heading" && normalize(headingText(first)) === normalize(title);
}

export function TaskDocumentSourceLink({ taskRef }: { taskRef: string }) {
  return (
    <Link to={createIssueDetailPath(encodeURIComponent(taskRef))} disableIssueQuicklook
      className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      Open source task <ArrowUpRight className="size-4" aria-hidden />
    </Link>
  );
}

export function TaskDocumentPanel({
  companyId,
  issueId,
  documentKey,
  initialDocument,
  revisionId,
  documentIssueId,
  currentIssueId = issueId,
}: {
  companyId?: string;
  issueId: string;
  documentKey: string;
  initialDocument?: IssueDocument;
  revisionId?: string;
  documentIssueId?: string;
  currentIssueId?: string;
}) {
  const location = useLocation();
  const [annotationPanelOpen, setAnnotationPanelOpen] = useState(false);
  const query = useQuery<IssueDocument | null>({
    queryKey: [...queryKeys.issues.documents(issueId), documentKey, ...(revisionId ? ["revision", revisionId] : []), ...(documentIssueId && companyId ? ["company", companyId] : [])],
    queryFn: async () => {
      try {
        const current = await issuesApi.getDocument(issueId, documentKey);
        if (companyId && current.companyId !== companyId) return null;
        if (!revisionId) return current;
        const revision = await issuesApi.getDocumentRevision(issueId, documentKey, revisionId);
        return { ...current, title: revision.title, body: revision.body, format: revision.format,
          latestRevisionId: revision.id, latestRevisionNumber: revision.revisionNumber, updatedAt: revision.createdAt };
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    initialData: revisionId ? undefined : initialDocument,
  });

  const view = useQueryView(query);
  const document = query.data;
  const title = document ? documentDisplayTitle(document) : "";
  const body = document?.body ?? "";
  const hasMatchingHeading = useMemo(() => startsWithMatchingHeading(body, title), [body, title]);

  if (query.isLoading || view.kind === "reconnecting") {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading document…
      </div>
    );
  }
  if (view.kind === "error") {
    return (
      <div className="py-6">
        <QueryErrorState error={query.error} action="load the document" onRetry={view.retry} retrying={view.isFetching} />
      </div>
    );
  }
  if (!document) {
    return (
      <div className="flex items-start gap-3 py-8 text-sm" role="status">
        <FileQuestion className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="space-y-1">
          <p className="font-medium">{revisionId ? "Reviewed revision unavailable" : "Document no longer available"}</p>
          <p className="text-muted-foreground">
            {revisionId ? "The exact reviewed revision could not be found. The current version has not been substituted." : "Close this tab or choose another document."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <article className="space-y-4">
      <header className="space-y-1">
        {!hasMatchingHeading ? <h2 className="text-lg font-semibold">{title}</h2> : null}
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span>{`Revision ${document.latestRevisionNumber ?? 1}`}</span>
          <span aria-hidden>·</span>
          <span>{`Updated ${new Date(document.updatedAt).toLocaleString()}`}</span>
          {!revisionId ? <DocumentAnnotationsCountChip
            issueId={issueId}
            docKey={document.key}
            panelOpen={annotationPanelOpen}
            onToggle={() => setAnnotationPanelOpen((open) => !open)}
          /> : <span>· Reviewed version</span>}
          <DocumentMarkdownActions key={document.latestRevisionId} document={document} />
        </div>
      </header>
      {document.body.trim() ? (
        <IssueDocumentAnnotations
          issueId={issueId}
          doc={document}
          bodyMarkdown={document.body}
          draftDirty={false}
          draftConflicted={false}
          historicalPreview={!!revisionId}
          locationHash={location.hash}
          panelOpen={annotationPanelOpen}
          onPanelOpenChange={setAnnotationPanelOpen}
          panelPlacement="popover"
        >
          <DocumentMarkdownBody documentKey={document.key} revisionId={revisionId}
            documentIssueId={documentIssueId} currentIssueId={currentIssueId}>
            {document.body}
          </DocumentMarkdownBody>
        </IssueDocumentAnnotations>
      ) : (
        <p className="text-sm text-muted-foreground">Document is empty.</p>
      )}
    </article>
  );
}
