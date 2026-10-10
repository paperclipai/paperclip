import { useContext, useState, type ReactNode } from "react";
import { IssueGalleryContext } from "@/context/IssueGalleryContext";
import { ImageGalleryModal } from "@/components/ImageGalleryModal";
import { isVideoLikeOutput } from "@/lib/issue-output";
import { ArtifactPreview } from "./ArtifactCard";

/** A media tile shared by uploaded files and attachment-backed work products. */
export function MediaArtifactCard({ id, title, contentPath, contentType, originalFilename, downloadPath, detail, badge }: {
  id: string;
  title: string;
  contentPath: string;
  contentType: string;
  originalFilename: string;
  downloadPath?: string;
  detail?: string;
  badge?: ReactNode;
}) {
  const openIssueGallery = useContext(IssueGalleryContext);
  const [open, setOpen] = useState(false);
  const mediaKind = isVideoLikeOutput(contentType, originalFilename) ? "video" : "image";
  return (
    <>
      <button
        type="button"
        aria-label={`Open gallery: ${title}`}
        onClick={() => { if (!openIssueGallery?.(contentPath)) setOpen(true); }}
        className="group flex h-full w-full min-w-0 flex-col overflow-hidden rounded-md border border-border bg-card text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArtifactPreview artifact={{ title, contentPath, mediaKind }} />
        <span className="flex w-full flex-1 flex-col gap-1 p-2.5">
          <span className="line-clamp-2 break-words text-sm font-medium" title={title}>{title}</span>
          <span className="flex flex-wrap items-center justify-between gap-1.5">
            <span className="text-xs text-muted-foreground">{detail ?? (mediaKind === "video" ? "Video" : "Image")}</span>
            {badge}
          </span>
        </span>
      </button>
      {open ? <ImageGalleryModal items={[{ id, contentPath, contentType, originalFilename, downloadPath }]} initialIndex={0} open onOpenChange={setOpen} /> : null}
    </>
  );
}
