import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "@/components/MarkdownBody";
import { FoldedCommentBody } from "@/components/FoldedCommentBody";
import { ImageGalleryModal, type GalleryMediaItem } from "@/components/ImageGalleryModal";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AgentIcon } from "@/components/AgentIconPicker";
import { CommentAttributionChip } from "@/components/CommentAttributionChip";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { extractAttachmentRefs, extractImageRefs, fileKindForName } from "./task-chat-attachments";
import { TaskChatSystemNotice } from "./TaskChatSystemNotice";
import type { TaskChatMessageItem } from "./task-chat-model";

interface TaskChatBubbleProps {
  item: TaskChatMessageItem;
  /** Action shown beside the queued state for an interruptible message. */
  queuedAction?: ReactNode;
  /**
   * The settled run turn rendered on this bubble's footer line (round 9):
   * replaces the plain timestamp with "2:34 PM · ✓ Worked · 38s · 3 tools"
   * (the timestamp leads the summary), expandable to the nested tool history.
   * Supplied by TaskChatThreadView when `item.attachedTurn` is set.
   */
  attachedTurn?: ReactNode;
  /**
   * copy · 👍 · 👎 controls for an agent bubble's footer line (PAP-413).
   * Rendered here only for a runless reply (leading the bare timestamp); when
   * an attached turn is present it owns these via its `leading` slot instead,
   * so this bubble skips them. Human/system bubbles pass nothing.
   */
  actions?: ReactNode;
}

function initialsForName(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/**
 * Author-typed message row — the primary legibility signal. Human messages sit
 * right in a solid accent bubble; agent messages sit directly on the page
 * surface with an avatar author header (the agent's assigned icon + name);
 * system notices are centered and recede.
 */
function galleryItemForImage(src: string, name?: string): GalleryMediaItem {
  return {
    id: src,
    contentPath: src,
    // The modal only inspects contentType/filename to spot videos; embedded
    // markdown images are always images, so an empty type is safe here.
    contentType: "",
    originalFilename: name?.trim() ? name : "image",
  };
}

export function TaskChatBubble({ item, queuedAction, attachedTurn, actions }: TaskChatBubbleProps) {
  // Clicking an embedded image opens the full-screen lightbox (with download);
  // arrow keys walk across the other images in the same bubble.
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  if (item.interstitial) {
    // Interstitial updates are ephemeral (PAP-361): while streaming the text
    // lives on the live parent row's line (TaskChatStatusItem.selfTalk), and
    // once finished it renders nowhere — the run log / classic transcript
    // remain the archive. Never rendered as a bubble.
    return null;
  }

  if (item.author === "system") {
    // Collapsed humanized one-liner, expandable to the full detail (PAP-443).
    return <TaskChatSystemNotice item={item} />;
  }

  const isHuman = item.author === "human";
  // Non-image file references ("[name](/api/attachments/…/content)") render as
  // attachment chips under the bubble; link-only lines leave the body text.
  const { refs: attachmentRefs, text: bodyText } = extractAttachmentRefs(item.text);
  const imageRefs = extractImageRefs(bodyText);
  const galleryItems: GalleryMediaItem[] =
    lightboxSrc !== null && !imageRefs.some((ref) => ref.url === lightboxSrc)
      // A clicked image the extractor missed (e.g. inline HTML) still gets a
      // single-item lightbox rather than nothing.
      ? [galleryItemForImage(lightboxSrc)]
      : imageRefs.map((ref) => galleryItemForImage(ref.url, ref.name));
  const lightboxIndex = lightboxSrc === null
    ? -1
    : Math.max(0, galleryItems.findIndex((galleryItem) => galleryItem.contentPath === lightboxSrc));
  return (
    <div className={cn("tc-enter-bubble flex w-full flex-col gap-1", isHuman ? "items-end" : "items-start")}>
      {!isHuman && item.authorName ? (
        <span className="flex items-center gap-2 px-1">
          <Avatar size="sm" className="shrink-0" data-testid="task-chat-agent-avatar">
            {item.agentIcon ? (
              <AvatarFallback>
                <AgentIcon icon={item.agentIcon} className="h-3.5 w-3.5" />
              </AvatarFallback>
            ) : (
              <AvatarFallback>{initialsForName(item.authorName)}</AvatarFallback>
            )}
          </Avatar>
          <span className="text-sm font-semibold text-foreground">{item.authorName}</span>
          {item.onBehalfOfUserName ? (
            <CommentAttributionChip
              agentName={item.authorName}
              userName={item.onBehalfOfUserName}
            />
          ) : null}
        </span>
      ) : null}
      {bodyText.length > 0 ? (
        <div
          // Stable hook so the TaskChatLab bubble-treatment explorations
          // (PAP-501) can scope background/border overrides to the agent
          // bubble body without touching the live thread.
          data-testid={isHuman ? "task-chat-human-bubble" : "task-chat-agent-bubble"}
          className={cn(
            "break-words py-2 text-sm",
            isHuman
              ? "max-w-(--pct-85) rounded-2xl rounded-br-sm bg-(--liveness-blue) px-3.5 text-white"
              : "w-full bg-transparent px-1 text-foreground",
            item.optimistic ? "opacity-80" : null,
          )}
        >
          <FoldedCommentBody
            body={bodyText}
            toggleClassName={isHuman ? "text-white/80 hover:text-white hover:bg-white/10" : undefined}
          >
            {(visibleBody) => (
              <MarkdownBody
                // The human bubble sits on the solid --liveness-blue accent, so
                // prose must inherit the bubble's white text in both themes.
                className={isHuman ? "paperclip-markdown-on-accent" : undefined}
                softBreaks
                linkIssueReferences
                onImageClick={setLightboxSrc}
              >
                {visibleBody}
              </MarkdownBody>
            )}
          </FoldedCommentBody>
        </div>
      ) : null}
      {attachmentRefs.length > 0 ? (
        <AttachmentGroup
          className="max-w-(--pct-85)"
          data-testid="task-chat-bubble-attachments"
        >
          {attachmentRefs.map((ref) => {
            const kind = fileKindForName(ref.name);
            const KindIcon = kind.icon;
            return (
              <Attachment key={ref.url} size="sm" className={cn(item.optimistic && "opacity-80")}>
                <AttachmentMedia>
                  <KindIcon aria-hidden />
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle className="max-w-48">{ref.name}</AttachmentTitle>
                  <AttachmentDescription className="max-w-48">{kind.label}</AttachmentDescription>
                </AttachmentContent>
                <AttachmentTrigger
                  aria-label={`Open ${ref.name}`}
                  render={<a href={ref.url} target="_blank" rel="noreferrer" />}
                />
              </Attachment>
            );
          })}
        </AttachmentGroup>
      ) : null}
      {item.optimistic ? (
        <span className="flex items-center gap-1 px-1 text-(length:--text-micro) text-muted-foreground">
          <span>{item.optimistic === "queued" ? "Queued" : "Sending…"}</span>
          {item.optimistic === "queued" ? queuedAction : null}
        </span>
      ) : attachedTurn ? (
        // The settled turn takes over the footer line: timestamp + "✓ Worked"
        // summary, always visible; expanding stretches beneath the bubble. The
        // copy/👍/👎 actions (PAP-413) ride the turn's summary row via its
        // `leading` slot — not this wrapper — so they stay anchored to the
        // summary line when the tool history expands beneath it.
        <div className="self-stretch" data-testid="task-chat-bubble-attached-turn">
          {attachedTurn}
        </div>
      ) : actions ? (
        // Agent reply without run activity: the actions still lead the footer,
        // with the always-visible timestamp trailing (PAP-413).
        <div className="flex items-center gap-1">
          {actions}
          {item.timestamp ? (
            <span className="px-1 text-(length:--text-micro) text-muted-foreground">
              {item.timestamp}
            </span>
          ) : null}
        </div>
      ) : item.timestamp ? (
        // Timestamps are always visible (round 9) — no longer hover-revealed.
        <span className="px-1 text-(length:--text-micro) text-muted-foreground">
          {item.timestamp}
        </span>
      ) : null}
      {lightboxSrc !== null && lightboxIndex >= 0 ? (
        <ImageGalleryModal
          items={galleryItems}
          initialIndex={lightboxIndex}
          open
          onOpenChange={(open) => {
            if (!open) setLightboxSrc(null);
          }}
        />
      ) : null}
    </div>
  );
}
