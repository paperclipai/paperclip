import { useContext, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getAttachmentArtifactWorkProductMetadata,
  type IssueWorkProduct,
} from "@paperclipai/shared";
import { IssueGalleryContext } from "@/context/IssueGalleryContext";
import { TextAttachmentContext } from "@/context/TextAttachmentContext";
import { ImageGalleryModal } from "@/components/ImageGalleryModal";
import {
  RichWorkProductCard,
  stateChipFor,
} from "@/components/task-chat/RichWorkProductCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isImageLikeOutput, isVideoLikeOutput } from "@/lib/issue-output";
import { attachmentDownloadPath, isTextAttachment } from "@/lib/issue-attachments";
import { workProductHref } from "@/lib/issue-artifacts";
import { formatDateTime } from "@/lib/utils";
import {
  artifactText as text,
  artifactNumber as number,
  artifactUrl,
  artifactPreviewUrl,
  artifactFileSize,
  CSV_PREVIEW_MAX_BYTES,
  loadArtifactCsv,
} from "@/lib/artifact-card-data";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import {
  CommitCard,
  DataCard,
  FileCard,
  ImageCard,
  LinkPreviewCard,
  PullRequestCard,
  VideoCard,
  type ArtifactIdentity,
} from "./RichArtifactCards";

export interface IssueArtifactFileProps extends ArtifactIdentity {
  id: string;
  attachmentId?: string;
  filename: string;
  contentType: string;
  contentPath: string;
  downloadPath: string;
  openPath?: string;
  byteSize: number | null;
  metadata?: Record<string, unknown> | null;
}

/** Shared by uploads and promoted uploads; both use the issue's existing gallery. */
export function IssueArtifactFile(props: IssueArtifactFileProps) {
  const { metadata = null, attachmentId } = props;
  const openGallery = useContext(IssueGalleryContext);
  const openTextAttachment = useContext(TextAttachmentContext);
  const openTextAction = openTextAttachment && attachmentId && isTextAttachment({
    contentType: props.contentType,
    originalFilename: props.filename,
  }) ? (
    <Button
      variant="outline"
      size="sm"
      aria-label={`Open in tab: ${props.title}`}
      onClick={() => openTextAttachment(attachmentId, props.filename)}
    >
      Open in tab
    </Button>
  ) : null;
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [csvRequested, setCsvRequested] = useState(false);
  const image = isImageLikeOutput(props.contentType, props.filename);
  const video = isVideoLikeOutput(props.contentType, props.filename);
  const csv =
    props.contentType.split(";")[0] === "text/csv" ||
    /\.csv$/i.test(props.filename);
  const tooLarge =
    props.byteSize !== null && props.byteSize > CSV_PREVIEW_MAX_BYTES;
  const localCsv =
    csv &&
    /^\/api\/attachments\/[a-zA-Z0-9-]+\/content$/.test(props.contentPath);
  const data = useQuery({
    queryKey: ["artifact-csv", props.id, props.contentPath, props.updatedAt],
    queryFn: ({ signal }) => loadArtifactCsv(props.contentPath, signal),
    enabled: localCsv && !tooLarge && csvRequested,
    staleTime: Infinity,
  });
  // Read the CSV preview through the shared view: a loaded preview stays
  // visible during a transient refetch failure,and a no-data failure shows
  // readable copy with Retry.

  const dataView = useQueryView(data);
  const contentPath = artifactUrl(props.contentPath);
  const downloadPath = artifactUrl(props.downloadPath);
  const onOpen = () => {
    if (!openGallery?.(contentPath)) setGalleryOpen(true);
  };
  if ((image || video) && contentPath) {
    return (
      <>
        {video ? (
          <VideoCard
            {...props}
            videoUrl={contentPath}
            posterUrl={artifactPreviewUrl(text(metadata, "posterUrl"))}
            duration={text(metadata, "durationLabel")}
            onOpen={onOpen}
          />
        ) : (
          <ImageCard
            {...props}
            imageUrl={contentPath}
            alt={text(metadata, "alt") || props.title}
            width={number(metadata, "width")}
            height={number(metadata, "height")}
            onOpen={onOpen}
          />
        )}
        {galleryOpen && (
          <ImageGalleryModal
            items={[
              {
                id: props.id,
                contentPath,
                contentType: props.contentType,
                originalFilename: props.filename,
                downloadPath,
              },
            ]}
            initialIndex={0}
            open
            onOpenChange={setGalleryOpen}
          />
        )}
      </>
    );
  }
  if (localCsv && !tooLarge && data.data) {
    return (
      <DataCard
        {...props}
        {...data.data}
        downloadUrl={downloadPath}
        actions={
          <>
            {openTextAction}
            {downloadPath ? (
              <Button asChild size="sm" variant="outline">
                <a href={downloadPath} download={props.filename}>
                  Download file
                </a>
              </Button>
            ) : null}
          </>
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <FileCard
        {...props}
        fileSize={artifactFileSize(props.byteSize)}
        entries={[]}
        downloadUrl={downloadPath}
        openUrl={artifactUrl(props.openPath) || contentPath}
        actions={
          <>
            {openTextAction}
            {localCsv && !tooLarge && dataView.kind !== "error" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={data.isFetching}
                onClick={() => setCsvRequested(true)}
              >
                {data.isFetching ? "Loading preview…" : "Preview data"}
              </Button>
            ) : null}
          </>
        }
      />
      {csv && (tooLarge || dataView.kind === "error" || !localCsv) && (
        <div className="px-2 text-xs text-muted-foreground" role="status">
          {tooLarge
            ? "CSV is too large to preview. Download the file to view it."
            : dataView.kind === "error"
              ? <QueryErrorState size="inline" error={dataView.error} action="load the CSV preview" onRetry={dataView.retry} retrying={dataView.isFetching} />
              : "CSV preview is unavailable. Download the file to view it."}
        </div>
      )}
    </div>
  );
}

export function IssueWorkProductArtifactCard({
  workProduct: wp,
  author,
}: {
  workProduct: IssueWorkProduct;
  author: string;
}) {
  const m = wp.metadata;
  const href = artifactUrl(workProductHref(wp));
  const chip = stateChipFor(wp.type, wp.status, wp.reviewState);
  const identity: ArtifactIdentity = {
    title: wp.title,
    summary: wp.summary ?? "",
    author,
    updatedAt: formatDateTime(wp.updatedAt),
    statusBadge:
      wp.healthStatus === "unhealthy" ? (
        <Badge variant="destructive">Unhealthy</Badge>
      ) : chip ? (
        <Badge variant="outline">{chip.label}</Badge>
      ) : undefined,
  };
  const diff = {
    additions: number(m, "additions"),
    deletions: number(m, "deletions"),
    filesChanged: number(m, "changedFiles", "files"),
  };
  if (wp.type === "pull_request") {
    const state =
      text(m, "state") || (wp.status === "active" ? "open" : wp.status);
    const checks = text(m, "checks");
    return (
      <PullRequestCard
        {...identity}
        {...diff}
        number={number(m, "number", "pullRequestNumber")}
        repository={text(m, "repo", "repository", "repositoryName")}
        sourceBranch={text(m, "headRef", "head", "headBranch", "branch")}
        targetBranch={text(m, "baseRef", "base", "baseBranch")}
        state={
          state === "open" ||
          state === "draft" ||
          state === "merged" ||
          state === "closed"
            ? state
            : "unknown"
        }
        checks={
          checks === "passed" || checks === "failed" || checks === "pending"
            ? checks
            : "unknown"
        }
        evidenceSource={text(m, "evidenceSource")}
        reviewSummary={text(m, "reviewSummary")}
        url={href}
        statusBadge={
          wp.reviewState === "changes_requested" ||
          wp.reviewState === "needs_board_review" ||
          wp.status === "ready_for_review" ||
          wp.status === "changes_requested" ||
          wp.status === "failed" ||
          wp.healthStatus === "unhealthy"
            ? identity.statusBadge
            : undefined
        }
      />
    );
  }
  if (wp.type === "commit")
    return (
      <CommitCard
        {...identity}
        {...diff}
        sha={text(m, "sha", "shortSha") || wp.externalId || ""}
        repository={text(m, "repo", "repository", "repositoryName")}
        branch={text(m, "branch", "branchName")}
        url={href}
      />
    );
  if (wp.type === "preview_url")
    return (
      <LinkPreviewCard
        {...identity}
        url={href}
        imageUrl={artifactPreviewUrl(text(m, "imageUrl"))}
        imageAlt={text(m, "imageAlt") || wp.title}
      />
    );
  if (wp.type === "artifact") {
    const attachment = getAttachmentArtifactWorkProductMetadata(wp);
    const contentPath = artifactUrl(
      attachment?.contentPath || text(m, "contentPath") || href,
    );
    return (
      <IssueArtifactFile
        {...identity}
        id={wp.id}
        attachmentId={attachment?.attachmentId}
        filename={text(m, "originalFilename") || wp.title}
        contentType={text(m, "contentType")}
        contentPath={contentPath}
        openPath={artifactUrl(text(m, "openPath")) || href || contentPath}
        downloadPath={
          artifactUrl(text(m, "downloadPath")) ||
          (artifactPreviewUrl(contentPath)
            ? attachmentDownloadPath({ contentPath })
            : href || contentPath)
        }
        byteSize={number(m, "byteSize", "size")}
        metadata={m}
      />
    );
  }
  // Branches, external documents, and runtime services keep their existing actions and health semantics.
  return <RichWorkProductCard workProduct={wp} href={href || null} />;
}
