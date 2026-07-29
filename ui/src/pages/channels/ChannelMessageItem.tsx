import { Bot, CheckCircle2, CircleHelp, FileText, Link2, MessageSquare, StickyNote, Terminal, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";
import type { ChannelCardKind, ChannelMessage, ChannelWorkMode } from "@/api/channels";

export const CHANNEL_WORK_MODE_OPTIONS: Array<{
  mode: ChannelWorkMode;
  label: string;
  hint: string;
}> = [
  { mode: "ask", label: "Ask", hint: "Get an answer without starting work" },
  { mode: "plan", label: "Plan", hint: "Draft a plan before anyone executes" },
  { mode: "work", label: "Work", hint: "Start a task and assign it" },
];

/** Maps a channel work mode onto the shared composer tones. */
export function composerToneForMode(mode: ChannelWorkMode): "standard" | "ask" | "planning" {
  if (mode === "ask") return "ask";
  if (mode === "plan") return "planning";
  return "standard";
}

const COMPLETED_ISSUE_STATUSES = new Set(["done", "cancelled"]);

export function isCompletedRoot(message: ChannelMessage): boolean {
  return !!message.issueStatus && COMPLETED_ISSUE_STATUSES.has(message.issueStatus);
}

/** Freeform roots are allowed but demoted: they carry no task of their own. */
export function isFreeformRoot(message: ChannelMessage): boolean {
  return !message.issueId;
}

function authorLabel(message: ChannelMessage): string {
  if (message.authorName) return message.authorName;
  if (message.authorType === "system") return "System";
  if (message.authorType === "agent") return "Agent";
  return "You";
}

function AuthorGlyph({ message }: { message: ChannelMessage }) {
  const Icon =
    message.authorType === "agent" ? Bot : message.authorType === "system" ? Terminal : User;
  return (
    <span
      className={cn(
        "grid h-6 w-6 shrink-0 place-items-center rounded-full border border-border",
        message.authorType === "agent" ? "bg-accent text-foreground" : "bg-muted text-muted-foreground",
      )}
      aria-hidden="true"
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

export function WorkModeChip({ mode }: { mode: ChannelWorkMode }) {
  const label = CHANNEL_WORK_MODE_OPTIONS.find((option) => option.mode === mode)?.label ?? mode;
  return (
    <Badge
      variant="ghost"
      className={cn(
        "px-1.5 text-(length:--text-nano) leading-none",
        mode === "ask" && "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300",
        mode === "plan" && "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
        mode === "work" && "bg-muted text-muted-foreground",
      )}
    >
      {label}
    </Badge>
  );
}

function hitlCardMeta(kind: ChannelCardKind | null): {
  label: string;
  Icon: typeof CircleHelp;
} | null {
  if (kind === "questions") return { label: "Questions", Icon: CircleHelp };
  if (kind === "confirmation") return { label: "Confirmation", Icon: CheckCircle2 };
  if (kind === "document") return { label: "Document", Icon: FileText };
  if (kind === "approval") return { label: "Approval", Icon: CheckCircle2 };
  if (kind === "suggest_tasks") return { label: "Suggested tasks", Icon: StickyNote };
  if (kind === "stub") return { label: "Link", Icon: Link2 };
  return null;
}

interface ChannelMessageItemProps {
  message: ChannelMessage;
  /** Root rows are clickable timeline entries; replies are plain thread lines. */
  variant: "root" | "reply";
  selected?: boolean;
  onOpenThread?: (message: ChannelMessage) => void;
}

export function ChannelMessageItem({
  message,
  variant,
  selected = false,
  onOpenThread,
}: ChannelMessageItemProps) {
  const completed = variant === "root" && isCompletedRoot(message);
  const freeform = variant === "root" && isFreeformRoot(message);
  const hitl = hitlCardMeta(message.cardKind);
  const HitlIcon = hitl?.Icon;

  const body = (
    <div className="flex min-w-0 gap-2.5">
      <AuthorGlyph message={message} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-foreground">{authorLabel(message)}</span>
          <span className="text-(length:--text-micro) text-muted-foreground">
            {timeAgo(message.createdAt)}
          </span>
          {message.channelWorkMode ? <WorkModeChip mode={message.channelWorkMode} /> : null}
          {message.issueIdentifier ? (
            <Badge variant="outline" className="px-1.5 text-(length:--text-nano) leading-none">
              {message.issueIdentifier}
            </Badge>
          ) : null}
          {hitl && HitlIcon ? (
            <Badge
              variant="ghost"
              className="gap-1 bg-muted px-1.5 text-(length:--text-nano) leading-none text-muted-foreground"
            >
              <HitlIcon className="h-3 w-3" />
              {hitl.label}
            </Badge>
          ) : null}
          {freeform ? (
            <Badge
              variant="ghost"
              className="gap-1 bg-muted px-1.5 text-(length:--text-nano) leading-none text-muted-foreground"
            >
              <StickyNote className="h-3 w-3" />
              Note
            </Badge>
          ) : null}
          {completed ? (
            <span className="inline-flex items-center gap-1 text-(length:--text-micro) text-muted-foreground">
              <CheckCircle2 className="h-3 w-3" />
              Completed
            </span>
          ) : null}
        </div>

        {message.issueTitle ? (
          <p className="mt-0.5 truncate text-sm font-medium text-foreground">{message.issueTitle}</p>
        ) : null}

        <p
          className={cn(
            "mt-0.5 whitespace-pre-wrap break-words text-sm leading-6",
            completed || freeform || hitl ? "text-muted-foreground" : "text-foreground",
            hitl && "rounded-md border border-border/70 bg-muted/40 px-2.5 py-2",
          )}
        >
          {message.body}
        </p>

        {variant === "root" && message.replyCount > 0 ? (
          <span className="mt-1.5 inline-flex items-center gap-1.5 text-(length:--text-micro) font-medium text-muted-foreground">
            <MessageSquare className="h-3 w-3" />
            {message.replyCount} {message.replyCount === 1 ? "update" : "updates"}
            {message.lastReplyAt ? ` · ${timeAgo(message.lastReplyAt)}` : ""}
          </span>
        ) : null}
      </div>
    </div>
  );

  if (variant === "reply") {
    return <div className="px-4 py-2.5">{body}</div>;
  }

  return (
    <button
      type="button"
      data-testid="channel-root-message"
      onClick={() => onOpenThread?.(message)}
      className={cn(
        "w-full rounded-lg border px-3 py-2.5 text-left transition-colors",
        selected ? "border-border bg-accent" : "border-transparent hover:bg-accent/50",
        completed && "opacity-70",
      )}
    >
      {body}
    </button>
  );
}
