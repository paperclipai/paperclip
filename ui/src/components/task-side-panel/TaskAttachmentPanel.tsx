import { t, useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { issuesApi } from "@/api/issues";
import { Button } from "@/components/ui/button";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { CsvPreview } from "@/components/CsvPreview";
import { isCsvFile } from "@/lib/csv-preview";
import { MarkdownBody } from "@/components/MarkdownBody";
import { HtmlArtifactPreview } from "@/components/HtmlArtifactPreview";
import { FilePreviewModeToggle, type FilePreviewMode } from "@/components/FilePreviewModeToggle";
import { isHtmlPreview } from "@/lib/html-preview";
import { attachmentDownloadPath, isMarkdownAttachment, isTextAttachment } from "@/lib/issue-attachments";
import { queryKeys } from "@/lib/queryKeys";

export const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

/** Bound the actual response, not just producer-supplied attachment metadata. */
export async function readTextPreview(response: Response) {
  // Carry the status so the shared classification can tell an outage (503) from a real failure.
  if (!response.ok) throw Object.assign(new Error(`Could not load file (${response.status}).`), { status: response.status });
  if (!response.body) throw new Error(t("oct5Core.s0272"));
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > TEXT_PREVIEW_MAX_BYTES) throw new Error(t("oct5Core.s0273"));
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    if (text.includes("\0")) throw new Error(t("oct5Core.s0274"));
    return text;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export function TextAttachmentPreview({ title, text, markdown, html = false, csv = false, downloadUrl }: {
  title: string;
  text: string;
  markdown: boolean;
  html?: boolean;
  csv?: boolean;
  downloadUrl: string;
}) {
  useTranslation();
  const [mode, setMode] = useState<FilePreviewMode>("rendered");
  useEffect(() => setMode("rendered"), [title]);
  const renderCsv = csv && mode === "rendered" && text.length > 0;
  const renderHtml = html && mode === "rendered" && text.length > 0;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>{title}</h2>
        {markdown || html || csv ? <FilePreviewModeToggle mode={mode} onChange={setMode} label={html ? t("oct19Tasks.htmlView") : csv ? t("oct19Tasks.csvView") : t("oct5Core.s0275")} /> : null}
        <Button asChild variant="ghost" size="icon-sm">
          <a href={downloadUrl} download aria-label={`Download ${title}`} title={`Download ${title}`}><Download aria-hidden /></a>
        </Button>
      </header>
      <div className={renderHtml || renderCsv ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "min-h-0 flex-1 overflow-auto p-4"}>
        {text.length === 0 ? <p className="text-sm text-muted-foreground">{t("oct5Core.s0278")}</p>
          : renderCsv ? <CsvPreview text={text} title={title} />
          : renderHtml ? <HtmlArtifactPreview html={text} title={title} />
          : markdown && mode === "rendered" ? <MarkdownBody mediaMode="reference">{text}</MarkdownBody>
          : <pre className="whitespace-pre-wrap break-words font-mono text-sm" aria-label={t("oct5Core.rawText", { title })}>{text}</pre>}
      </div>
    </div>
  );
}

export function TaskAttachmentPanel({ issueId, attachmentId }: { issueId: string; attachmentId: string }) {
  useTranslation();
  const attachments = useQuery({
    queryKey: queryKeys.issues.attachments(issueId),
    queryFn: () => issuesApi.listAttachments(issueId),
  });
  // Re-resolve against this task's authorized attachment list; never trust persisted URLs.
  const attachment = attachments.data?.find((item) => item.id === attachmentId);
  const eligible = attachment && isTextAttachment(attachment) && attachment.byteSize <= TEXT_PREVIEW_MAX_BYTES;
  const content = useQuery({
    queryKey: ["task-text-attachment", issueId, attachmentId],
    queryFn: async ({ signal }) => readTextPreview(await fetch(
      `/api/attachments/${encodeURIComponent(attachmentId)}/content`,
      { signal, credentials: "same-origin" },
    )),
    enabled: Boolean(eligible),
  });
  const attachmentsView = useQueryView(attachments);
  const contentView = useQueryView(content);
  if (attachments.isLoading || attachmentsView.kind === "reconnecting") return <p className="p-4 text-sm" role="status">{t("oct5Core.s0279")}</p>;
  if (attachmentsView.kind === "error") {
    return (
      <QueryErrorState
        className="m-4"
        error={attachments.error}
        action={t("nov02Components.actionLoadAttachmentDetails", { defaultValue: "load attachment details" })}
        onRetry={attachmentsView.retry}
        retrying={attachmentsView.isFetching}
      />
    );
  }
  if (!attachment) return <p className="p-4 text-sm" role="status">{t("oct5Core.s0282")}</p>;
  const downloadUrl = attachmentDownloadPath(attachment);
  if (!eligible || contentView.kind === "error") {
    return (
      <div className="space-y-3 p-4" role="alert">
        <p className="text-sm">{contentView.kind === "error" ? t("oct5Core.s0283") : t("oct5Core.s0284")}</p>
        {eligible ? <Button onClick={() => void content.refetch()}>{t("oct5Core.s0281")}</Button> : null}
        <Button asChild variant="outline"><a href={downloadUrl} download>{t("oct5Core.s0211")}</a></Button>
      </div>
    );
  }
  if (content.data === undefined) return <p className="p-4 text-sm" role="status">{t("oct5Core.s0279")}</p>;
  return <TextAttachmentPreview key={attachment.id} title={attachment.originalFilename ?? attachment.id} text={content.data} csv={isCsvFile(attachment.originalFilename ?? "", attachment.contentType)} markdown={isMarkdownAttachment(attachment)} html={isHtmlPreview(attachment.contentType, attachment.originalFilename)} downloadUrl={downloadUrl} />;
}
