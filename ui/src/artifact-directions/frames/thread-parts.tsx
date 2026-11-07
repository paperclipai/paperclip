import type { ReactNode } from "react";
import { ArrowUp, AtSign, Check, ChevronDown, ChevronRight, Copy, Plus, ThumbsDown, ThumbsUp } from "lucide-react";
import { StatusIcon } from "@/components/StatusIcon";
import { AVATARS, DESIGNER } from "../fixtures";

/**
 * Static mirrors of the thread's own furniture. None of these are artifact
 * designs — they are the surroundings a kit's rows are judged against, so each
 * keeps the product's class strings (cited) and drops only behaviour.
 */

/** TaskChatBubble.tsx:77-95. The avatar is a hand-drawn stand-in: the real one is rendered by the server. */
export function AgentIdentity({ name }: { name: string }) {
  return (
    <span className="flex items-center gap-2 px-1">
      <span className="relative inline-flex size-6 shrink-0 items-center justify-center align-middle">
        <img src={AVATARS[name]} alt="" width={24} height={24} className="size-full object-contain" />
      </span>
      <span className="text-sm font-semibold text-foreground">{name}</span>
    </span>
  );
}

/** TaskChatBubble.tsx:217-263 body + MarkdownBody.tsx:956 root, so index.css's `.paperclip-markdown` rules apply. */
export function Prose({ children }: { children: ReactNode }) {
  return (
    <div className="break-words py-2 text-sm w-full bg-transparent px-1 text-foreground">
      <div className="paperclip-markdown prose prose-sm min-w-0 max-w-full break-words overflow-hidden">{children}</div>
    </div>
  );
}

/** A same-origin prose link (MarkdownBody.tsx:828-927 fallthrough): colour and underline come from index.css:2179-2221. */
export function ProseLink({ to, children }: { to: string; children: ReactNode }) {
  return <a href={`#${to}`}>{children}</a>;
}

/** MarkdownBody.tsx:141-146. */
export function TaskRef({ identifier, status }: { identifier: string; status: string }) {
  return (
    <a href={`#${identifier}`} className="paperclip-markdown-issue-ref font-normal underline">
      <StatusIcon status={status} size="md" className="relative -top-px mr-1 inline-block h-4 w-4 align-middle" />
      {identifier}
    </a>
  );
}

/** index.css:2329-2351 (`a.paperclip-mention-chip`). */
export function Mention({ name }: { name: string }) {
  return (
    <a href={`#agent-${name}`} className="paperclip-mention-chip">
      <AtSign className="h-3 w-3" aria-hidden />
      {name}
    </a>
  );
}

// TaskChatBubbleActions.tsx:40-66 (copy) + the feedback pair it renders beside it.
const ACTION = "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

/** TaskChatBubble.tsx:396-404, streamlined runless footer. */
export function MessageFooter({ timestamp }: { timestamp: string }) {
  return (
    <div className="flex w-full items-center justify-between gap-2 px-1">
      <span className="text-(length:--text-micro) text-muted-foreground">{timestamp}</span>
      <div className="flex items-center gap-0.5">
        <button type="button" className={ACTION} aria-label="Copy message">
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={ACTION} aria-label="Good response">
          <ThumbsUp className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={ACTION} aria-label="Bad response">
          <ThumbsDown className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** TaskChatTurn.tsx:184-237, settled standalone turn: "✓ Worked ›". */
export function WorkedRow() {
  return (
    <button type="button" aria-expanded={false} className="group flex w-full items-center gap-2 px-1 text-muted-foreground transition-colors hover:text-foreground py-0.5 text-xs min-w-0">
      <Check className="h-3.5 w-3.5 shrink-0" />
      <span>Worked</span>
      <ChevronRight className="h-3 w-3 shrink-0 transition-transform" aria-hidden />
    </button>
  );
}

/** TaskChatComposerDock.tsx:14-25 + TaskChatComposer.tsx:1184-1189, 1292-1296, 1371-1545. Not sticky here: the frame does not scroll. */
export function ComposerShell() {
  return (
    <div className="mx-auto mt-6 flex w-full max-w-(--tc-shell-max-w) flex-col gap-2 px-1 pb-1 md:px-0 md:pb-0">
      <div className="paperclip-task-chat-composer rounded-(--radius-task-composer) border border-border bg-card p-(--sz-18px) shadow-(--shadow-task-composer) dark:border-0 dark:bg-muted dark:shadow-none">
        <div className="min-h-(--sz-48px) px-1 py-1 text-sm text-muted-foreground">
          Message {DESIGNER} — describe what you want done…
        </div>
        <div className="mt-2 flex items-center gap-x-2 gap-y-3 flex-wrap">
          <span className="flex size-8 items-center justify-center rounded-md text-muted-foreground">
            <Plus className="size-4" />
          </span>
          <div className="ml-auto flex items-center gap-2">
            <span className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground">
              Uses defaults
              <ChevronDown className="h-3 w-3" />
            </span>
            <span className="flex size-8 items-center justify-center rounded-full bg-foreground text-background">
              <ArrowUp className="h-4 w-4" />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
