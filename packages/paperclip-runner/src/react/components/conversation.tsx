import * as React from "react";

import type { SessionItemSnapshot } from "../../reducer/session-reducer.js";
import type {
  TranscriptEntry,
  TranscriptRequestEntry,
} from "../../browser/transcript-model.js";
import { RequestCard } from "../request-card.js";
import { Badge } from "./badge.js";
import { Message } from "./message.js";
import { ReasoningItem } from "./reasoning-item.js";
import { ToolItem, type ToolStatus } from "./tool-item.js";

const TURN_TONE = {
  completed: "success",
  failed: "danger",
  interrupted: "warning",
  cancelled: "warning",
} as const;
const TURN_LABEL = {
  completed: "Turn completed",
  failed: "Turn failed",
  interrupted: "Turn interrupted",
  cancelled: "Cancelled before start",
} as const;

function toolStatus(entry: Extract<TranscriptEntry, { kind: "item" }>): ToolStatus {
  if (entry.interrupted) return "interrupted";
  if (entry.item.status === "failed") return "failed";
  if (entry.item.status === "running") return "running";
  return "completed";
}

export interface ConversationProps {
  entries: readonly TranscriptEntry[];
  label?: string;
  unseenCount?: number;
  highlightItemId?: string | null;
  onResolveRequest?: (
    request: TranscriptRequestEntry,
    resolution: Record<string, unknown>,
  ) => void;
  renderItemBody?: (item: SessionItemSnapshot) => React.ReactNode;
  renderRequestDetail?: (request: TranscriptRequestEntry) => React.ReactNode;
}

/**
 * Canonical transcript renderer. Ordering comes from reducer-backed entries;
 * the component owns only scroll following and the accepted render seams.
 */
export function Conversation({
  entries,
  label = "Session transcript",
  unseenCount,
  highlightItemId = null,
  onResolveRequest,
  renderItemBody,
  renderRequestDetail,
}: ConversationProps) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const [following, setFollowing] = React.useState(true);
  const [seenCount, setSeenCount] = React.useState(entries.length);

  const scrollToBottom = React.useCallback((smooth: boolean) => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: smooth && !reduceMotion ? "smooth" : "auto",
    });
  }, []);

  const scrollToLatestResponse = React.useCallback((smooth: boolean): boolean => {
    const viewport = viewportRef.current;
    if (viewport === null) return false;
    const responses = viewport.querySelectorAll<HTMLElement>(
      '.pcr-message[data-role="assistant"]:not([data-state="streaming"])',
    );
    const response = responses.item(responses.length - 1);
    if (response === null) return false;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const viewportTop = viewport.getBoundingClientRect().top;
    const responseTop = response.getBoundingClientRect().top;
    viewport.scrollTo({
      top: Math.max(viewport.scrollTop + responseTop - viewportTop - 16, 0),
      behavior: smooth && !reduceMotion ? "smooth" : "auto",
    });
    return true;
  }, []);

  React.useEffect(() => {
    if (!following) return;
    if (!scrollToLatestResponse(false)) scrollToBottom(false);
    setSeenCount(entries.length);
  }, [entries, following, scrollToBottom, scrollToLatestResponse]);

  function reengage() {
    setFollowing(true);
    setSeenCount(entries.length);
    scrollToBottom(true);
  }

  const unseen = unseenCount ?? Math.max(entries.length - seenCount, 0);

  return (
    <div data-slot="conversation" className="pcr-conversation">
      <div
        ref={viewportRef}
        role="log"
        aria-label={label}
        aria-relevant="additions"
        tabIndex={0}
        className="pcr-conversation-viewport"
        data-following={following}
        data-testid="runner-transcript"
        onScroll={() => {
          const viewport = viewportRef.current;
          if (viewport === null) return;
          const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24;
          setFollowing(atBottom);
          if (atBottom) setSeenCount(entries.length);
        }}
        onKeyDown={(event) => {
          if (event.key === "End") {
            event.preventDefault();
            reengage();
          } else if (event.key === "Home") {
            event.preventDefault();
            setFollowing(false);
            viewportRef.current?.scrollTo({ top: 0 });
          }
        }}
      >
        {entries.length === 0 ? (
          <div className="pcr-empty-transcript" data-testid="empty-transcript">
            <p className="pcr-eyebrow">No session yet</p>
            <h3>Pick a demo chat or send a message</h3>
            <p>The browser holds no provider credential. The protocol server owns the driver and working directory.</p>
          </div>
        ) : null}
        <ol className="pcr-transcript" role="list">
          {entries.map((entry) => {
            if (entry.kind === "user") {
              return <li key={entry.key}><Message role="user" text={entry.text} /></li>;
            }
            if (entry.kind === "turn") {
              return (
                <li key={entry.key} className="pcr-turn-marker" data-testid={`turn-${entry.state}`}>
                  <Badge tone={TURN_TONE[entry.state]}>{TURN_LABEL[entry.state]}</Badge><span>{entry.detail}</span>
                </li>
              );
            }
            if (entry.kind === "diagnostic") {
              return <li key={entry.key}><Message role="system" text={entry.message} failed /></li>;
            }
            if (entry.kind === "request") {
              return (
                <RequestCard
                  key={entry.key}
                  request={entry}
                  onResolve={(resolution) => onResolveRequest?.(entry, resolution)}
                  {...(renderRequestDetail === undefined ? {} : { renderRequestDetail })}
                />
              );
            }
            if (entry.role === "reasoning") {
              return (
                <li key={entry.key} data-highlighted={entry.item.itemId === highlightItemId}>
                  <ReasoningItem item={entry.item} streaming={entry.streaming} interrupted={entry.interrupted} {...(renderItemBody === undefined ? {} : { renderItemBody })} />
                </li>
              );
            }
            if (entry.role === "tool") {
              return (
                <li key={entry.key} data-highlighted={entry.item.itemId === highlightItemId}>
                  <ToolItem item={entry.item} name={entry.toolName ?? entry.item.kind} status={toolStatus(entry)} input={entry.input} output={entry.output} failure={entry.failure} debugEvents={entry.debugEvents} {...(renderItemBody === undefined ? {} : { renderItemBody })} />
                </li>
              );
            }
            return (
              <li key={entry.key} data-highlighted={entry.item.itemId === highlightItemId}>
                <Message role={entry.role} item={entry.item} streaming={entry.streaming} interrupted={entry.interrupted} failed={entry.item.status === "failed"} failure={entry.failure} {...(renderItemBody === undefined ? {} : { renderItemBody })} />
              </li>
            );
          })}
        </ol>
      </div>
      {following ? null : (
        <button type="button" className="pcr-jump-to-latest" data-testid="jump-to-latest" onClick={reengage}>
          Jump to latest{unseen > 0 ? ` (${unseen} new)` : ""}
        </button>
      )}
    </div>
  );
}
