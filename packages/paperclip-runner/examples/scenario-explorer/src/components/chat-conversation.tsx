import * as React from "react";

import type {
  CapabilityChatSessionArtifact,
  CapabilityChatTurn,
  CapabilityTimelineEntry,
} from "@paperclip-runner-local/capability";

import { TimelineEntryBody } from "./scenario-transcript.js";
import { TurnStrip } from "./chat-turn-strip.js";

/**
 * The chat conversation (scenario-chat map §3).
 *
 * Four actors, four grammars: the board's message, the model's reply, the
 * agent's tool work, and the control plane's own work. Attribution is never
 * optional — a fact with no visible actor would be exactly the confusion this
 * activity view is meant to remove — so every row carries its channel and the
 * shared transcript body renders the detail identically to the scenario explorer.
 *
 * The component reorders nothing. Entries arrive in artifact order and are
 * grouped by the `turn` the runtime stamped on them.
 */

export function ChatConversation({
  artifact,
  revealedSequence,
  runningTurn,
  activeTurn,
  onOpenTurn,
}: {
  artifact: CapabilityChatSessionArtifact;
  /** Entries above this sequence are still streaming in and stay hidden. */
  revealedSequence: number;
  runningTurn: number | null;
  activeTurn: number | null;
  onOpenTurn: (turn: number) => void;
}) {
  return (
    <ol className="pcr7-chat-conversation" data-testid="chat-conversation">
      {artifact.turns.map((turn) => (
        <TurnBlock
          key={turn.turn}
          turn={turn}
          entries={artifact.timeline.filter(
            (entry) => entry.turn === turn.turn && entry.sequence <= revealedSequence,
          )}
          settled={runningTurn !== turn.turn && turn.lastSequence <= revealedSequence}
          activeTurn={activeTurn}
          onOpenTurn={onOpenTurn}
        />
      ))}
      {runningTurn !== null &&
      !artifact.turns.some((turn) => turn.turn === runningTurn) ? (
        <li className="pcr7-chat-turn" data-testid={`chat-turn-${runningTurn}`}>
          <PendingTurn turn={runningTurn} />
        </li>
      ) : null}
    </ol>
  );
}

function TurnBlock({
  turn,
  entries,
  settled,
  activeTurn,
  onOpenTurn,
}: {
  turn: CapabilityChatTurn;
  entries: readonly CapabilityTimelineEntry[];
  settled: boolean;
  activeTurn: number | null;
  onOpenTurn: (turn: number) => void;
}) {
  if (entries.length === 0 && !settled) return null;
  return (
    <li className="pcr7-chat-turn" data-testid={`chat-turn-${turn.turn}`} data-turn={turn.turn}>
      {turn.turn === 0 ? (
        <p className="pcr7-chat-seed-label" data-testid="chat-seed-label">
          Session seed — the control plane did this before the first message.
        </p>
      ) : null}
      <ol className="pcr7-chat-entries">
        {entries.map((entry) => (
          <li
            key={entry.sequence}
            id={`chat-entry-${entry.sequence}`}
            className="pcr7-chat-entry"
            data-channel={entry.channel}
            data-kind={entry.kind}
            data-testid={`chat-entry-${entry.sequence}`}
          >
            <TimelineEntryBody
              entry={entry}
              streaming={
                !settled &&
                entry.kind === "agent_message" &&
                entry.sequence === entries.at(-1)?.sequence
              }
            />
          </li>
        ))}
      </ol>
      {turn.failure === null ? null : (
        <p className="pcr7-chat-failure" role="alert" data-testid={`chat-turn-failure-${turn.turn}`}>
          This turn stopped on a harness error: {turn.failure.message}. The activity below is
          partial; send the turn again or reset the session.
        </p>
      )}
      {settled ? (
        <TurnStrip turn={turn} onOpen={onOpenTurn} active={activeTurn === turn.turn} />
      ) : (
        <PendingTurn turn={turn.turn} />
      )}
    </li>
  );
}

function PendingTurn({ turn }: { turn: number }) {
  return (
    <p className="pcr7-turn-pending" data-testid={`turn-pending-${turn}`}>
      <span className="pcr7-streaming-caret" aria-hidden="true" />
      Turn {turn} · running — the mock control plane is still recording this turn.
    </p>
  );
}
