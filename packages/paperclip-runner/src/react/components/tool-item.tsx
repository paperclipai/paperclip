import * as React from "react";

import type { SessionItemSnapshot } from "../../reducer/session-reducer.js";
import type { TranscriptDebugEvent } from "../../browser/transcript-model.js";
import { Badge } from "./badge.js";

export type ToolStatus = "running" | "completed" | "failed" | "interrupted";

const STATUS_TONE: Record<ToolStatus, "accent" | "success" | "danger" | "warning"> = {
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

function toolView(kind: string): string {
  if (["commandExecution", "command_execution"].includes(kind)) return "Terminal";
  if (["fileChange", "file_change", "patchApply"].includes(kind)) return "File change";
  if (["plan", "planUpdate", "update_plan"].includes(kind)) return "Plan";
  return "Tool";
}

export function ToolItem({
  item,
  name,
  status,
  input,
  output,
  failure,
  debugEvents = [],
  renderItemBody,
}: {
  item: SessionItemSnapshot;
  name: string;
  status: ToolStatus;
  input: string | null;
  output: string | null;
  failure: string | null;
  debugEvents?: readonly TranscriptDebugEvent[];
  renderItemBody?: (item: SessionItemSnapshot) => React.ReactNode;
}) {
  const view = toolView(item.kind);
  return (
    <details
      data-slot="tool-item"
      className="pcr-disclosure"
      open={status === "running" || status === "failed"}
      data-testid="tool-item"
      data-status={status}
      data-view={view.toLowerCase().replaceAll(" ", "-")}
    >
      <summary className="pcr-disclosure-summary">
        <span>{view} <code>{name}</code></span>
        <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
      </summary>
      {renderItemBody?.(item) ?? (
        <>
          {input === null ? null : (
            <><p className="pcr-disclosure-label">Input</p><pre className="pcr-payload">{input}</pre></>
          )}
          {output === null ? null : (
            <><p className="pcr-disclosure-label">Output</p><pre className="pcr-payload">{output}</pre></>
          )}
          {input === null && output === null && item.text.length > 0
            ? <pre className="pcr-payload">{item.text}</pre>
            : null}
        </>
      )}
      {failure === null ? null : (
        <><p className="pcr-disclosure-label">Diagnostic</p><pre className="pcr-payload pcr-payload--danger" data-testid="tool-failure">{failure}</pre></>
      )}
      {debugEvents.length === 0 ? null : (
        <details className="pcr-tool-debug" data-testid="tool-debug-details">
          <summary>Debug details ({debugEvents.length} {debugEvents.length === 1 ? "event" : "events"})</summary>
          <pre className="pcr-payload">{JSON.stringify(debugEvents, null, 2)}</pre>
        </details>
      )}
      {status === "interrupted" ? (
        <p className="pcr-message-divider" data-testid="interrupted-divider">
          Interrupted — the last known status is shown and no result was fabricated.
        </p>
      ) : null}
    </details>
  );
}
