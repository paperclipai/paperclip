import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Issue, IssueDocument } from "@paperclipai/shared";
import { Trash2 } from "lucide-react";
import { issuesApi } from "@/api/issues";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { documentDisplayTitle } from "@/lib/issue-artifacts";
import { queryKeys } from "@/lib/queryKeys";

type DeleteDocumentTarget = {
  issueId: string;
  documentKey: string;
};

export function IssueDocumentDeleteButton({
  issueId,
  document,
  canDeleteDocuments = false,
  onDeleted,
}: {
  issueId: string;
  document: IssueDocument;
  canDeleteDocuments?: boolean;
  onDeleted?: (documentKey: string) => void;
}) {
  const queryClient = useQueryClient();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const deleteDocument = useMutation({
    mutationFn: (target: DeleteDocumentTarget) => issuesApi.deleteDocument(target.issueId, target.documentKey),
    onSuccess: (_result, target) => {
      const removeDocumentSummary = (issue: Issue | undefined) => issue
        ? {
            ...issue,
            documentSummaries: issue.documentSummaries?.filter((summary) => summary.key !== target.documentKey),
          }
        : issue;
      queryClient.setQueryData<IssueDocument[] | undefined>(
        [...queryKeys.issues.documents(target.issueId), "list"],
        (documents) => documents?.filter((item) => item.key !== target.documentKey),
      );
      queryClient.setQueryData<IssueDocument | null>(
        [...queryKeys.issues.documents(target.issueId), target.documentKey],
        null,
      );
      queryClient.setQueryData<Issue | undefined>(
        queryKeys.issues.detail(target.issueId),
        removeDocumentSummary,
      );
      const detailAliases = queryClient.getQueriesData<Issue>({ queryKey: ["issues", "detail"] })
        .filter(([, issue]) => issue?.id === target.issueId || issue?.identifier === target.issueId);
      for (const [queryKey] of detailAliases) {
        queryClient.setQueryData<Issue | undefined>(queryKey, removeDocumentSummary);
        void queryClient.invalidateQueries({ queryKey, exact: true });
      }
      void queryClient.invalidateQueries({
        queryKey: [...queryKeys.issues.documents(target.issueId), "list"],
        exact: true,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(target.issueId) });
      setConfirmDeleteOpen(false);
      onDeleted?.(target.documentKey);
    },
  });

  if (!canDeleteDocuments || document.lockedAt) return null;

  const title = documentDisplayTitle(document);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground hover:text-destructive focus-visible:text-destructive"
        title="Delete document"
        aria-label={`Delete ${title}`}
        onClick={() => setConfirmDeleteOpen(true)}
      >
        <Trash2 aria-hidden />
      </Button>
      <AlertDialog
        open={confirmDeleteOpen}
        onOpenChange={(open) => {
          if (deleteDocument.isPending) return;
          setConfirmDeleteOpen(open);
          if (!open) deleteDocument.reset();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the document and its revision history. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteDocument.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {deleteDocument.error instanceof Error
                ? deleteDocument.error.message
                : "The document could not be deleted."}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteDocument.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteDocument.isPending}
              onClick={(event) => {
                event.preventDefault();
                deleteDocument.mutate({ issueId, documentKey: document.key });
              }}
            >
              {deleteDocument.isPending ? "Deleting…" : "Delete document"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
