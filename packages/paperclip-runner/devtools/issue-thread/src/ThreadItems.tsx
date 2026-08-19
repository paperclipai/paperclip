import { useState } from "react";

import type {
  CapabilityEvidenceSectionId,
  CapabilityThreadItem,
  CapabilityThreadTurn,
} from "../../../src/issue-thread/types";
import { InteractionCard, type CapabilityInteractionResponse } from "./InteractionCard";
import { Chip, StatusBadge, Timestamp, formatBytes } from "./primitives";

/** Progressive disclosure budget from contract §3 (T4). */
const VISIBLE_STRIPS = 3;

const STATUS_GLYPH = { ok: "✓", denied: "✕", running: "⏳" } as const;

export interface ThreadCallbacks {
  onOpenEvidence: (section: CapabilityEvidenceSectionId, recordId: string) => void;
  onRespond: (response: CapabilityInteractionResponse) => void;
  focusInteractionId: string | null;
}

function ToolStrip({
  item,
  callbacks,
}: {
  item: Extract<CapabilityThreadItem, { kind: "tool_activity" }>;
  callbacks: ThreadCallbacks;
}) {
  return (
    <details
      id={item.id}
      className="pit-activity-item"
      data-thread-item="tool_activity"
      data-status={item.status}
      data-tool-strip={item.operationId}
    >
      <summary className="pit-activity-summary">
        <span className="pit-activity-glyph" aria-hidden="true">
          {STATUS_GLYPH[item.status]}
        </span>
        <span className="pit-visually-hidden">{item.status}</span>
        <span className="pit-activity-operation">{item.operationId}</span>
        <span className="pit-activity-description">{item.summary}</span>
        <span className="pit-activity-caret" aria-hidden="true">›</span>
      </summary>
      <div className="pit-activity-detail">
        <p className="pit-card-meta">Sanitized tool input and result</p>
        <div className="pit-activity-payloads">
          <pre className="pit-code">{JSON.stringify(item.input, null, 2)}</pre>
          <pre className="pit-code">{JSON.stringify(item.result, null, 2)}</pre>
        </div>
        <button
          type="button"
          className="pit-link-button"
          onClick={() =>
            callbacks.onOpenEvidence(item.evidenceRef.section, item.evidenceRef.recordId)
          }
        >
          View in Evidence
        </button>
      </div>
    </details>
  );
}

function ProgressItem({
  item,
}: {
  item: Extract<CapabilityThreadItem, { kind: "progress_activity" }>;
}) {
  return (
    <details
      id={item.id}
      className="pit-activity-item pit-progress-activity"
      data-thread-item="progress_activity"
      data-activity={item.activity}
      data-status={item.status}
      open={item.status === "running"}
    >
      <summary className="pit-activity-summary">
        <span className="pit-activity-glyph" aria-hidden="true">
          {item.status === "running" ? "⏳" : "✓"}
        </span>
        <span className="pit-activity-operation">{item.label}</span>
        <span className="pit-activity-description">{item.summary}</span>
        <span className="pit-activity-caret" aria-hidden="true">›</span>
      </summary>
      <div className="pit-activity-detail">
        <p>
          {item.eventCount} sanitized progress update{item.eventCount === 1 ? "" : "s"} observed.
          Raw chain-of-thought and provider text are not exposed.
        </p>
      </div>
    </details>
  );
}

function ThreadItemView({
  item,
  callbacks,
}: {
  item: CapabilityThreadItem;
  callbacks: ThreadCallbacks;
}) {
  switch (item.kind) {
    case "user_message":
      return (
        <article
          id={item.id}
          className="pit-message"
          data-role="user"
          data-thread-item="user_message"
        >
          <div className="pit-card-head">
            <span className="pit-card-author">{item.author}</span>
            <Timestamp value={item.at} />
          </div>
          <div className="pit-card-body">{item.body}</div>
        </article>
      );

    case "agent_message":
      return (
        <article
          id={item.id}
          className="pit-message"
          data-role="assistant"
          data-thread-item="agent_message"
          data-streaming={item.streaming}
        >
          <div className="pit-card-head">
            <span className="pit-card-author">{item.author}</span>
            <Timestamp value={item.at} />
            {item.streaming ? (
              <Chip tone="accent" testId="streaming-indicator">
                <span aria-hidden="true">⏳</span>
                Streaming
              </Chip>
            ) : null}
          </div>
          <div className="pit-card-body">{item.body}</div>
        </article>
      );

    case "durable_comment":
      return (
        <article id={item.id} className="pit-card" data-thread-item="durable_comment">
          <div className="pit-card-head">
            <span className="pit-card-author">{item.author}</span>
            <Timestamp value={item.at} />
            <span
              className="pit-durable-tag"
              title={`Recorded by the ${item.operationId} semantic operation.`}
            >
              <span aria-hidden="true">◆</span>
              Recorded to mock thread
            </span>
          </div>
          <div className="pit-card-body">{item.body}</div>
          <button
            type="button"
            className="pit-link-button"
            onClick={() =>
              callbacks.onOpenEvidence(item.evidenceRef.section, item.evidenceRef.recordId)
            }
          >
            View in Evidence
          </button>
        </article>
      );

    case "tool_activity":
      return <ToolStrip item={item} callbacks={callbacks} />;

    case "progress_activity":
      return <ProgressItem item={item} />;

    case "denial":
      return (
        <div id={item.id} className="pit-strip pit-denial" data-status="denied" data-thread-item="denial">
          <div className="pit-strip-button">
            <span className="pit-strip-glyph" aria-hidden="true">
              ✕
            </span>
            <span className="pit-strip-operation">{item.operationId}</span>
            <span className="pit-strip-summary" data-testid="denial-reason">
              {item.reason}
            </span>
          </div>
          <div className="pit-strip-detail">
            <button
              type="button"
              className="pit-link-button"
              onClick={() =>
                callbacks.onOpenEvidence(item.evidenceRef.section, item.evidenceRef.recordId)
              }
            >
              View in Evidence
            </button>
          </div>
        </div>
      );

    case "interaction":
      return (
        <InteractionCard
          card={item}
          autoFocus={callbacks.focusInteractionId === item.interactionId}
          onRespond={callbacks.onRespond}
          onOpenEvidence={(section, recordId) =>
            callbacks.onOpenEvidence(section as CapabilityEvidenceSectionId, recordId)
          }
        />
      );

    case "document":
      return (
        <article id={item.id} className="pit-card" data-thread-item="document">
          <div className="pit-card-head">
            <span className="pit-card-author">{item.title}</span>
            <span className="pit-card-meta">{item.documentKey}</span>
            <Timestamp value={item.at} />
          </div>
          <div className="pit-card-body">
            <span className="pit-card-meta" data-testid="revision-chain">
              {item.revisionFrom === null ? `r${item.revisionTo}` : `r${item.revisionFrom} → r${item.revisionTo}`}
            </span>
            {" · "}
            {item.author}
            {item.staleBehind !== null ? (
              <>
                {" "}
                <Chip>
                  <span aria-hidden="true">⌛</span>
                  Stale — {item.staleBehind} newer revision(s)
                </Chip>
              </>
            ) : null}
          </div>
          <button
            type="button"
            className="pit-link-button"
            onClick={() =>
              callbacks.onOpenEvidence(item.evidenceRef.section, item.evidenceRef.recordId)
            }
          >
            View diff
          </button>
        </article>
      );

    case "deliverable":
      return (
        <article id={item.id} className="pit-card" data-thread-item="deliverable">
          <div className="pit-card-head">
            <span className="pit-card-author">{item.filename}</span>
            <Timestamp value={item.at} />
          </div>
          <div className="pit-card-body">
            <span className="pit-card-meta">
              {item.deliverableKind} · {formatBytes(item.byteSize)} · registered by {item.registeredBy}
            </span>
          </div>
          <button
            type="button"
            className="pit-link-button"
            onClick={() =>
              callbacks.onOpenEvidence(item.evidenceRef.section, item.evidenceRef.recordId)
            }
          >
            Download {item.filename}
          </button>
        </article>
      );

    case "dependency":
      return (
        <article id={item.id} className="pit-card" data-thread-item="dependency">
          <div className="pit-card-head">
            <span className="pit-card-author">Delegation</span>
            <Timestamp value={item.at} />
          </div>
          <ul className="pit-summary-list">
            {item.createdTasks.map((task) => (
              <li key={task.identifier}>
                <span className="pit-record-title">{task.identifier}</span> {task.title}
              </li>
            ))}
            {item.blockerEdges.map((edge) => (
              <li key={edge}>{edge}</li>
            ))}
          </ul>
        </article>
      );

    case "disposition":
      return (
        <article id={item.id} className="pit-card pit-terminal-card" data-thread-item="disposition">
          <div className="pit-card-head">
            <StatusBadge status={item.status} />
            <span className="pit-card-meta">{item.operationId}</span>
            <Timestamp value={item.at} />
          </div>
          <div className="pit-card-body">{item.body}</div>
          {item.blockerOwner !== null ? (
            <p className="pit-card-meta">Blocker owner: {item.blockerOwner}</p>
          ) : null}
        </article>
      );

    case "system_notice":
      return (
        <p id={item.id} className="pit-notice" data-thread-item="system_notice">
          <span aria-hidden="true">{item.glyph}</span>
          <span className="pit-notice-text">{item.text}</span>
          <button
            type="button"
            className="pit-link-button"
            onClick={() =>
              callbacks.onOpenEvidence(item.evidenceRef.section, item.evidenceRef.recordId)
            }
          >
            Details
          </button>
        </p>
      );
  }
}

export function TurnGroup({
  turn,
  callbacks,
}: {
  turn: CapabilityThreadTurn;
  callbacks: ThreadCallbacks;
}) {
  const [showAllStrips, setShowAllStrips] = useState(false);
  const stripIndexes = turn.items
    .map((item, index) => (item.kind === "tool_activity" ? index : -1))
    .filter((index) => index >= 0);
  const hiddenStripIndexes = new Set(
    showAllStrips ? [] : stripIndexes.slice(VISIBLE_STRIPS),
  );

  return (
    <section className="pit-turn" data-turn-id={turn.id} aria-label={`Turn ${turn.ordinal}`}>
      <h2 className="pit-turn-header">
        <span className="pit-turn-label">
          Turn {turn.ordinal} · {turn.mode} · {turn.toolCallCount} tool call
          {turn.toolCallCount === 1 ? "" : "s"} ·{" "}
          {new Date(turn.at).toISOString().slice(11, 19)}
        </span>
        {turn.stoppedByUser ? (
          <span className="pit-stopped-marker" data-testid="stopped-marker">
            Stopped by user
          </span>
        ) : null}
      </h2>
      {turn.items.map((item, index) =>
        hiddenStripIndexes.has(index) ? null : (
          <ThreadItemView key={item.id} item={item} callbacks={callbacks} />
        ),
      )}
      {hiddenStripIndexes.size > 0 ? (
        <button
          type="button"
          className="pit-more-button"
          onClick={() => setShowAllStrips(true)}
        >
          {hiddenStripIndexes.size} more…
        </button>
      ) : null}
    </section>
  );
}
