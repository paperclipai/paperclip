import { useEffect, useRef, useState } from "react";
import { ArrowDown, Download, FileText, MessageSquare } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "./MarkdownBody";
import { ClippyToolCallCard } from "./ClippyToolCallCard";
import { ClippyPermissionCard } from "./ClippyPermissionCard";
import type { ClippyTranscriptEntry } from "../hooks/useChatSession";
import type { ChatContentBlock } from "../api/chat";

interface Props {
  transcript: ClippyTranscriptEntry[];
  pendingPermissions: { toolUseId: string; name: string; input: unknown }[];
  onPermissionDecision: (toolUseId: string, decision: "approve" | "deny") => void;
  streaming: boolean;
}

export function ClippyMessageList({
  transcript,
  pendingPermissions,
  onPermissionDecision,
  streaming,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (stickToBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [transcript, pendingPermissions]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const node = e.currentTarget;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    const atBottom = distanceFromBottom < 24;
    stickToBottomRef.current = atBottom;
    setShowJump(!atBottom);
  };

  const jumpToLatest = () => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    stickToBottomRef.current = true;
    setShowJump(false);
  };

  const toolResultsByUseId = new Map<string, ChatContentBlock & { type: "tool_result" }>();
  for (const entry of transcript) {
    if (entry.role !== "tool") continue;
    for (const block of entry.blocks) {
      if (block.type === "tool_result") {
        toolResultsByUseId.set(block.tool_use_id, block);
      }
    }
  }

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="absolute inset-0 overflow-y-auto px-4 py-4 scrollbar-auto-hide"
      >
        {transcript.length === 0 && !streaming && (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
            <MessageSquare className="mb-2 h-8 w-8 opacity-40" />
            <div className="font-medium">Ask Clippy anything</div>
            <div className="mt-1 max-w-sm text-xs">
              Switch to <span className="font-medium">Agent</span> mode to let Clippy run tools and
              make changes for you.
            </div>
          </div>
        )}
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {transcript.map((entry) => {
            if (entry.role === "tool") return null;
            return (
              <MessageBubble
                key={entry.id}
                role={entry.role}
                blocks={entry.blocks}
                pending={entry.pending}
                toolResults={toolResultsByUseId}
                pendingPermissions={pendingPermissions}
                onPermissionDecision={onPermissionDecision}
              />
            );
          })}
          {streaming &&
            transcript.length > 0 &&
            transcript[transcript.length - 1].role !== "assistant" && (
              <div className="text-xs text-muted-foreground">Clippy is thinking…</div>
            )}
        </div>
      </div>
      {showJump && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-3 left-1/2 -translate-x-1/2"
          onClick={jumpToLatest}
        >
          <ArrowDown className="mr-1 h-3 w-3" /> Jump to latest
        </Button>
      )}
    </div>
  );
}

function MessageBubble({
  role,
  blocks,
  pending,
  toolResults,
  pendingPermissions,
  onPermissionDecision,
}: {
  role: "user" | "assistant";
  blocks: ChatContentBlock[];
  pending?: boolean;
  toolResults: Map<string, ChatContentBlock & { type: "tool_result" }>;
  pendingPermissions: { toolUseId: string; name: string; input: unknown }[];
  onPermissionDecision: (toolUseId: string, decision: "approve" | "deny") => void;
}) {
  const isUser = role === "user";
  const text = blocks
    .filter((b): b is ChatContentBlock & { type: "text" } => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
  const toolUses = blocks.filter(
    (b): b is ChatContentBlock & { type: "tool_use" } => b.type === "tool_use",
  );
  const images = blocks.filter(
    (b): b is ChatContentBlock & { type: "image" } => b.type === "image",
  );
  const files = blocks.filter(
    (b): b is ChatContentBlock & { type: "file" } => b.type === "file",
  );

  return (
    <div className={cn("flex flex-col", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2 text-sm",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted/50 text-foreground",
        )}
      >
        {(images.length > 0 || files.length > 0) && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((img) => (
              <ImageAttachment key={img.attachmentId} block={img} />
            ))}
            {files.map((f) => (
              <FileAttachment key={f.attachmentId} block={f} onUserBubble={isUser} />
            ))}
          </div>
        )}
        {text && (
          isUser ? (
            // User messages render as plain text. MarkdownBody injects its own
            // typography colors that override our `text-primary-foreground`,
            // which made the bubble look like dark-on-dark in some themes.
            <p className="whitespace-pre-wrap break-words text-primary-foreground">
              {text}
            </p>
          ) : (
            <MarkdownBody className="[&_p]:my-1 [&_pre]:my-2">{text}</MarkdownBody>
          )
        )}
        {!text && pending && images.length === 0 && files.length === 0 && (
          <span className="text-xs text-muted-foreground">…</span>
        )}
        {!isUser && toolUses.length > 0 && (
          <div className="mt-1">
            {toolUses.map((block) => {
              const pendingPerm = pendingPermissions.find(
                (p) => p.toolUseId === block.id,
              );
              if (pendingPerm) {
                return (
                  <ClippyPermissionCard
                    key={block.id}
                    toolName={block.name}
                    input={block.input}
                    onApprove={() => onPermissionDecision(block.id, "approve")}
                    onDeny={() => onPermissionDecision(block.id, "deny")}
                  />
                );
              }
              const result = toolResults.get(block.id);
              return (
                <ClippyToolCallCard
                  key={block.id}
                  name={block.name}
                  input={block.input}
                  status={result ? "completed" : "pending"}
                  result={result ? { ok: !result.is_error, data: tryParse(result.content) } : undefined}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function ImageAttachment({
  block,
}: {
  block: ChatContentBlock & { type: "image" };
}) {
  return (
    <a
      href={block.url}
      target="_blank"
      rel="noreferrer"
      className="block overflow-hidden rounded-md border border-border bg-background"
      title={block.name}
    >
      <img
        src={block.url}
        alt={block.name}
        className="block max-h-72 max-w-[280px] object-contain"
        loading="lazy"
      />
    </a>
  );
}

function FileAttachment({
  block,
  onUserBubble,
}: {
  block: ChatContentBlock & { type: "file" };
  onUserBubble: boolean;
}) {
  return (
    <a
      href={block.url}
      target="_blank"
      rel="noreferrer"
      download={block.name}
      className={cn(
        "flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs",
        onUserBubble
          ? "border-primary-foreground/30 bg-primary/30 text-primary-foreground hover:bg-primary/40"
          : "border-border bg-background hover:bg-accent",
      )}
      title={`${block.name} · ${formatBytesShort(block.sizeBytes)}`}
    >
      <FileText className="h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 max-w-[200px]">
        <div className="truncate font-medium">{block.name}</div>
        <div className="truncate text-[10px] opacity-70">
          {block.mediaType} · {formatBytesShort(block.sizeBytes)}
        </div>
      </div>
      <Download className="h-3 w-3 shrink-0 opacity-60" />
    </a>
  );
}

function formatBytesShort(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

