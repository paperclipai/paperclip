import { useMemo } from "react";
import type { ThreadPreviewSnapshot } from "./task-thread-fixtures";
import { MarkdownWordStreaming } from "../MarkdownWordStreaming";
import { TaskChatThreadView } from "../task-chat/TaskChatThreadView";
import { TaskChatLiveTail } from "../task-chat/TaskChatLiveTail";
import { TaskChatLiveRunPill, toolCountSummaryFromEntries } from "../task-chat/TaskChatLiveRunPill";
import { TaskChatProtocolCard } from "../task-chat/TaskChatProtocolCard";
import { TaskChatTurnHandoff } from "../task-chat/TaskChatTurnHandoff";
import { TaskChatShimmerScope } from "../task-chat/TaskChatShimmer";
import { TaskChatBubbleActions } from "../task-chat/TaskChatBubbleActions";
import type { TaskChatItem, TaskChatMessageItem, TaskChatRuntimeRequestItem } from "../task-chat/task-chat-model";

/** Streaming and durable replies share one render key and the same bubble.
 * Only the activity region folds; the response moves with normal document flow. */
export function ConversationPlaybackTurn({ settled, snapshot, items, response, settledItems }: {
  settled: boolean;
  snapshot: ThreadPreviewSnapshot;
  items: TaskChatItem[];
  response: TaskChatMessageItem;
  settledItems: TaskChatItem[];
}) {
  const pending = items.find((item): item is TaskChatRuntimeRequestItem => item.kind === "protocol" && item.surface === "runtime_request" && item.status === "pending");
  const streamed = items.find((item): item is TaskChatMessageItem => item.kind === "message" && item.channel === "final");
  const liveReply = useMemo(() => streamed ? [{ ...response, text: streamed.text, timestamp: undefined, attachedTurn: undefined }] : [], [response, streamed]);
  const actions = (item: TaskChatMessageItem) => <TaskChatBubbleActions copyText={item.text} />;
  return <TaskChatTurnHandoff settled={settled} activity={settled ? null : <TaskChatShimmerScope items={items}>
    {!pending ? <TaskChatLiveRunPill status={snapshot.status} startedAtMs={null} toolSummary={toolCountSummaryFromEntries(snapshot.entries)} /> : null}
    <MarkdownWordStreaming.Provider value><TaskChatLiveTail items={items.filter(item => item !== pending)} excludeFinal emptyMessage={snapshot.emptyMessage} /></MarkdownWordStreaming.Provider>
    {pending ? <TaskChatProtocolCard key={pending.id} item={pending} presentation="takeover" /> : null}
  </TaskChatShimmerScope>}>
    {complete => <MarkdownWordStreaming.Provider value>
      <TaskChatThreadView scroll={false} className="p-0 md:p-0" items={complete ? settledItems : liveReply} renderMessageActions={complete ? actions : undefined} />
    </MarkdownWordStreaming.Provider>}
  </TaskChatTurnHandoff>;
}
