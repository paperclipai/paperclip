import { useState, type ReactNode } from "react";
import type { IssueAttachment } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "@/components/MarkdownBody";
import {
  ImageGalleryModal,
  type GalleryMediaItem,
} from "@/components/ImageGalleryModal";
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
import {
  extractAttachmentRefs,
  extractImageRefs,
  fileKindForAttachment,
  formatFileSize,
  hydrateAttachmentRefs,
  isImageAttachment,
  stripStandaloneImageEmbeds,
} from "./task-chat-attachments";
import { TaskChatSystemNotice } from "./TaskChatSystemNotice";
import type { TaskChatMessageItem } from "./task-chat-model";

interface TaskChatBubbleProps {
  item: TaskChatMessageItem;
  /** Requeues a blocked task after a no-live-execution-path recovery notice. */
  onTryAgainNoLiveExecutionPath?: () => Promise<void> | void;
  tryAgainNoLiveExecutionPathPending?: boolean;
  /** Disable the entrance animation when replacing an already-visible live response. */
  animateEntry?: boolean;
  /** Action shown beside the queued state for an interruptible message. */
  queuedAction?: ReactNode;
  /**
   * The settled run turn rendered on this bubble's footer line (round 9):
   * replaces the plain timestamp with "2:34 PM · ✓ Worked · 38s · 3 tools"
   * (the timestamp leads the summary), expandable to the nested tool history.
   * Supplied by TaskChatThreadView when `item.attachedTurn` is set.
   */
  attachedTurn?: ReactNode;
  /** New-runner Worked header, rendered above the durable final response. */
  beforeTurn?: ReactNode;
  /** The durable runner turn already owns the shared agent identity row. */
  hideAgentIdentity?: boolean;
  /**
   * copy · 👍 · 👎 controls for an agent bubble's footer line (PAP-413).
   * Rendered here only for a runless reply (leading the bare timestamp); when
   * an attached turn is present it owns these via its `leading` slot instead,
   * so this bubble skips them. Human/system bubbles pass nothing.
   */
  actions?: ReactNode;
  attachments?: IssueAttachment[];
}

function initialsForName(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function TaskChatAgentIdentity({
  agentName,
  agentIcon,
  onBehalfOfUserName,
}: {
  agentName: string;
  agentIcon?: string | null;
  onBehalfOfUserName?: string;
}) {
  return (
    <span
      className="flex items-center gap-2 px-1"
      data-testid="task-chat-agent-identity"
    >
      <Avatar
        size="sm"
        className="shrink-0"
        data-testid="task-chat-agent-avatar"
      >
        {agentIcon ? (
          <AvatarFallback>
            <AgentIcon icon={agentIcon} className="h-3.5 w-3.5" />
          </AvatarFallback>
        ) : (
          <AvatarFallback>{initialsForName(agentName)}</AvatarFallback>
        )}
      </Avatar>
      <span className="text-sm font-semibold text-foreground">{agentName}</span>
      {onBehalfOfUserName ? (
        <CommentAttributionChip
          agentName={agentName}
          userName={onBehalfOfUserName}
        />
      ) : null}
    </span>
  );
}

/**
 * Author-typed message row — the primary legibility signal. Human messages sit
 * right in a solid accent bubble; agent messages sit directly on the page
 * surface with an avatar author header (the agent's assigned icon + name);
 * system notices are centered and recede.
 */
function galleryItemForImage(
  src: string,
  name?: string,
  attachment?: ReturnType<typeof hydrateAttachmentRefs>[number],
): GalleryMediaItem {
  return {
    id: attachment?.id ?? src,
    contentPath: attachment?.openPath ?? src,
    openPath: attachment?.openPath,
    downloadPath: attachment?.downloadPath,
    contentType: attachment?.contentType ?? "",
    originalFilename: name?.trim() ? name : "image",
  };
}

export function TaskChatBubble({
  item,
  animateEntry = true,
  queuedAction,
  attachedTurn,
  beforeTurn,
  hideAgentIdentity = false,
  actions,
  attachments = [],
  onTryAgainNoLiveExecutionPath,
  tryAgainNoLiveExecutionPathPending,
}: TaskChatBubbleProps) {
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
    return (
      <TaskChatSystemNotice
        item={item}
        onTryAgainNoLiveExecutionPath={onTryAgainNoLiveExecutionPath}
        tryAgainNoLiveExecutionPathPending={tryAgainNoLiveExecutionPathPending}
      />
    );
  }

  const isHuman = item.author === "human";
  // Non-image file references ("[name](/api/attachments/…/content)") render as
  // attachment chips under the bubble; link-only lines leave the body text.
  const { refs: linkedRefs, text: bodyWithoutAttachmentLinks } =
    extractAttachmentRefs(item.text);
  const embeddedImageRefs = extractImageRefs(bodyWithoutAttachmentLinks);
  const bodyText = stripStandaloneImageEmbeds(bodyWithoutAttachmentLinks);
  const hydratedLinkedRefs = hydrateAttachmentRefs(linkedRefs, attachments);
  const hydratedEmbeddedRefs = hydrateAttachmentRefs(
    embeddedImageRefs,
    attachments,
  );
  const imageRefs = [
    ...hydratedEmbeddedRefs,
    ...hydratedLinkedRefs.filter(isImageAttachment),
  ].filter((ref, index, refs) =>
    refs.findIndex((candidate) => candidate.url === ref.url) === index,
  );
  const attachmentRefs = hydratedLinkedRefs.filter(
    (ref) => !isImageAttachment(ref),
  );
  const galleryItems: GalleryMediaItem[] =
    lightboxSrc !== null && !imageRefs.some((ref) => ref.url === lightboxSrc)
      ? // A clicked image the extractor missed (e.g. inline HTML) still gets a
        // single-item lightbox rather than nothing.
        [galleryItemForImage(lightboxSrc)]
      : imageRefs.map((ref) => galleryItemForImage(ref.url, ref.name, ref));
  const lightboxIndex =
    lightboxSrc === null
      ? -1
      : Math.max(0, imageRefs.findIndex((ref) => ref.url === lightboxSrc));
  return (
    <div
      className={cn(
        "flex w-full flex-col gap-1",
        animateEntry && "tc-enter-bubble",
        isHuman ? "items-end" : "items-start",
      )}
    >
      {beforeTurn ? <div className="w-full pb-1">{beforeTurn}</div> : null}
      {!isHuman && item.authorName && !hideAgentIdentity ? (
        <TaskChatAgentIdentity
          agentName={item.authorName}
          agentIcon={item.agentIcon}
          onBehalfOfUserName={item.onBehalfOfUserName}
        />
      ) : null}
      {bodyText.length > 0 ? (
        <div
          // Stable hook so the TaskChatLab bubble-treatment explorations
          // (PAP-501) can scope background/border overrides to the agent
          // bubble body without touching the live thread.
          data-testid={
            isHuman ? "task-chat-human-bubble" : "task-chat-agent-bubble"
          }
          className={cn(
            "break-words py-2 text-sm",
            isHuman
              ? "max-w-(--pct-85) rounded-2xl rounded-br-sm bg-(--liveness-blue) px-3.5 text-white"
              : "w-full bg-transparent px-1 text-foreground",
          )}
        >
          <MarkdownBody
            // The human bubble sits on the solid --liveness-blue accent, so the
            // prose body text must follow the bubble's `text-white` rather than
            // the default light-mode prose color (which reads as black on blue).
            // `paperclip-markdown-on-accent` flips prose tokens to currentColor
            // (== inherited white) in both themes; dark mode was already correct
            // only because `prose-invert` happened to lighten the text.
            className={isHuman ? "paperclip-markdown-on-accent" : undefined}
            softBreaks
            linkIssueReferences
            onImageClick={setLightboxSrc}
          >
            {bodyText}
          </MarkdownBody>
        </div>
      ) : null}
      {imageRefs.length > 0 ? (
        <div
          className="flex max-w-(--pct-85) flex-col gap-2"
          data-testid="task-chat-bubble-media"
        >
          <span className="text-xs text-muted-foreground">
            Screenshots · {imageRefs.length}
          </span>
          <div className="grid grid-cols-4 gap-2">
            {imageRefs
              .slice(0, imageRefs.length > 4 ? 3 : 4)
              .map((ref, index) => (
                <button
                  key={ref.url}
                  type="button"
                  className="group aspect-video min-w-0 overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Open ${ref.name || `image ${index + 1}`}`}
                  onClick={() => setLightboxSrc(ref.url)}
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
                onClick={() => setLightboxSrc(imageRefs[3].url)}
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
          <span className="text-xs text-muted-foreground">
            Files · {attachmentRefs.length}
          </span>
          <AttachmentGroup data-testid="task-chat-bubble-attachments">
            {attachmentRefs.map((ref) => {
              const kind = fileKindForAttachment(ref);
              const KindIcon = kind.icon;
              const size = formatFileSize(ref.byteSize);
              return (
                <Attachment key={ref.url} size="sm">
                  <AttachmentMedia>
                    <KindIcon aria-hidden />
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle className="max-w-48">
                      {ref.name}
                    </AttachmentTitle>
                    <AttachmentDescription className="max-w-48">
                      {size ? `${kind.label} · ${size}` : kind.label}
                    </AttachmentDescription>
                  </AttachmentContent>
                  <AttachmentTrigger
                    aria-label={`Open ${ref.name}`}
                    render={
                      <a
                        href={ref.openPath ?? ref.url}
                        target="_blank"
                        rel="noreferrer"
                      />
                    }
                  />
                </Attachment>
              );
            })}
          </AttachmentGroup>
        </div>
      ) : null}
      {!isHuman && item.verificationCaveats?.length ? (
        <div
          className="mx-1 w-(--sz-calc-7) rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs"
          data-testid="task-chat-verification-caveats"
        >
          <p className="font-medium text-amber-800 dark:text-amber-200">
            Verification caveat
          </p>
          <ul className="mt-1 space-y-1 text-muted-foreground">
            {item.verificationCaveats.map((caveat, index) => (
              <li key={`${caveat.commandOrCheck}:${index}`}>
                <span className="font-mono text-foreground">
                  {caveat.commandOrCheck}
                </span>
                {caveat.reasonCode
                  ? ` · ${caveat.reasonCode.replaceAll("_", " ")}`
                  : ""}
                {caveat.detail ? (
                  <span className="block">{caveat.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
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
        <div
          className="self-stretch"
          data-testid="task-chat-bubble-attached-turn"
        >
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
