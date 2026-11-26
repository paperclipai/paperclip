import * as React from "react";

import type { SessionItemSnapshot } from "../../reducer/session-reducer.js";

export function ReasoningItem({
  item,
  streaming,
  interrupted,
  renderItemBody,
}: {
  item: SessionItemSnapshot;
  streaming: boolean;
  interrupted: boolean;
  renderItemBody?: (item: SessionItemSnapshot) => React.ReactNode;
}) {
  const summary = item.text.split("\n")[0]?.slice(0, 96) ?? "Reasoning";
  return (
    <details
      data-slot="reasoning-item"
      className="pcr-disclosure"
      open={streaming}
      data-testid="reasoning-item"
    >
      <summary className="pcr-disclosure-summary">
        <span>{streaming ? "Reasoning…" : "Reasoning"}</span>
        <span className="pcr-disclosure-preview">{summary}</span>
      </summary>
      {renderItemBody?.(item) ?? <pre className="pcr-payload">{item.text}</pre>}
      {interrupted ? <p className="pcr-message-divider">Interrupted while reasoning.</p> : null}
    </details>
  );
}
