import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { casesApi, type CaseDocument, type CaseDocumentRef, type CaseTaskDocumentRef } from "@/api/cases";
import { issuesApi } from "@/api/issues";
import { CaseRevisionRail } from "@/components/CaseRevisionRail";
import { MarkdownBody } from "@/components/MarkdownBody";
import { SourceTrustBadge } from "@/components/SourceTrustBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Link } from "@/lib/router";

/** Read-only current content and revision browsing, with no editor or restore path. */
export function CaseDocumentPreview({ caseIdentifier, document: documentRef }: {
  caseIdentifier: string;
  document: CaseDocumentRef | CaseTaskDocumentRef;
}) {
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const taskRef = "sourceKind" in documentRef ? documentRef : null;
  const current = useQuery<Pick<CaseDocument, "title" | "latestRevisionNumber" | "sourceTrust"> & { body: string }>({
    queryKey: taskRef ? ["issues", "document", taskRef.taskId, taskRef.key] : ["cases", "document", caseIdentifier, documentRef.key],
    queryFn: () => taskRef ? issuesApi.getDocument(taskRef.taskId, taskRef.key) : casesApi.getDocument(caseIdentifier, documentRef.key),
    enabled: open,
  });
  const document = current.data;
  const title = document?.title ?? documentRef.document.title ?? documentRef.key;
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild>
      <Button variant="ghost" aria-label={documentRef.document.title ?? documentRef.key} className="h-auto w-full justify-start gap-3 rounded-none px-0 py-3 text-left font-normal whitespace-normal">
        <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">{documentRef.document.title ?? documentRef.key}</span>
        {taskRef && <span className="shrink-0 font-mono text-xs text-muted-foreground">{taskRef.taskIdentifier ?? "Task"}</span>}
      </Button>
    </DialogTrigger>
    <DialogContent className="max-h-(--pct-80) overflow-y-auto sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {taskRef ? <Link to={`/issues/${taskRef.taskIdentifier ?? taskRef.taskId}#document-${encodeURIComponent(taskRef.key)}`} className="hover:underline">{taskRef.taskIdentifier ?? "Task document"}</Link> : `${caseIdentifier} · Saved on case`}
          {document?.latestRevisionNumber != null ? ` · Revision ${document.latestRevisionNumber}` : ""}
        </DialogDescription>
      </DialogHeader>
      {current.isLoading ? <p className="text-sm text-muted-foreground">Loading document…</p> : current.isError ? <p role="alert" className="text-sm text-destructive">This document couldn’t be loaded.</p> : document ? <div className="space-y-6">
        <SourceTrustBadge sourceTrust={document.sourceTrust} artifactLabel="document" />
        {document.body ? <MarkdownBody linkIssueReferences linkCaseReferences>{document.body}</MarkdownBody> : <p className="text-sm text-muted-foreground">This document is empty.</p>}
        <details open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)} className="space-y-3">
          <summary className="w-fit cursor-pointer text-sm text-muted-foreground hover:text-foreground">Revision history</summary>
          {historyOpen && <CaseRevisionRail caseIdentifier={caseIdentifier} documentKey={documentRef.key} taskId={taskRef?.taskId} />}
        </details>
      </div> : null}
    </DialogContent>
  </Dialog>;
}
