import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { Button } from "../ui/button";
import { TaskChatThreadView } from "../task-chat/TaskChatThreadView";
import { transcriptToTaskChatItems } from "../task-chat/transcript-adapter";
import { parseCssTimeMs } from "../task-chat/motion-tokens";
import type { TaskChatMessageItem } from "../task-chat/task-chat-model";
import { CONVERSATION_PLAYBACK_STAGES, conversationPlaybackSnapshot, previewHistory, SYNTHETIC_FINAL, PLAYBACK_FOLLOW_UP_STAGE, PLAYBACK_FOLLOW_UP, PLAYBACK_VERIFICATION_FINAL } from "./task-thread-fixtures";
import { ConversationPlaybackTurn } from "./ConversationPlaybackTurn";
import { settledPreviewReply } from "./settled-preview-reply";

/** A local clock feeds cumulative synthetic transcript snapshots into the real
 * conversation renderer. One thread persists throughout; no fixture carousel. */
export function ConversationPlayback({ header, agentName, agent, onShowSavedThread }: {
  header: ReactNode; agentName: string; agent?: Agent; onShowSavedThread?: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [stepMs, setStepMs] = useState(0);
  const tick = useRef(0);
  useEffect(() => {
    const styles = getComputedStyle(document.documentElement);
    setStepMs(parseCssTimeMs(styles.getPropertyValue("--motion-sandbox-playback-step")));
    tick.current = parseCssTimeMs(styles.getPropertyValue("--motion-sandbox-stream-tick"));
  }, []);
  const duration = CONVERSATION_PLAYBACK_STAGES.reduce((sum, stage) => sum + stage.units * stepMs, 0);
  const ended = started && duration > 0 && elapsed >= duration;
  useEffect(() => {
    if (!playing || !stepMs || !tick.current) return;
    const timer = window.setInterval(() => setElapsed(value => Math.min(duration, value + tick.current)), tick.current);
    return () => window.clearInterval(timer);
  }, [playing, stepMs, duration]);
  useEffect(() => { if (ended) setPlaying(false); }, [ended]);
  let offset = 0;
  let stage = 0;
  for (const current of CONVERSATION_PLAYBACK_STAGES) {
    if (elapsed < offset + current.units * stepMs) break;
    offset += current.units * stepMs;
    stage++;
  }
  const progress = stepMs && stage < CONVERSATION_PLAYBACK_STAGES.length ? (elapsed - offset) / (CONVERSATION_PLAYBACK_STAGES[stage].units * stepMs) : 1;
  const snapshot = useMemo(() => conversationPlaybackSnapshot(stage, progress), [stage, progress]);
  const parsed = useMemo(() => transcriptToTaskChatItems(snapshot.entries, { runId: "conversation-playback", agentName, running: !ended }), [snapshot, agentName, ended]);
  const human = useMemo(() => previewHistory(agentName).human, [agentName]);
  const followUp = stage >= PLAYBACK_FOLLOW_UP_STAGE;
  const firstSnapshot = useMemo(() => followUp ? conversationPlaybackSnapshot(6, 1) : snapshot, [followUp, snapshot]);
  const firstItems = useMemo(() => followUp ? transcriptToTaskChatItems(firstSnapshot.entries, { runId: "playback-count", agentName, running: false }) : parsed, [followUp, firstSnapshot, parsed, agentName]);
  const firstResponse = useMemo((): TaskChatMessageItem => ({ id: "playback-response", kind: "message", author: "agent", authorName: agentName, agent, channel: "final", text: SYNTHETIC_FINAL, timestamp: "10:11 AM" }), [agentName, agent]);
  const secondResponse = useMemo((): TaskChatMessageItem => ({ id: "playback-verification", kind: "message", author: "agent", authorName: agentName, agent, channel: "final", text: PLAYBACK_VERIFICATION_FINAL, timestamp: "10:13 AM" }), [agentName, agent]);
  const firstSettled = useMemo(() => settledPreviewReply(firstResponse, conversationPlaybackSnapshot(6, 1).entries, "playback-count", false, CONVERSATION_PLAYBACK_STAGES.slice(0, PLAYBACK_FOLLOW_UP_STAGE).reduce((sum, item) => sum + item.units * stepMs, 0)), [firstResponse, stepMs]);
  const secondSettled = useMemo(() => ended ? settledPreviewReply(secondResponse, snapshot.entries, "conversation-playback", false, CONVERSATION_PLAYBACK_STAGES.slice(PLAYBACK_FOLLOW_UP_STAGE).reduce((sum, item) => sum + item.units * stepMs, 0)) : [], [ended, secondResponse, snapshot.entries, stepMs]);
  const followUpMessage = useMemo((): TaskChatMessageItem[] => [{ id: "playback-follow-up", kind: "message", author: "human", isCurrentUser: true, text: PLAYBACK_FOLLOW_UP, timestamp: "10:12 AM" }], []);
  const restart = () => { setElapsed(0); setGeneration(value => value + 1); setStarted(true); setPlaying(true); };

  return <section className="flex min-h-0 flex-1 flex-col" data-testid="conversation-playback" data-playback-state={ended ? "complete" : playing ? "playing" : started ? "paused" : "idle"} data-playback-stage={stage}>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background py-2 text-xs">
      <Button size="sm" variant="outline" disabled={!stepMs} onClick={() => !started || ended ? restart() : setPlaying(value => !value)}>
        {ended ? <RotateCcw /> : playing ? <Pause /> : <Play />}
        {ended ? "Replay conversation" : playing ? "Pause" : started ? "Resume conversation" : "Play conversation"}
      </Button>
      {started && !ended ? <Button size="sm" variant="ghost" onClick={restart}><RotateCcw />Replay</Button> : null}
      {onShowSavedThread ? <Button size="sm" variant="ghost" onClick={onShowSavedThread}>Show saved thread</Button> : null}
      <span className="text-muted-foreground" role="status">{started ? ended ? "Conversation complete" : `${playing ? "" : "Paused · "}${CONVERSATION_PLAYBACK_STAGES[stage]?.label}` : "Watch a typical conversation · synthetic preview"}</span>
    </div>
    <TaskChatThreadView key={generation} header={header} items={started ? [human] : []} contentKey={`${elapsed}:${generation}`} tail={started ? <div className="flex flex-col gap-8">
      <ConversationPlaybackTurn settled={followUp} snapshot={firstSnapshot} items={firstItems} response={firstResponse} settledItems={firstSettled} />
      {followUp ? <>
        <TaskChatThreadView scroll={false} className="p-0 md:p-0" items={followUpMessage} />
        <ConversationPlaybackTurn settled={ended} snapshot={snapshot} items={parsed} response={secondResponse} settledItems={secondSettled} />
      </> : null}
    </div> : undefined} />

  </section>;
}
