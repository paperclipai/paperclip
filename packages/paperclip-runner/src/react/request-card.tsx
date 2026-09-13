import * as React from "react";

import { Badge } from "./components/badge.js";
import { Button } from "./components/button.js";
import { runtimeRequestSubmission, type TranscriptRequestEntry } from "../browser/transcript-model.js";

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
  request,
  onResolve,
  focusRef,
  renderRequestDetail,
}: {
  request: TranscriptRequestEntry;
  onResolve: (resolution: Record<string, unknown>) => void;
  focusRef?: React.Ref<HTMLLIElement>;
  renderRequestDetail?: (request: TranscriptRequestEntry) => React.ReactNode;
}) {
  const [answer, setAnswer] = React.useState("");
  const [resolving, setResolving] = React.useState(false);
  const answerId = React.useId();
  const kindLabel = KIND_LABELS[request.requestKind] ?? "Request";
  const pending = request.status === "pending";
  const isInput = request.requestKind === "user_input" || request.requestKind === "elicitation";
  const payload = detailBlock(request.details);
  const detail = renderRequestDetail?.(request)
    ?? (payload === null ? null : <pre className="pcr-payload">{payload}</pre>);

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
        data-slot="request-card"
        className="pcr-request pcr-request--settled"
        data-status={request.status}
        data-testid="request-card"
        tabIndex={-1}
      >
        <details>
          <summary className="pcr-request-summary">
            <span>
              {kindLabel} · {request.status === "resolved"
                ? `resolved — ${ACTION_LABELS[request.resolvedAction ?? ""] ?? request.resolvedAction ?? "unknown"}`
                : request.status === "expired"
                  ? "expired before response"
                  : "cancelled"}
            </span>
            <Badge tone={STATUS_TONE[request.status]}>{request.status}</Badge>
          </summary>
          <p className="pcr-request-prompt">{request.prompt}</p>
          <p className="pcr-request-meta">
            <code>{request.requestId}</code>
            {request.resolvedAt === null ? null : <time dateTime={request.resolvedAt}>{request.resolvedAt}</time>}
          </p>
          {detail}
        </details>
      </li>
    );
  }

  return (
    <li
      ref={focusRef}
      data-slot="request-card"
      className="pcr-request"
      data-status="pending"
      data-testid="request-card"
      tabIndex={-1}
    >
      <div className="pcr-request-header">
        <span className="pcr-request-kind">{kindLabel}</span>
        <Badge tone="accent">pending</Badge>
      </div>
      <p className="pcr-request-prompt">{request.prompt}</p>
      <p className="pcr-request-meta">
        <code>{request.requestId}</code>
      </p>
      {detail}
      {isInput ? (
        <div className="pcr-request-input">
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
      <div className="pcr-request-actions">
        {request.actions.map((action) => (
          <Button
            key={action}
            type="button"
            className={
              action === "decline"
                ? "pcr-button--danger"
                : action === "cancel"
                  ? "pcr-button--quiet"
                  : action === "accept" || action === "submit"
                    ? ""
                    : "pcr-button--secondary"
            }
            disabled={resolving || (action === "submit" && answer.trim().length === 0)}
            data-testid={`request-action-${action}`}
            onClick={() =>
              submit(
                action === "submit"
                  ? runtimeRequestSubmission(request.requestKind, answer)
                  : { action },
              )
            }
          >
            {ACTION_LABELS[action] ?? action}
          </Button>
        ))}
      </div>
      {resolving ? (
        <p className="pcr-request-resolving" role="status">
          Resolving — waiting for the canonical resolved event.
        </p>
      ) : null}
    </li>
  );
}
