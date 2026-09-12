import { useTranslation } from "@/i18n";
import { useMemo, useState, type DragEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IssueAttachment } from "@paperclipai/shared";
import { Download, ExternalLink, FileText, Maximize2, Paperclip, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FoldCurtain } from "./FoldCurtain";
import { MarkdownBody } from "./MarkdownBody";
import { OutputFileTile } from "./issue-output/OutputFileTile";
import { OutputVideoPlayer } from "./issue-output/OutputVideoPlayer";
import { formatBytes } from "@/lib/issue-output";
import {
  attachmentDownloadPath,
  attachmentFilename,
  attachmentOpenPath,
  isImageAttachment,
  isMarkdownAttachment,
  isVideoAttachment,
} from "@/lib/issue-attachments";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

interface IssueAttachmentsSectionProps {
  attachments: IssueAttachment[];
  uploadButton?: ReactNode;
  error?: string | null;
  dragActive?: boolean;
  deletePending?: boolean;
  onDelete?: (attachmentId: string) => void;
  onImageClick: (attachment: IssueAttachment) => void;
  onDragEnter?: (evt: DragEvent<HTMLDivElement>) => void;
  onDragOver?: (evt: DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (evt: DragEvent<HTMLDivElement>) => void;
  onDrop?: (evt: DragEvent<HTMLDivElement>) => void;
}

async function fetchAttachmentText(attachment: IssueAttachment) {
  const response = await fetch(attachment.contentPath, {
    headers: { Accept: "text/markdown,text/plain;q=0.9,*/*;q=0.1" },
  });
  if (!response.ok) {
    throw new Error(`Unable to load attachment preview (${response.status})`);
  }
  return response.text();
}

function AttachmentActions({
  attachment,
  onDelete,
  deletePending,
  onPreview,
}: {
  attachment: IssueAttachment;
  onDelete?: (attachmentId: string) => void;
  deletePending?: boolean;
  onPreview?: (attachment: IssueAttachment) => void;
}) {
  const { t } = useTranslation();
  const filename = attachmentFilename(attachment);
  return (
    <div className="flex shrink-0 items-center gap-1">
      {onPreview ? (
        <Button
          variant="ghost"
          size="icon-sm"
          title={t("localizationIssueAux.ui_Browse_gallery_1i7rnfh")}
          aria-label={t("localizationIssueAux.browseGalleryFile", { filename })}
          onClick={() => onPreview(attachment)}
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
      ) : null}
      <Button asChild variant="ghost" size="icon-sm" title={t("localizationIssueAux.ui_Open_in_new_tab_t5wfwx")}>
        <a href={attachmentOpenPath(attachment)} target="_blank" rel="noreferrer" aria-label={t("localizationIssueAux.openFile", { filename })}>
          <ExternalLink className="h-4 w-4" />
        </a>
      </Button>
      <Button asChild variant="ghost" size="icon-sm" title={t("localizationIssueAux.ui_Download_t8quxl")}>
        <a href={attachmentDownloadPath(attachment)} aria-label={t("localizationIssueAux.downloadFile", { filename })}>
          <Download className="h-4 w-4" />
        </a>
      </Button>
      {onDelete ? (
        <Button
          variant="ghost"
          size="icon-sm"
          title={t("localizationIssueAux.ui_Delete_attachment_u18ox7")}
          className="text-muted-foreground hover:text-destructive"
          onClick={() => onDelete(attachment.id)}
          disabled={deletePending}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}

function AttachmentMeta({ attachment }: { attachment: IssueAttachment }) {
  const { t } = useTranslation();
  return (
    <p className="mt-0.5 text-(length:--text-micro) text-muted-foreground">
      {t("localizationIssueAux.ui_Attachment_1wbgyxp")} {attachment.contentType} · {formatBytes(attachment.byteSize)}
    </p>
  );
}

function MarkdownAttachmentCard({
  attachment,
  onDelete,
  deletePending,
}: {
  attachment: IssueAttachment;
  onDelete?: (attachmentId: string) => void;
  deletePending?: boolean;
}) {
  const { t } = useTranslation();
  const filename = attachmentFilename(attachment);
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.attachmentPreview(attachment.id),
    queryFn: () => fetchAttachmentText(attachment),
  });

  return (
    <div id={`attachment-${attachment.id}`} className="scroll-mt-20 rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium" title={filename}>{filename}</span>
          </div>
          <AttachmentMeta attachment={attachment} />
        </div>
        <AttachmentActions attachment={attachment} onDelete={onDelete} deletePending={deletePending} />
      </div>
      <div className="mt-3 rounded-md hover:bg-accent/10">
        {isLoading ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">{t("localizationIssueAux.ui_Loading_preview_tpa4ub")}</p>
        ) : error ? (
          <p className="px-1 py-2 text-xs text-destructive">{t("localizationIssueAux.ui_Could_not_load_markdown_preview_1q5h0cg")}</p>
        ) : (
          <FoldCurtain>
            <MarkdownBody className="paperclip-edit-in-place-content min-h-(--sz-220px) text-sm leading-7" softBreaks={false}>
              {data ?? ""}
            </MarkdownBody>
          </FoldCurtain>
        )}
      </div>
    </div>
  );
}

function VideoAttachmentCard({
  attachment,
  onDelete,
  deletePending,
  onPreview,
}: {
  attachment: IssueAttachment;
  onDelete?: (attachmentId: string) => void;
  deletePending?: boolean;
  onPreview?: (attachment: IssueAttachment) => void;
}) {
  useTranslation();
  const filename = attachmentFilename(attachment);
  return (
    <Card id={`attachment-${attachment.id}`} className="block scroll-mt-20 overflow-hidden py-0">
      <OutputVideoPlayer src={attachment.contentPath} title={filename} />
      <div className="flex flex-col gap-2 p-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="break-words text-sm font-semibold text-foreground">{filename}</p>
          <AttachmentMeta attachment={attachment} />
        </div>
        <AttachmentActions
          attachment={attachment}
          onDelete={onDelete}
          deletePending={deletePending}
          onPreview={onPreview}
        />
      </div>
    </Card>
  );
}

function GenericAttachmentRow({
  attachment,
  onDelete,
  deletePending,
}: {
  attachment: IssueAttachment;
  onDelete?: (attachmentId: string) => void;
  deletePending?: boolean;
}) {
  const { t } = useTranslation();
  const filename = attachmentFilename(attachment);
  return (
    <Card id={`attachment-${attachment.id}`} className="flex-row scroll-mt-20 items-center gap-2.5 p-2">
      <OutputFileTile contentType={attachment.contentType} />
      <div className="min-w-0 flex-1">
        <a
          href={attachmentOpenPath(attachment)}
          target="_blank"
          rel="noreferrer"
          className="block truncate text-sm font-medium text-foreground hover:underline"
          title={filename}
        >
          {filename}
        </a>
        <p className="truncate text-(length:--text-micro) text-muted-foreground">
          {t("localizationIssueAux.ui_Attachment_1wbgyxp")} {attachment.contentType} · {formatBytes(attachment.byteSize)}
        </p>
      </div>
      <AttachmentActions attachment={attachment} onDelete={onDelete} deletePending={deletePending} />
    </Card>
  );
}

export function IssueAttachmentsSection({
  attachments,
  uploadButton,
  error,
  dragActive = false,
  deletePending = false,
  onDelete,
  onImageClick,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
}: IssueAttachmentsSectionProps) {
  const { t } = useTranslation();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const { imageAttachments, markdownAttachments, videoAttachments, genericAttachments } = useMemo(() => {
    const images: IssueAttachment[] = [];
    const markdown: IssueAttachment[] = [];
    const videos: IssueAttachment[] = [];
    const generic: IssueAttachment[] = [];

    for (const attachment of attachments) {
      if (isImageAttachment(attachment)) images.push(attachment);
      else if (isMarkdownAttachment(attachment)) markdown.push(attachment);
      else if (isVideoAttachment(attachment)) videos.push(attachment);
      else generic.push(attachment);
    }

    return {
      imageAttachments: images,
      markdownAttachments: markdown,
      videoAttachments: videos,
      genericAttachments: generic,
    };
  }, [attachments]);

  const requestDelete = (attachmentId: string) => setConfirmDeleteId(attachmentId);
  const confirmDelete = (attachmentId: string) => {
    if (!onDelete) return;
    onDelete(attachmentId);
    setConfirmDeleteId(null);
  };

  return (
    <div
      className={cn(
        "space-y-3 rounded-lg transition-colors",
        dragActive && "bg-primary/5",
      )}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Paperclip className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <h3 className="text-sm font-medium text-muted-foreground">{t("localizationIssueAux.ui_Attachments_8925gh")}</h3>
          <span className="text-xs text-muted-foreground">{attachments.length}</span>
        </div>
        {uploadButton}
      </div>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      {imageAttachments.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {imageAttachments.map((attachment) => (
            <div
              key={attachment.id}
              id={`attachment-${attachment.id}`}
              className="group relative aspect-square cursor-pointer scroll-mt-20 overflow-hidden rounded-lg border border-border bg-accent/10"
              onClick={() => onImageClick(attachment)}
            >
              <img
                src={attachment.contentPath}
                alt={attachment.originalFilename ?? t("localizationIssueAux.ui_attachment_1a02u08")}
                className="h-full w-full object-cover"
                loading="lazy"
              />
              <div className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/30" />
              {onDelete && confirmDeleteId === attachment.id ? (
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/60"
                  onClick={(event) => event.stopPropagation()}
                >
                  <p className="text-xs font-medium text-white">{t("localizationIssueAux.ui_Delete_fuu2tr")}</p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      className="rounded bg-destructive px-2 py-0.5 text-xs text-white hover:bg-destructive/80"
                      onClick={(event) => {
                        event.stopPropagation();
                        confirmDelete(attachment.id);
                      }}
                      disabled={deletePending}
                    >
                      {t("localizationIssueAux.ui_Yes_1dudzcg")}
                    </button>
                    <button
                      type="button"
                      className="rounded bg-muted px-2 py-0.5 text-xs hover:bg-muted/80"
                      onClick={(event) => {
                        event.stopPropagation();
                        setConfirmDeleteId(null);
                      }}
                    >
                      {t("localizationIssueAux.ui_No_r5wqai")}
                    </button>
                  </div>
                </div>
              ) : onDelete ? (
                <button
                  type="button"
                  className="absolute right-1.5 top-1.5 rounded-md bg-black/50 p-1 text-white opacity-0 transition-opacity hover:bg-destructive group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    requestDelete(attachment.id);
                  }}
                  title={t("localizationIssueAux.ui_Delete_attachment_u18ox7")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {markdownAttachments.length > 0 && (
        <div className="space-y-3">
          {markdownAttachments.map((attachment) => (
            <MarkdownAttachmentCard
              key={attachment.id}
              attachment={attachment}
              onDelete={onDelete ? requestDelete : undefined}
              deletePending={deletePending}
            />
          ))}
        </div>
      )}

      {videoAttachments.length > 0 && (
        <div className="space-y-3">
          {videoAttachments.map((attachment) => (
            <VideoAttachmentCard
              key={attachment.id}
              attachment={attachment}
              onDelete={onDelete ? requestDelete : undefined}
              deletePending={deletePending}
              onPreview={onImageClick}
            />
          ))}
        </div>
      )}

      {genericAttachments.length > 0 && (
        <div className="space-y-2">
          {genericAttachments.map((attachment) => (
            <GenericAttachmentRow
              key={attachment.id}
              attachment={attachment}
              onDelete={onDelete ? requestDelete : undefined}
              deletePending={deletePending}
            />
          ))}
        </div>
      )}

      {onDelete && confirmDeleteId && !imageAttachments.some((attachment) => attachment.id === confirmDeleteId) ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3">
          <p className="text-sm font-medium text-destructive">{t("localizationIssueAux.ui_Delete_this_attachment_This_cannot_be_undone_1jwzzyn")}</p>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)} disabled={deletePending}>
              {t("localizationIssueAux.ui_Cancel_ew9em3")}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => confirmDelete(confirmDeleteId)} disabled={deletePending}>
              {deletePending ? t("localizationIssueAux.ui_Deleting_e2v55t") : t("localizationIssueAux.ui_Delete_oay2cq")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
