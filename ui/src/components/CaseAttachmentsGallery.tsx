import { useMemo, useState } from "react";
import { FileText } from "lucide-react";
import {
  caseAttachmentUrl,
  isImageAttachment,
  type CaseAttachmentRef,
} from "@/api/cases";
import { ImageGalleryModal, type GalleryMediaItem } from "@/components/ImageGalleryModal";
import { cn } from "@/lib/utils";

function humanBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Attachments gallery (P4 §4): image-friendly grid. Image cases hold variations
 * as attachments, so images render as thumbnails that open the shared
 * lightbox; non-image assets fall back to a labelled file tile. No
 * variation-picker (out of scope).
 */
export function CaseAttachmentsGallery({ attachments }: { attachments: CaseAttachmentRef[] }) {
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null);

  // The lightbox only navigates across image attachments.
  const imageItems = useMemo<GalleryMediaItem[]>(
    () =>
      attachments.filter(isImageAttachment).map((a) => ({
        id: a.id,
        contentPath: caseAttachmentUrl(a),
        contentType: a.asset.contentType,
        originalFilename: a.asset.originalFilename,
      })),
    [attachments],
  );

  if (attachments.length === 0) {
    return <p className="text-xs text-muted-foreground">No attachments.</p>;
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {attachments.map((attachment) => {
          const isImage = isImageAttachment(attachment);
          const filename = attachment.asset.originalFilename ?? "attachment";
          const imageIdx = isImage ? imageItems.findIndex((i) => i.id === attachment.id) : -1;
          return (
            <button
              key={attachment.id}
              type="button"
              onClick={() => isImage && imageIdx >= 0 && setGalleryIndex(imageIdx)}
              disabled={!isImage}
              title={filename}
              className={cn(
                "group relative flex aspect-square flex-col overflow-hidden rounded-lg border border-border bg-muted/40 text-left",
                isImage && "cursor-pointer hover:border-primary/50",
              )}
            >
              {isImage ? (
                <img
                  src={caseAttachmentUrl(attachment)}
                  alt={filename}
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform group-hover:scale-(--s-1_02)"
                />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-muted-foreground">
                  <FileText className="h-6 w-6" aria-hidden />
                  <span className="w-full truncate text-center text-(length:--text-micro)">{filename}</span>
                </div>
              )}
              <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-1.5 py-1 text-(length:--text-nano) text-white/90">
                {humanBytes(attachment.asset.byteSize)}
              </span>
            </button>
          );
        })}
      </div>
      {galleryIndex !== null && (
        <ImageGalleryModal
          items={imageItems}
          initialIndex={galleryIndex}
          open={galleryIndex !== null}
          onOpenChange={(open) => !open && setGalleryIndex(null)}
        />
      )}
    </>
  );
}
