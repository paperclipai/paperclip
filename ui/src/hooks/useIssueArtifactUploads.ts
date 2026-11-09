import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Issue, IssueAttachment, IssueDocument } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { uploadedDocumentKey } from "@/lib/issue-artifact-upload";
import type { ArtifactUploadEntry } from "@/components/artifacts/ArtifactUploadControls";

export function useIssueArtifactUploads(issue: Pick<Issue, "id" | "companyId">) {
  const client = useQueryClient();
  const [entries, setEntries] = useState<ArtifactUploadEntry[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const files = useRef(new Map<string, File>());
  const queue = useRef<Promise<void>>(Promise.resolve());

  const enqueue = useCallback((batch: { id: string; file: File }[]) => {
    for (const { id, file } of batch) files.current.set(id, file);
    setEntries(current => [
      ...current.filter(entry => !batch.some(file => file.id === entry.id)),
      ...batch.map(({ id, file }): ArtifactUploadEntry => ({ id, filename: file.name, status: "uploading" })),
    ]);
    // Serialize imports so repeated filenames in successive selections get
    // distinct keys. The server still rejects concurrent document creates.
    queue.current = queue.current.then(async () => {
      for (const { id, file } of batch) {
        try {
          if (/\.(md|markdown)$/i.test(file.name) || file.type === "text/markdown") {
            const body = await file.text();
            const documents = await issuesApi.listDocuments(issue.id);
            const basename = file.name.replace(/\.[^.]+$/, "");
            const key = uploadedDocumentKey(file.name, documents.map(document => document.key));
            const document = await issuesApi.upsertDocument(issue.id, key, {
              title: basename.replace(/[-_]+/g, " ").slice(0, 200), format: "markdown", body, baseRevisionId: null,
            });
            client.setQueryData<IssueDocument[]>([...queryKeys.issues.documents(issue.id), "list"], current => [document, ...(current ?? []).filter(row => row.id !== document.id)]);
            void client.invalidateQueries({ queryKey: queryKeys.issues.documents(issue.id) });
          } else {
            const attachment = await issuesApi.uploadAttachment(issue.companyId, issue.id, file);
            client.setQueryData<IssueAttachment[]>(queryKeys.issues.attachments(issue.id), current => [attachment, ...(current ?? []).filter(row => row.id !== attachment.id)]);
            void client.invalidateQueries({ queryKey: queryKeys.issues.attachments(issue.id) });
          }
          void client.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
          files.current.delete(id);
          setEntries(current => current.filter(entry => entry.id !== id));
          setAnnouncement(`${file.name} added to this task.`);
        } catch (error) {
          setEntries(current => current.map(entry => entry.id === id ? {
            ...entry, status: "error", error: error instanceof Error ? error.message : "Upload failed. Try again.",
          } : entry));
        }
      }
    });
  }, [client, issue.companyId, issue.id]);

  const upload = useCallback((picked: File[]) => enqueue(picked.map(file => ({ id: crypto.randomUUID(), file }))), [enqueue]);
  const retry = useCallback((id: string) => {
    const file = files.current.get(id);
    if (file) enqueue([{ id, file }]);
  }, [enqueue]);
  const dismiss = useCallback((id: string) => {
    files.current.delete(id);
    setEntries(current => current.filter(entry => entry.id !== id));
  }, []);
  return { entries, announcement, upload, retry, dismiss };
}
