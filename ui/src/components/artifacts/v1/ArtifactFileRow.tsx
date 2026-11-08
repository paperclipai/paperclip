import { describeUiError } from "@/lib/localized-ui-error";
import { t, useTranslation } from "@/i18n";
import { useQueryView } from "@/components/QueryView";
import { Download, ExternalLink } from "lucide-react";
import { useContext, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { IssueGalleryContext } from "@/context/IssueGalleryContext";
import { TextAttachmentContext } from "@/context/TextAttachmentContext";
import { ImageGalleryModal } from "@/components/ImageGalleryModal";
import { DataCard } from "@/components/artifacts/RichArtifactCards";
import { Button } from "@/components/ui/button";
import { CSV_PREVIEW_MAX_BYTES, loadArtifactCsv } from "@/lib/artifact-card-data";
import { isTextAttachment } from "@/lib/issue-attachments";
import { isImageLikeOutput, isVideoLikeOutput } from "@/lib/issue-output";
import type { FileRowSource } from "./adapters";
import { ArtifactRow } from "./ArtifactRow";
import type { ArtifactSubject } from "./kinds";

/** A small control beside a row, as the shipped rows draw theirs. */
export const ROW_ACTION_CLASS = "shrink-0 rounded-md px-1.5 py-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/**
 * A file (an attachment or an attachment-backed work product) as a V1 row
 * that opens the way the shipped card does: pictures and video in the task's
 * gallery (or a gallery of their own), text in a text tab when the panel
 * offers one — through an anchor that keeps its address for modifier clicks
 * and copying — and anything else in a new tab. Open raw and download stay
 * beside the name, and an eligible CSV keeps its "Preview data" table.
 */
export function ArtifactFileRow({
  subject,
  source,
  statusBadge,
  updatedAtLabel = "",
  now,
  testId,
}: {
  subject: ArtifactSubject;
  source: FileRowSource;
  statusBadge?: ReactNode;
  /** The data preview's header line, as the shipped card formats it. */
  updatedAtLabel?: string;
  now?: Date;
  testId?: string;
}) {
  useTranslation("task-components");
  const { id, attachmentId, filename, contentType, contentPath, openPath, downloadPath, byteSize } = source;
  const openGallery = useContext(IssueGalleryContext);
  const openTextAttachment = useContext(TextAttachmentContext);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [csvRequested, setCsvRequested] = useState(false);
  const picture = Boolean(contentPath) && (isImageLikeOutput(contentType, filename) || isVideoLikeOutput(contentType, filename));
  const textTab = Boolean(openTextAttachment && attachmentId && isTextAttachment({ contentType, originalFilename: filename }));
  const csv = contentType.split(";")[0] === "text/csv" || /\.csv$/i.test(filename);
  const tooLarge = byteSize !== null && byteSize > CSV_PREVIEW_MAX_BYTES;
  const localCsv = csv && /^\/api\/attachments\/[a-zA-Z0-9-]+\/content$/.test(contentPath);
  const data = useQuery({
    queryKey: ["artifact-csv", id, contentPath, updatedAtLabel],
    queryFn: ({ signal }) => loadArtifactCsv(contentPath, signal),
    enabled: localCsv && !tooLarge && csvRequested,
    staleTime: Infinity,
  });
  const dataView = useQueryView(data);

  const trailing = (
    <>
      {statusBadge}
      {localCsv && !tooLarge && !data.data && !(dataView.kind === "error") ? (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={data.isFetching} onClick={() => setCsvRequested(true)}>
          {data.isFetching ? t("task-components:loadingPreview_c4cf2b2c") : t("task-components:previewData_d526f2ae")}
        </Button>
      ) : null}
      {openPath ? (
        <a href={openPath} target="_blank" rel="noreferrer" aria-label={t("task-components:openRaw_8f09bc31", { value1: filename })} title={t("task-components:openRaw_7f57bf8c")} className={ROW_ACTION_CLASS}>
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      ) : null}
      {downloadPath ? (
        <a href={downloadPath} download={filename} aria-label={t("task-components:download_8fe1a08e", { value1: filename })} title={t("task-components:download_d6eafe82")} className={ROW_ACTION_CLASS}>
          <Download className="h-3 w-3" aria-hidden />
        </a>
      ) : null}
    </>
  );

  const row = picture ? (
    <ArtifactRow subject={subject} onClick={() => { if (!openGallery?.(contentPath)) setGalleryOpen(true); }} trailing={trailing} now={now} testId={testId} />
  ) : textTab ? (
    <ArtifactRow subject={subject} href={openPath || contentPath} external onClick={() => openTextAttachment?.(attachmentId!, filename)} trailing={trailing} now={now} testId={testId} />
  ) : (
    <ArtifactRow subject={subject} href={openPath || contentPath} external trailing={trailing} now={now} testId={testId} />
  );

  return (
    <div className="flex flex-col gap-2">
      {row}
      {picture && galleryOpen ? (
        <ImageGalleryModal items={[{ id, contentPath, contentType, originalFilename: filename, downloadPath }]} initialIndex={0} open onOpenChange={setGalleryOpen} />
      ) : null}
      {localCsv && data.data ? (
        <DataCard title={filename} summary="" author="" updatedAt={updatedAtLabel} filename={filename} {...data.data} downloadUrl={downloadPath} />
      ) : null}
      {csv && (tooLarge || (dataView.kind === "error")) ? (
        <div className="px-2 text-xs text-muted-foreground" role="status">
          {tooLarge ? t("task-components:csvIsTooLargeToPreviewDownload_b22a2423") : data.error ? describeUiError(data.error).body : undefined}
          {(dataView.kind === "error") ? (
            <Button variant="ghost" size="sm" onClick={() => void data.refetch()}>{t("task-components:retryPreview_ceba3527")}</Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
