import * as React from "react";

import { Badge } from "@paperclipai/paperclip-runner/react";
import type { CapabilityTimelineEntry } from "@paperclip-runner-local/capability";

import { DispositionBadge, JsonBlock, Mono, RedactionChip } from "./primitives.js";

/**
 * Scenario transcript — two visually distinct channels over one ordered
 * artifact timeline. Items render in artifact order; the view never reorders,
 * merges, or re-times an entry (UX map §3.2).
 */

export function ScenarioTranscript({
  timeline,
  highlightSequence,
  onSelectSequence,
}: {
  timeline: readonly CapabilityTimelineEntry[];
  highlightSequence: number | null;
  onSelectSequence?: (sequence: number) => void;
}) {
  return (
    <ol className="pcr7-transcript" data-testid="transcript">
      {timeline.map((entry) => (
        <li
          key={entry.sequence}
          id={`transcript-item-${entry.sequence}`}
          className="pcr7-transcript-item"
          data-channel={entry.channel}
          data-highlighted={entry.sequence === highlightSequence}
          data-testid={
            entry.kind === "control_plane_action"
              ? `cp-action-${entry.sequence}`
              : `transcript-item-${entry.sequence}`
          }
          onClick={onSelectSequence === undefined ? undefined : () => onSelectSequence(entry.sequence)}
        >
          <TimelineEntryBody entry={entry} />
        </li>
      ))}
    </ol>
  );
}

/**
 * One timeline entry in the transcript grammar. Shared with the Scenario chat chat
 * so a semantic call, a denial, and a control-plane strip look the same
 * wherever they are read.
 */
export function TimelineEntryBody({
  entry,
  streaming = false,
}: {
  entry: CapabilityTimelineEntry;
  streaming?: boolean;
}) {
  switch (entry.kind) {
    case "user_message":
      return (
        <div className="pcr7-user-message">
          <p>{entry.text}</p>
        </div>
      );

    case "agent_message": {
      const text = streaming
        ? entry.text.slice(0, Math.max(1, Math.ceil(entry.text.length / 2)))
        : entry.text;
      return (
        <div
          className="pcr7-agent-message"
          data-state={streaming ? "streaming" : "settled"}
          data-testid={streaming ? "streaming-model-card" : undefined}
        >
          <span className="pcr7-gutter" aria-hidden="true">
            ▸
          </span>
          <p>
            {text}
            {streaming ? <span className="pcr-stream-cursor" aria-hidden="true" /> : null}
          </p>
        </div>
      );
    }

    case "semantic_call":
      return (
        <details className="pcr-disclosure pcr7-call" data-escape-hatch={entry.escapeHatch}>
          <summary className="pcr-disclosure-summary">
            <span>
              <Mono>{entry.operationId}</Mono> — {entry.summary}
            </span>
            <DispositionBadge disposition={entry.disposition} />
          </summary>
          {entry.escapeHatch ? (
            <p className="pcr7-escape-hatch" data-testid="escape-hatch-banner">
              Test-only escape hatch — this operation exists for skill-test scenarios and is not part
              of the production capability set.
            </p>
          ) : null}
          <dl className="pcr7-detail-list">
            <dt>Operation</dt>
            <dd>
              <Mono>{entry.operationId}</Mono> v1
            </dd>
            <dt>Required claims</dt>
            <dd>
              {entry.requiredClaims.length === 0 ? (
                <span className="pcr7-muted">none — task-scoped always tool</span>
              ) : (
                entry.requiredClaims.map((claim) => <Mono key={claim}>{claim}</Mono>)
              )}
            </dd>
            <dt>Idempotency</dt>
            <dd>
              {entry.idempotency}
              {entry.idempotencyKey === null ? null : (
                <>
                  {" "}
                  · <Mono>{entry.idempotencyKey}</Mono>
                </>
              )}
            </dd>
            <dt>Authorization record</dt>
            <dd>
              <Mono>#{entry.authorizationSequence}</Mono>
            </dd>
          </dl>
          {entry.redactions.length === 0 ? null : (
            <p className="pcr7-redaction-row">
              {entry.redactions.map((chip) => (
                <RedactionChip key={chip.path} chip={chip} />
              ))}
            </p>
          )}
          <JsonBlock label="Arguments" value={entry.input} />
        </details>
      );

    case "semantic_result": {
      const denied = entry.outcome === "denied" || entry.outcome === "absent";
      return (
        <details
          className={`pcr-disclosure pcr7-result${denied ? " pcr7-result--denied" : ""}`}
          open={denied}
          data-outcome={entry.outcome}
          data-testid={`result-${entry.sequence}`}
        >
          {entry.outcome === "denied" ? (
            <p
              className="pcr7-visually-hidden"
              role="alert"
              aria-live="assertive"
              aria-atomic="true"
              data-testid="denial-announcement"
            >
              Operation {entry.operationId} denied. {entry.failure?.reason}
            </p>
          ) : null}
          <summary className="pcr-disclosure-summary">
            <span>{entry.summary}</span>
            <Badge tone={denied ? "danger" : "success"}>
              {denied ? (entry.outcome === "absent" ? "Absent" : "Denied") : "Committed"}
            </Badge>
          </summary>
          {entry.failure === null ? null : (
            <dl className="pcr7-detail-list">
              <dt>Denial code</dt>
              <dd>
                <Mono>{entry.failure.code}</Mono>
              </dd>
              <dt>Reason</dt>
              <dd>
                <Mono>{entry.failure.reason}</Mono>
              </dd>
              <dt>Protected state</dt>
              <dd>not returned — the denial carries no task data</dd>
            </dl>
          )}
          {entry.redactions.length === 0 ? null : (
            <p className="pcr7-redaction-row">
              {entry.redactions.map((chip) => (
                <RedactionChip key={chip.path} chip={chip} />
              ))}
            </p>
          )}
          {entry.value === null ? null : <JsonBlock label="Result" value={entry.value} />}
          {entry.protocolEventRefs.length === 0 ? null : (
            <details className="pcr-tool-debug" data-testid="protocol-events">
              <summary>Protocol events ({entry.protocolEventRefs.length})</summary>
              <pre className="pcr-payload">{entry.protocolEventRefs.join("\n")}</pre>
            </details>
          )}
        </details>
      );
    }

    case "control_plane_action":
      return (
        <details className="pcr-disclosure pcr7-control-plane">
          <summary className="pcr-disclosure-summary">
            <span>
              <span className="pcr7-gutter" aria-hidden="true">
                ⌘
              </span>
              {entry.summary}
            </span>
            <Badge tone="neutral">Control plane</Badge>
          </summary>
          <dl className="pcr7-detail-list">
            <dt>Action</dt>
            <dd>
              <Mono>{entry.action}</Mono>
            </dd>
            <dt>State revision</dt>
            <dd>{entry.stateRevision}</dd>
            <dt>Audit reference</dt>
            <dd>{entry.auditRef === null ? <span className="pcr7-muted">none</span> : <Mono>{entry.auditRef}</Mono>}</dd>
            <dt>Decision reference</dt>
            <dd>
              {entry.decisionRef === null ? (
                <span className="pcr7-muted">none</span>
              ) : (
                <Mono>{entry.decisionRef}</Mono>
              )}
            </dd>
          </dl>
          <JsonBlock label="Decision record" value={entry.detail} />
        </details>
      );

    case "system_note":
      return (
        <p className="pcr7-system-note" data-testid="restraint-note">
          {entry.note}
        </p>
      );
  }
}
