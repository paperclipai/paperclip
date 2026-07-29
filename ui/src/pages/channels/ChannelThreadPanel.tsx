import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MessagesSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChatComposer, type ChatComposerHandle } from "@/components/ChatComposer";
import { channelsApi, type ChannelWorkMode } from "@/api/channels";
import { queryKeys } from "@/lib/queryKeys";
import { ChannelMessageItem } from "./ChannelMessageItem";

interface ChannelThreadPanelProps {
  channelId: string;
  rootId: string;
  /** Kept in sync with the channel timeline so the roots list refreshes on reply. */
  includeCompleted: boolean;
  onClose: () => void;
}

/**
 * Slack-style thread for one task root: the root message plus every update
 * (agent progress, HITL, human replies) and a reply composer.
 */
export function ChannelThreadPanel({
  channelId,
  rootId,
  includeCompleted,
  onClose,
}: ChannelThreadPanelProps) {
  const queryClient = useQueryClient();
  const composerRef = useRef<ChatComposerHandle>(null);
  const [reply, setReply] = useState("");

  const threadQueryKey = queryKeys.channels.thread(channelId, rootId);
  const { data: thread, isLoading, error } = useQuery({
    queryKey: threadQueryKey,
    queryFn: () => channelsApi.listThread(channelId, rootId),
  });

  const postReply = useMutation({
    mutationFn: (body: string) =>
      channelsApi.postMessage(channelId, {
        body,
        threadRootId: rootId,
        // Replies inherit the root's mode; the toggle lives on the channel composer.
        channelWorkMode: (thread?.root?.channelWorkMode ?? "ask") as ChannelWorkMode,
      }),
    onSuccess: () => {
      setReply("");
      void queryClient.invalidateQueries({ queryKey: threadQueryKey });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channels.messages(channelId, includeCompleted),
      });
      composerRef.current?.focus();
    },
  });

  const root = thread?.root ?? null;
  const replies = thread?.messages ?? [];

  return (
    <aside
      data-testid="channel-thread-panel"
      className="flex h-full min-h-0 w-full flex-col border-l border-border bg-background"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">Thread</h2>
          <p className="truncate text-(length:--text-micro) text-muted-foreground">
            {root?.issueIdentifier ?? "Updates on this task"}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label="Close thread"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : error ? (
          <p className="px-4 py-6 text-sm text-destructive">
            Could not load this thread. {(error as Error).message}
          </p>
        ) : (
          <>
            {root ? (
              <div className="border-b border-border px-1 py-2">
                <ChannelMessageItem message={root} variant="reply" />
              </div>
            ) : null}
            {replies.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <MessagesSquare className="h-6 w-6 text-muted-foreground/60" />
                <p className="text-sm text-muted-foreground">No updates yet.</p>
              </div>
            ) : (
              <div className="divide-y divide-border/60">
                {replies.map((message) => (
                  <ChannelMessageItem key={message.id} message={message} variant="reply" />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-border p-3">
        {postReply.error ? (
          <p className="mb-2 text-(length:--text-micro) text-destructive">
            {(postReply.error as Error).message}
          </p>
        ) : null}
        <ChatComposer
          ref={composerRef}
          value={reply}
          onChange={setReply}
          onSubmit={() => postReply.mutate(reply.trim())}
          submitting={postReply.isPending}
          placeholder="Reply to this thread…"
          sendLabel="Send reply"
        />
      </div>
    </aside>
  );
}
