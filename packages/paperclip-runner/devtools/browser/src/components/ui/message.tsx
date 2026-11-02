import * as React from "react";

import type { TranscriptRole } from "../../live/transcript-model";

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

/**
 * Source-adapted AI Elements `Message`. The role-based alignment and the
 * compact avatar-less variant are kept; the props are reducer item snapshots
 * rather than AI SDK message parts.
 */
export function Message({
  role,
  children,
  interrupted = false,
  failed = false,
  streaming = false,
}: {
  role: TranscriptRole;
  children: React.ReactNode;
  interrupted?: boolean;
  failed?: boolean;
  streaming?: boolean;
}) {
  return (
    <article
      data-slot="message"
      data-role={role}
      data-state={failed ? "failed" : interrupted ? "interrupted" : streaming ? "streaming" : "settled"}
      className="ui-message"
    >
      <p className="ui-message-role">{ROLE_LABELS[role]}</p>
      <div className="ui-message-body">{children}</div>
      {interrupted ? (
        <p className="ui-message-divider" data-testid="interrupted-divider">
          Interrupted — the text above is everything that arrived.
        </p>
      ) : null}
    </article>
  );
}

export function MessageText({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <p className="ui-message-text">
      {text}
      {streaming ? <span className="ui-stream-cursor" aria-hidden="true" /> : null}
    </p>
  );
}
