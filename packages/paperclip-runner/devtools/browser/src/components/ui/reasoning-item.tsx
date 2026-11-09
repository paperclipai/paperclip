import * as React from "react";

/**
 * Source-adapted AI Elements `Reasoning`. The collapsible block that opens
 * while streaming is kept; it is rebuilt on native `<details>` and renders
 * exact streamed text with no markdown pipeline.
 */
export function ReasoningItem({
  text,
  streaming,
  interrupted,
}: {
  text: string;
  streaming: boolean;
  interrupted: boolean;
}) {
  const summary = text.split("\n")[0]?.slice(0, 96) ?? "Reasoning";
  return (
    <details
      data-slot="reasoning"
      className="ui-disclosure"
      open={streaming}
      data-testid="reasoning-item"
    >
      <summary className="ui-disclosure-summary">
        <span>{streaming ? "Reasoning…" : "Reasoning"}</span>
        <span className="ui-disclosure-preview">{summary}</span>
      </summary>
      <pre className="ui-payload">{text}</pre>
      {interrupted ? <p className="ui-message-divider">Interrupted while reasoning.</p> : null}
    </details>
  );
}
