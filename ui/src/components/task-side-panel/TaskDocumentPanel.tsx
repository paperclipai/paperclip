import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IssueDocument } from "@paperclipai/shared";
import { FileQuestion, Loader2 } from "lucide-react";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { DocumentAnnotationsCountChip, IssueDocumentAnnotations } from "@/components/IssueDocumentAnnotations";
import { DocumentMarkdownBody } from "@/components/DocumentMarkdownBody";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { queryKeys } from "@/lib/queryKeys";
import { documentDisplayTitle } from "@/lib/issue-artifacts";
import { useLocation } from "@/lib/router";
import { useTranslation } from "@/i18n";

export function TaskDocumentPanel({
  issueId,
  documentKey,
  initialDocument,
  revisionId,
  documentIssueId,
  currentIssueId = issueId,
}: {
  issueId: string;
  documentKey: string;
  initialDocument?: IssueDocument;
  revisionId?: string;
  documentIssueId?: string;
  currentIssueId?: string;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const [annotationPanelOpen, setAnnotationPanelOpen] = useState(false);
  const query = useQuery<IssueDocument | null>({
    queryKey: [...queryKeys.issues.documents(issueId), documentKey, ...(revisionId ? ["revision", revisionId] : [])],
    queryFn: async () => {
      try {
        const current = await issuesApi.getDocument(issueId, documentKey);
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

  if (query.isLoading || view.kind === "reconnecting") {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("sidePanel.TaskDocumentPanel.loading")}
      </div>
    );
  }
  if (view.kind === "error") {
    return (
      <div className="py-6">
        <QueryErrorState error={query.error} action={t("sidePanel.TaskDocumentPanel.loadAction")} onRetry={view.retry} retrying={view.isFetching} />
      </div>
    );
  }
  const document = query.data;
  if (!document) {
    return (
      <div className="flex items-start gap-3 py-8 text-sm" role="status">
        <FileQuestion className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="space-y-1">
          <p className="font-medium">{revisionId ? t("sidePanel.TaskDocumentPanel.revisionUnavailable") : t("sidePanel.TaskDocumentPanel.documentUnavailable")}</p>
          <p className="text-muted-foreground">
            {revisionId ? t("sidePanel.TaskDocumentPanel.revisionMissingNotice") : t("sidePanel.TaskDocumentPanel.closeNotice")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <article className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">{documentDisplayTitle(document)}</h2>
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span>{t("sidePanel.TaskDocumentPanel.revision", { number: document.latestRevisionNumber ?? 1 })}</span>
          <span aria-hidden>·</span>
          <span>{t("sidePanel.TaskDocumentPanel.updated", { date: new Date(document.updatedAt).toLocaleString() })}</span>
          {!revisionId ? <DocumentAnnotationsCountChip
            issueId={issueId}
            docKey={document.key}
            panelOpen={annotationPanelOpen}
            onToggle={() => setAnnotationPanelOpen((open) => !open)}
          /> : <span>{t("sidePanel.TaskDocumentPanel.reviewedVersion")}</span>}
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
        <p className="text-sm text-muted-foreground">{t("sidePanel.TaskDocumentPanel.empty")}</p>
      )}
    </article>
  );
}
