import * as React from "react";

import { Badge } from "./badge";

export type ToolStatus = "running" | "completed" | "failed" | "interrupted";

const STATUS_TONE: Record<ToolStatus, "neutral" | "accent" | "success" | "danger" | "warning"> = {
  running: "accent",
  completed: "success",
  failed: "danger",
  interrupted: "warning",
};

const STATUS_LABEL: Record<ToolStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
};

/**
 * Source-adapted AI Elements `Tool`. The header/input/output anatomy is kept;
 * the status enum comes from canonical item events instead of an AI SDK tool
 * part, and payloads stay in `<pre>` so nothing is prettified away.
 */
export function ToolItem({
  name,
  status,
  input,
  output,
  failure,
}: {
  name: string;
  status: ToolStatus;
  input: string | null;
  output: string | null;
  failure: string | null;
}) {
  return (
    <details
      data-slot="tool"
      className="ui-disclosure"
      open={status === "running" || status === "failed"}
      data-testid="tool-item"
      data-status={status}
    >
      <summary className="ui-disclosure-summary">
        <span>
          Tool <code>{name}</code>
        </span>
        <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
      </summary>
      {input === null ? null : (
        <>
          <p className="ui-disclosure-label">Input</p>
          <pre className="ui-payload">{input}</pre>
        </>
      )}
      {output === null ? null : (
        <>
          <p className="ui-disclosure-label">Output</p>
          <pre className="ui-payload">{output}</pre>
        </>
      )}
      {failure === null ? null : (
        <>
          <p className="ui-disclosure-label">Diagnostic</p>
          <pre className="ui-payload ui-payload--danger" data-testid="tool-failure">
            {failure}
          </pre>
        </>
      )}
      {status === "interrupted" ? (
        <p className="ui-message-divider" data-testid="interrupted-divider">
          Interrupted — the last known status is shown and no result was fabricated.
        </p>
      ) : null}
    </details>
  );
}
