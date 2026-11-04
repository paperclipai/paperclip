import { attachSettledTurns, buildTurnSummary, settledRunChildren, transcriptToTaskChatItems } from "../task-chat/transcript-adapter";
import type { TaskChatItem, TaskChatMessageItem, TaskChatTurnItem } from "../task-chat/task-chat-model";

/** Same history primitives as the production controller: the posted reply owns
 * its text and the settled transcript lives in the Activity footer. */
export function settledPreviewReply(response: TaskChatMessageItem, entries: Parameters<typeof transcriptToTaskChatItems>[0], runId: string, failed = false, durationMs = 74_000): TaskChatItem[] {
  const parsed = transcriptToTaskChatItems(entries, { runId, agentName: response.authorName, running: false });
  const turn: TaskChatTurnItem = {
    id: `${runId}:turn`, kind: "turn", settled: true, historical: true,
    items: settledRunChildren(parsed), summary: buildTurnSummary(entries, { durationMs, failed }),
  };
  return attachSettledTurns([response, turn], new Map([[turn.id, { agentKey: "synthetic-agent", agentName: response.authorName, parts: [{ entries, durationMs, failed }] }]]));
}
