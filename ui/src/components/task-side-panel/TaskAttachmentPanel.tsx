import { localizeUiError, describeUiError } from "@/lib/localized-ui-error";
import { t, useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { issuesApi } from "@/api/issues";
import { Button } from "@/components/ui/button";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { CsvPreview } from "@/components/CsvPreview";
import { isCsvFile } from "@/lib/csv-preview";
import { PatchLines } from "@/components/PatchLines";
import { isPatchFile } from "@/lib/patch";
import { MarkdownBody } from "@/components/MarkdownBody";
import { HtmlArtifactPreview } from "@/components/HtmlArtifactPreview";
import { FilePreviewModeToggle, type FilePreviewMode } from "@/components/FilePreviewModeToggle";
import { isHtmlPreview } from "@/lib/html-preview";
import { attachmentDownloadPath, isMarkdownAttachment, isTextAttachment } from "@/lib/issue-attachments";
import { queryKeys } from "@/lib/queryKeys";

import { readTextPreview, TEXT_PREVIEW_MAX_BYTES } from "@/lib/text-preview";
export { readTextPreview, TEXT_PREVIEW_MAX_BYTES } from "@/lib/text-preview";

export function TextAttachmentPreview({ title, text, markdown, html = false, csv = false, patch = isPatchFile(title), downloadUrl }: {
  title: string;
  text: string;
  markdown: boolean;
  html?: boolean;
  csv?: boolean;
  patch?: boolean;
  downloadUrl: string;
}) {
  useTranslation("task-components");
  const [mode, setMode] = useState<FilePreviewMode>("rendered");
  useEffect(() => setMode("rendered"), [title]);
  const renderCsv = csv && mode === "rendered" && text.length > 0;
  const renderHtml = html && mode === "rendered" && text.length > 0;
  return (
    <div className="flex h-full min-h-0 min-w-0 max-w-full flex-col">
      <header className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>{title}</h2>
        {markdown || html || csv ? <FilePreviewModeToggle mode={mode} onChange={setMode} label={html ? t("task-components:htmlView_765d02e6") : csv ? t("task-components:csvView_cc2c8ad3") : t("task-components:markdownView_4baf040e")} /> : null}
        <Button asChild variant="ghost" size="icon-sm">
          <a href={downloadUrl} download aria-label={t("task-components:download_8fe1a08e", { value1: title })} title={t("task-components:download_8fe1a08e", { value1: title })}><Download aria-hidden /></a>
        </Button>
      </header>
      <div className={renderHtml || renderCsv ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "min-h-0 min-w-0 flex-1 overflow-auto p-4"}>
        {text.length === 0 ? <p className="text-sm text-muted-foreground">{t("task-components:fileIsEmpty_912dda30")}</p>
          : renderCsv ? <CsvPreview text={text} title={title} />
          : renderHtml ? <HtmlArtifactPreview html={text} title={title} />
          : markdown && mode === "rendered" ? <MarkdownBody mediaMode="reference">{text}</MarkdownBody>
          : patch ? <pre className="paperclip-patch-source m-0 min-w-0 whitespace-pre-wrap wrap-anywhere font-mono text-sm" aria-label={t("task-components:patchAttachmentLabel", { title })}><code><PatchLines text={text} /></code></pre>
          : <pre className="whitespace-pre-wrap wrap-anywhere font-mono text-sm" aria-label={t("task-components:rawText_36254db4", { value1: title })}>{text}</pre>}
      </div>
    </div>
  );
}

export function TaskAttachmentPanel({ issueId, attachmentId }: { issueId: string; attachmentId: string }) {
  useTranslation("task-components");
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
  if (attachments.isLoading || attachmentsView.kind === "reconnecting") return <p className="p-4 text-sm" role="status">{t("task-components:loadingFile_e937adaa")}</p>;
  if (attachmentsView.kind === "error") {
    return (
      <QueryErrorState
        className="m-4"
        error={attachments.error}
        action="load attachment details"
        onRetry={attachmentsView.retry}
        retrying={attachmentsView.isFetching}
      />
    );
  }
  if (!attachment) return <p className="p-4 text-sm" role="status">{t("task-components:fileNoLongerAvailableCloseThisTab_e33f3900")}</p>;
  const downloadUrl = attachmentDownloadPath(attachment);
  if (!eligible || contentView.kind === "error") {
    return (
      <div className="space-y-3 p-4" role="alert">
        <p className="text-sm">{contentView.kind === "error" ? t("task-components:couldNotPreviewThisFileRetryOr_d928e7da") : t("task-components:thisFileIsTooLargeOrIs_ff7f7c37")}</p>
        {eligible ? <Button onClick={() => void content.refetch()}>{t("task-components:retry_942087cc")}</Button> : null}
        <Button asChild variant="outline"><a href={downloadUrl} download>{t("task-components:downloadFile_9de4149f")}</a></Button>
      </div>
    );
  }
  if (content.data === undefined) return <p className="p-4 text-sm" role="status">{t("task-components:loadingFile_e937adaa")}</p>;
  return <TextAttachmentPreview key={attachment.id} title={attachment.originalFilename ?? attachment.id} text={content.data} patch={isPatchFile(attachment.originalFilename, attachment.contentType)} csv={isCsvFile(attachment.originalFilename ?? "", attachment.contentType)} markdown={isMarkdownAttachment(attachment)} html={isHtmlPreview(attachment.contentType, attachment.originalFilename)} downloadUrl={downloadUrl} />;
}
