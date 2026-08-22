import * as React from "react";

import type { SessionItemSnapshot } from "../../reducer/session-reducer.js";
import type { TranscriptRole } from "../../browser/transcript-model.js";

const ROLE_LABELS: Record<TranscriptRole, string> = {
  user: "You",
  assistant: "Assistant",
  reasoning: "Reasoning",
  tool: "Tool",
  steering: "Steering acknowledged",
  interrupt: "Interrupt acknowledged",
  goal: "Goal",
  lineage: "Child thread",
  system: "System",
};

export interface MessageProps {
  role: TranscriptRole;
  item?: SessionItemSnapshot;
  text?: string;
  interrupted?: boolean;
  failed?: boolean;
  failure?: string | null;
  streaming?: boolean;
  renderItemBody?: (item: SessionItemSnapshot) => React.ReactNode;
  children?: React.ReactNode;
}

export function Message({
  role,
  item,
  text,
  interrupted = false,
  failed = false,
  failure = null,
  streaming = false,
  renderItemBody,
  children,
}: MessageProps) {
  const body = item === undefined
    ? (children ?? text ?? "")
    : (renderItemBody?.(item) ?? <MessageText text={item.text} streaming={streaming} />);
  return (
    <article
      data-slot="message"
      data-role={role}
      data-state={failed ? "failed" : interrupted ? "interrupted" : streaming ? "streaming" : "settled"}
      className="pcr-message"
    >
      <p className="pcr-message-role">{ROLE_LABELS[role]}</p>
      <div className="pcr-message-body">{body}</div>
      {failure === null ? null : (
        <pre className="pcr-payload pcr-payload--danger" data-testid="item-failure">
          {failure}
        </pre>
      )}
      {interrupted ? (
        <p className="pcr-message-divider" data-testid="interrupted-divider">
          Interrupted — the text above is everything that arrived.
        </p>
      ) : null}
    </article>
  );
}

export function MessageText({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <p className="pcr-message-text">
      {text}
      {streaming ? <span className="pcr-stream-cursor" aria-hidden="true" /> : null}
    </p>
  );
}
