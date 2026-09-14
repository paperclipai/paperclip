import * as React from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { runtimeRequestSubmission, type TranscriptRequestEntry } from "./transcript-model";

const KIND_LABELS: Record<string, string> = {
  command_approval: "Command",
  file_approval: "File change",
  permission_approval: "Permission",
  user_input: "Input",
  elicitation: "Input",
};

const ACTION_LABELS: Record<string, string> = {
  accept: "Approve",
  accept_for_session: "Approve for session",
  decline: "Reject",
  cancel: "Cancel",
  submit: "Submit",
};

const STATUS_TONE = {
  pending: "accent",
  resolved: "success",
  expired: "warning",
  cancelled: "warning",
} as const;

function detailBlock(details: Record<string, unknown>): string | null {
  const command = details.command;
  if (typeof command === "string") return command;
  const diff = details.diff;
  if (typeof diff === "string") {
    const path = typeof details.path === "string" ? `${details.path}\n` : "";
    return `${path}${diff}`;
  }
  return null;
}

/**
 * One card renders all five request kinds. Actions come from the upstream
 * request contract, so the card can never invent an affordance the runner
 * cannot honour, and the first click locks the row until the canonical
 * resolved event arrives.
 */
export function RequestCard({
  entry,
  onResolve,
  focusRef,
}: {
  entry: TranscriptRequestEntry;
  onResolve: (resolution: Record<string, unknown>) => void;
  focusRef?: React.Ref<HTMLLIElement>;
}) {
  const [answer, setAnswer] = React.useState("");
  const [resolving, setResolving] = React.useState(false);
  const answerId = React.useId();
  const kindLabel = KIND_LABELS[entry.requestKind] ?? "Request";
  const pending = entry.status === "pending";
  const isInput = entry.requestKind === "user_input" || entry.requestKind === "elicitation";
  const payload = detailBlock(entry.details);

  React.useEffect(() => {
    if (!pending) setResolving(false);
  }, [pending]);

  function submit(resolution: Record<string, unknown>) {
    setResolving(true);
    onResolve(resolution);
  }

  if (!pending) {
    return (
      <li
        ref={focusRef}
        className="ui-request ui-request--settled"
        data-status={entry.status}
        data-testid="request-card"
        tabIndex={-1}
      >
        <details>
          <summary className="ui-request-summary">
            <span>
              {kindLabel} · {entry.status === "resolved"
                ? `resolved — ${ACTION_LABELS[entry.resolvedAction ?? ""] ?? entry.resolvedAction ?? "unknown"}`
                : entry.status === "expired"
                  ? "expired before response"
                  : "cancelled"}
            </span>
            <Badge tone={STATUS_TONE[entry.status]}>{entry.status}</Badge>
          </summary>
          <p className="ui-request-prompt">{entry.prompt}</p>
          <p className="ui-request-meta">
            <code>{entry.requestId}</code>
            {entry.resolvedAt === null ? null : <time dateTime={entry.resolvedAt}>{entry.resolvedAt}</time>}
          </p>
          {payload === null ? null : <pre className="ui-payload">{payload}</pre>}
        </details>
      </li>
    );
  }

  return (
    <li
      ref={focusRef}
      className="ui-request"
      data-status="pending"
      data-testid="request-card"
      tabIndex={-1}
    >
      <div className="ui-request-header">
        <span className="ui-request-kind">{kindLabel}</span>
        <Badge tone="accent">pending</Badge>
      </div>
      <p className="ui-request-prompt">{entry.prompt}</p>
      <p className="ui-request-meta">
        <code>{entry.requestId}</code>
      </p>
      {payload === null ? null : <pre className="ui-payload">{payload}</pre>}
      {isInput ? (
        <div className="ui-request-input">
          <label htmlFor={answerId}>Answer</label>
          <input
            id={answerId}
            data-testid="request-answer"
            value={answer}
            disabled={resolving}
            onChange={(event) => setAnswer(event.target.value)}
          />
        </div>
      ) : null}
      <div className="ui-request-actions">
        {entry.actions.map((action) => (
          <Button
            key={action}
            type="button"
            className={
              action === "decline"
                ? "ui-button--danger"
                : action === "cancel"
                  ? "ui-button--quiet"
                  : action === "accept" || action === "submit"
                    ? ""
                    : "ui-button--secondary"
            }
            disabled={resolving || (action === "submit" && answer.trim().length === 0)}
            data-testid={`request-action-${action}`}
            onClick={() =>
              submit(
                action === "submit"
                  ? runtimeRequestSubmission(entry.requestKind, answer)
                  : { action },
              )
            }
          >
            {ACTION_LABELS[action] ?? action}
          </Button>
        ))}
      </div>
      {resolving ? (
        <p className="ui-request-resolving" role="status">
          Resolving — waiting for the canonical resolved event.
        </p>
      ) : null}
    </li>
  );
}
