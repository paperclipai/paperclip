import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { ArtifactPreview } from "@/components/artifacts/ArtifactCard";
import { fileKindForAttachment, formatFileSize } from "@/components/task-chat/task-chat-attachments";
import { isImageAttachment } from "@/lib/issue-attachments";
import { isVideoLikeOutput } from "@/lib/issue-output";
import type { LabArtifact } from "../../kit";
import { toAttachmentRef } from "./adapters";

/**
 * MIRRORED, not mounted: the attachments block is inline JSX in the message
 * bubble (TaskChatBubble.tsx:264-352) and cannot be rendered without a whole
 * thread item. The markup below is that JSX verbatim, minus the click
 * handlers; the tile primitives, the kind labeller and the size formatter are
 * the real ones.
 */
export function ThreadAttachments({ artifacts }: { artifacts: LabArtifact[] }) {
  const refs = artifacts.filter((a) => a.kind !== "link").map(toAttachmentRef);
  const imageRefs = refs.filter((ref) => isImageAttachment({ contentType: ref.contentType ?? "", originalFilename: ref.name }));
  const attachmentRefs = refs.filter((ref) => !imageRefs.includes(ref));
  return (
    <>
      {imageRefs.length > 0 ? (
        <div className="flex max-w-(--pct-85) flex-col gap-2" data-testid="task-chat-bubble-media">
          <span className="text-xs text-muted-foreground">Images · {imageRefs.length}</span>
          <div className="grid grid-cols-4 gap-2">
            {imageRefs.slice(0, imageRefs.length > 4 ? 3 : 4).map((ref, index) => (
              <button
                key={ref.url}
                type="button"
                className="group aspect-video min-w-0 overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Open ${ref.name || `image ${index + 1}`}`}
              >
                <img
                  src={ref.openPath ?? ref.url}
                  alt={ref.name}
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform group-hover:scale-(--s-1_02)"
                />
              </button>
            ))}
            {imageRefs.length > 4 ? (
              <button
                type="button"
                className="aspect-video min-w-0 rounded-md bg-muted text-sm font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Open ${imageRefs.length - 3} more screenshots`}
              >
                +{imageRefs.length - 3}
              </button>
            ) : null}
          </div>
          <span className="truncate text-xs text-muted-foreground">
            {imageRefs.map((ref) => ref.name || "image").join(" · ")}
          </span>
        </div>
      ) : null}
      {attachmentRefs.length > 0 ? (
        <div className="flex max-w-(--pct-85) flex-col gap-2">
          <span className="text-xs text-muted-foreground">Files · {attachmentRefs.length}</span>
          <AttachmentGroup data-testid="task-chat-bubble-attachments">
            {attachmentRefs.map((ref) => {
              const kind = fileKindForAttachment(ref);
              const KindIcon = kind.icon;
              const size = formatFileSize(ref.byteSize);
              const video = isVideoLikeOutput(ref.contentType, ref.name);
              return (
                <Attachment key={ref.url} size="sm">
                  <AttachmentMedia className={video ? "aspect-video group-data-[size=sm]/attachment:w-20" : undefined}>
                    {video ? <ArtifactPreview artifact={{ title: ref.name, contentPath: ref.openPath ?? ref.url, mediaKind: "video" }} /> : <KindIcon aria-hidden />}
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle className="max-w-48">{ref.name}</AttachmentTitle>
                    <AttachmentDescription className="max-w-48">
                      {size ? `${kind.label} · ${size}` : kind.label}
                    </AttachmentDescription>
                  </AttachmentContent>
                  <AttachmentTrigger
                    aria-label={`Open ${ref.name}`}
                    render={video ? <button type="button" /> : <a href={ref.openPath ?? ref.url} target="_blank" rel="noreferrer" />}
                  />
                </Attachment>
              );
            })}
          </AttachmentGroup>
        </div>
      ) : null}
    </>
  );
}
