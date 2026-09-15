import { useState } from "react";
import { Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { FoldCurtain } from "@/components/FoldCurtain";
import { InlineEditor } from "@/components/InlineEditor";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "@/components/MarkdownBody";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AgentIcon } from "@/components/AgentIconPicker";
import type { MentionOption } from "@/components/MarkdownEditor";
import { formatTaskChatTimestamp } from "./task-chat-adapter";

/**
 * Host binding for the description-as-first-bubble (PAP-375): the LIVE issue
 * description plus everything the edit surface needs. Carried on the shared
 * thread props (`issueBrief`); only the redesigned TaskChatThread consumes it.
 */
export interface TaskChatIssueBrief {
  /** LIVE issue.description (never a frozen copy) — empty string when unset. */
  description: string;
  /** Originating actor: human-created → blue user bubble, agent-created → agent-side bubble. */
  author: "human" | "agent";
  /** Creating agent's name, shown in the agent-side avatar header. */
  authorName?: string;
  /** Creating agent's assigned icon (AgentIconName) for the avatar header. */
  agentIcon?: string | null;
  /** issue.createdAt — rendered like the other bubbles' footer timestamps. */
  createdAt?: string | Date;
  onSave: (description: string) => void | Promise<unknown>;
  mentions?: MentionOption[];
  externalReferences?: MarkdownExternalReferenceMap;
  imageUploadHandler?: (file: File) => Promise<string>;
  onDropFile?: (file: File) => Promise<void>;
}

interface TaskChatDescriptionBubbleProps {
  brief: TaskChatIssueBrief;
}

/** ~12 text-sm lines (20px line-height) — the accepted fold default (PAP-375). */
const FOLD_COLLAPSED_HEIGHT_PX = 240;

function initialsForName(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/**
 * The task description as the requester's first chat bubble (PAP-375):
 * human-created tasks get the blue user bubble, agent-created tasks the
 * agent-side card with the avatar header — same chrome as TaskChatBubble. The
 * body is the live issue.description. Human-authored blue bubbles are
 * presentation-only; agent-authored descriptions retain the hover edit
 * affordance. Long descriptions fold at ~12 lines behind a Show more curtain;
 * an empty description renders a muted ghost row that opens the editor — never
 * an empty bubble.
 */
export function TaskChatDescriptionBubble({ brief }: TaskChatDescriptionBubbleProps) {
  const [editing, setEditing] = useState(false);
  const isHuman = brief.author === "human";
  const hasDescription = brief.description.trim().length > 0;

  if (editing) {
    return (
      <div
        className="tc-enter-bubble w-full rounded-lg border border-border bg-card px-2 py-1"
        data-testid="task-chat-description-editor"
      >
        <InlineEditor
          value={brief.description}
          onSave={brief.onSave}
          as="p"
          className="text-sm leading-7 text-foreground"
          placeholder="Add a description..."
          multiline
          defaultEditing
          onEditingChange={(next) => {
            if (!next) setEditing(false);
          }}
          mentions={brief.mentions}
          externalReferences={brief.externalReferences}
          imageUploadHandler={brief.imageUploadHandler}
          onDropFile={brief.onDropFile}
        />
      </div>
    );
  }

  if (!hasDescription) {
    // Accepted default: no fabricated empty bubble — a muted ghost affordance.
    return (
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1.5 text-left text-sm text-muted-foreground/70 transition-colors hover:bg-accent/20 hover:text-muted-foreground"
        onClick={() => setEditing(true)}
        data-testid="task-chat-description-ghost"
      >
        <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Add a description...
      </button>
    );
  }

  const timestamp = formatTaskChatTimestamp(brief.createdAt);
  return (
    <div
      className={cn(
        "tc-enter-bubble group/brief flex w-full flex-col gap-1",
        isHuman ? "items-end" : "items-start",
      )}
      data-testid="task-chat-description-bubble"
      data-author={brief.author}
    >
      {!isHuman && brief.authorName ? (
        <span className="flex items-center gap-2 px-1">
          <Avatar size="sm" className="shrink-0" data-testid="task-chat-agent-avatar">
            {brief.agentIcon ? (
              <AvatarFallback>
                <AgentIcon icon={brief.agentIcon} className="h-3.5 w-3.5" />
              </AvatarFallback>
            ) : (
              <AvatarFallback>{initialsForName(brief.authorName)}</AvatarFallback>
            )}
          </Avatar>
          <span className="text-sm font-semibold text-foreground">{brief.authorName}</span>
        </span>
      ) : null}
      <div
        className={cn(
          "flex w-full items-start gap-1.5",
          isHuman ? "flex-row-reverse" : "flex-row",
        )}
      >
        <div
          className={cn(
            "max-w-(--pct-85) break-words px-3.5 py-2 text-sm",
            isHuman
              ? "rounded-2xl rounded-br-sm bg-(--liveness-blue) text-white"
              : "rounded-2xl rounded-bl-sm bg-(--bubble-agent) text-foreground",
          )}
        >
          <FoldCurtain
            collapsedHeight={FOLD_COLLAPSED_HEIGHT_PX}
            // The curtain's fade is a mask (background-agnostic); only the
            // toggle's muted colors need a lift on the solid blue bubble.
            toggleClassName={isHuman ? "text-white/80 hover:text-white hover:bg-white/10" : undefined}
          >
            <MarkdownBody
              // On the solid --liveness-blue human bubble, keep prose body text
              // following the bubble's `text-white` in both themes.
              className={isHuman ? "paperclip-markdown-on-accent" : undefined}
              softBreaks
              linkIssueReferences
              externalReferences={brief.externalReferences}
            >
              {brief.description}
            </MarkdownBody>
          </FoldCurtain>
        </div>
        {!isHuman ? (
          <button
            type="button"
            className="mt-1 shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent/50 hover:text-foreground focus-visible:opacity-100 group-hover/brief:opacity-100"
            onClick={() => setEditing(true)}
            aria-label="Edit description"
            data-testid="task-chat-description-edit"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      {timestamp ? (
        <span className="px-1 text-(length:--text-micro) text-muted-foreground">{timestamp}</span>
      ) : null}
    </div>
  );
}
