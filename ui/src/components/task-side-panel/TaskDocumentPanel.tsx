import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IssueDocument } from "@paperclipai/shared";
import { Check, Copy, Download, FileQuestion, Loader2 } from "lucide-react";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { DocumentAnnotationsCountChip, IssueDocumentAnnotations } from "@/components/IssueDocumentAnnotations";
import { MarkdownBody } from "@/components/MarkdownBody";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { queryKeys } from "@/lib/queryKeys";
import { documentDisplayTitle } from "@/lib/issue-artifacts";
import { useLocation } from "@/lib/router";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";

export function TaskDocumentPanel({
  issueId,
  documentKey,
  initialDocument,
}: {
  issueId: string;
  documentKey: string;
  initialDocument?: IssueDocument;
}) {
  const location = useLocation();
  const [annotationPanelOpen, setAnnotationPanelOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTargetRef = useRef({ issueId, documentKey });

  useEffect(() => {
    activeTargetRef.current = { issueId, documentKey };
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    setCopied(false);
    setCopyFailed(false);
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, [issueId, documentKey]);

  const query = useQuery<IssueDocument | null>({
    queryKey: [...queryKeys.issues.documents(issueId), documentKey],
    queryFn: async () => {
      try {
        return await issuesApi.getDocument(issueId, documentKey);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    initialData: initialDocument,
  });

  const view = useQueryView(query);

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
  const document = query.data;
  if (!document) {
    return (
      <div className="flex items-start gap-3 py-8 text-sm" role="status">
        <FileQuestion className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="space-y-1">
          <p className="font-medium">Document no longer available</p>
          <p className="text-muted-foreground">
            This tab is preserved so the missing resource is explicit. Close it or choose another document.
          </p>
        </div>
      </div>
    );
  }

  const handleCopy = async () => {
    if (document.body == null) return;
    const target = { issueId, documentKey };
    const isTargetActive = () =>
      activeTargetRef.current.issueId === target.issueId &&
      activeTargetRef.current.documentKey === target.documentKey;

    try {
      await copyTextToClipboard(document.body);
      if (!isTargetActive()) return;
      setCopyFailed(false);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        if (isTargetActive()) setCopied(false);
      }, 1500);
    } catch {
      if (!isTargetActive()) return;
      setCopied(false);
      setCopyFailed(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        if (isTargetActive()) setCopyFailed(false);
      }, 2000);
    }
  };

  const handleDownload = () => {
    if (document.body == null) return;
    const blob = new Blob([document.body], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    const safeTitle = (document.title?.trim() || document.key || "document")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .replace(/^-+|-+$/g, "");
    link.download = `${safeTitle || "document"}.md`;
    window.document.body.appendChild(link);
    link.click();
    window.document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <article className="space-y-4">
      <header className="space-y-2">
        <div className="flex items-center justify-end gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs font-normal flex items-center gap-1.5 cursor-pointer"
            onClick={handleCopy}
            title={copyFailed ? "Failed to copy" : "Copy Markdown"}
            aria-label={copyFailed ? "Failed to copy" : "Copy Markdown"}
          >
            {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
            <span>{copyFailed ? "Failed" : copied ? "Copied" : "Copy"}</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs font-normal flex items-center gap-1.5 cursor-pointer"
            onClick={handleDownload}
            title="Download Markdown"
            aria-label="Download Markdown"
          >
            <Download className="size-3.5" aria-hidden />
            <span>Download</span>
          </Button>
        </div>
        <h2 className="text-lg font-semibold">{documentDisplayTitle(document)}</h2>
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span>{`Revision ${document.latestRevisionNumber ?? 1}`}</span>
          <span aria-hidden>·</span>
          <span>{`Updated ${new Date(document.updatedAt).toLocaleString()}`}</span>
          <DocumentAnnotationsCountChip
            issueId={issueId}
            docKey={document.key}
            panelOpen={annotationPanelOpen}
            onToggle={() => setAnnotationPanelOpen((open) => !open)}
          />
        </div>
      </header>
      {document.body.trim() ? (
        <IssueDocumentAnnotations
          issueId={issueId}
          doc={document}
          bodyMarkdown={document.body}
          draftDirty={false}
          draftConflicted={false}
          historicalPreview={false}
          locationHash={location.hash}
          panelOpen={annotationPanelOpen}
          onPanelOpenChange={setAnnotationPanelOpen}
          panelPlacement="popover"
        >
          <MarkdownBody>{document.body}</MarkdownBody>
        </IssueDocumentAnnotations>
      ) : (
        <p className="text-sm text-muted-foreground">Document is empty.</p>
      )}
    </article>
  );
}
