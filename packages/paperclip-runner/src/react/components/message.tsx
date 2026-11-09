import * as React from "react";

import type { SessionItemSnapshot } from "../../reducer/session-reducer.js";
import type { TranscriptRole } from "../../browser/transcript-model.js";
import { Badge } from "./badge.js";

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

interface StructuredResponse {
  summary: string;
  disposition: string | null;
  objectiveSatisfied: boolean | null;
  remainingWork: string[];
  verification: Array<{ label: string; status: string | null }>;
  raw: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sentenceCase(value: string): string {
  const spaced = value.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function parseStructuredResponse(text: string): StructuredResponse | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const raw = record(JSON.parse(trimmed));
    const summary = stringValue(raw.summary);
    if (summary === null) return null;
    const claim = record(raw.completionClaim);
    const remainingWork = Array.isArray(claim.remainingWork)
      ? claim.remainingWork
        .map((entry) => stringValue(entry) ?? stringValue(record(entry).summary) ?? stringValue(record(entry).description))
        .filter((entry): entry is string => entry !== null)
      : [];
    const verification = Array.isArray(raw.verification)
      ? raw.verification.flatMap((entry) => {
        const current = record(entry);
        const label = stringValue(current.commandOrCheck) ?? stringValue(current.summary);
        return label === null ? [] : [{ label, status: stringValue(current.status) }];
      })
      : [];
    return {
      summary,
      disposition: stringValue(raw.reportedWorkDisposition),
      objectiveSatisfied: typeof claim.objectiveSatisfied === "boolean" ? claim.objectiveSatisfied : null,
      remainingWork,
      verification,
      raw,
    };
  } catch {
    return null;
  }
}

function useProgressiveText(text: string, streaming: boolean): { text: string; active: boolean } {
  const progressiveRef = React.useRef(streaming);
  if (streaming) progressiveRef.current = true;
  const targetRef = React.useRef(text);
  targetRef.current = text;
  const [displayed, setDisplayed] = React.useState(() => streaming ? "" : text);

  React.useEffect(() => {
    if (!targetRef.current.startsWith(displayed)) {
      setDisplayed(streaming ? "" : targetRef.current);
    }
  }, [displayed, streaming, text]);

  React.useEffect(() => {
    if (!progressiveRef.current) {
      setDisplayed(targetRef.current);
      return undefined;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true) {
      setDisplayed(targetRef.current);
      return undefined;
    }
    const timer = window.setInterval(() => {
      setDisplayed((current) => {
        const target = targetRef.current;
        if (!target.startsWith(current)) return target;
        if (current.length >= target.length) return current;
        return target.slice(0, current.length + 1);
      });
    }, 12);
    return () => window.clearInterval(timer);
  }, []);

  return { text: displayed, active: streaming || displayed.length < text.length };
}

function StructuredResponseBody({ response }: { response: StructuredResponse }) {
  const positive = response.objectiveSatisfied === true || response.disposition === "done";
  const hasCompletionDetails = response.verification.length > 0 || response.remainingWork.length > 0;
  return (
    <div className="pcr-response" data-slot="structured-response" data-testid="structured-response">
      <div className="pcr-response-heading">
        <div>
          <p className="pcr-eyebrow">Agent response</p>
          <p className="pcr-response-summary">{response.summary}</p>
        </div>
        {response.disposition === null ? null : (
          <Badge tone={positive ? "success" : "accent"}>{sentenceCase(response.disposition)}</Badge>
        )}
      </div>
      <details className="pcr-response-details">
        <summary>Completion details</summary>
        <div className="pcr-response-details-body">
          {response.verification.length === 0 ? null : (
            <div className="pcr-response-section">
              <p className="pcr-response-label">Checks</p>
              <ul className="pcr-response-checks">
                {response.verification.map((entry, index) => (
                  <li key={`${entry.label}:${index}`}>
                    <span aria-hidden="true">{entry.status === "passed" ? "✓" : "•"}</span>
                    <span>{entry.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {response.remainingWork.length === 0 ? null : (
            <div className="pcr-response-section">
              <p className="pcr-response-label">Remaining</p>
              <ul className="pcr-response-list">
                {response.remainingWork.map((entry, index) => <li key={`${entry}:${index}`}>{entry}</li>)}
              </ul>
            </div>
          )}
          {hasCompletionDetails ? null : <p className="pcr-response-empty-detail">No additional completion notes.</p>}
          <details className="pcr-response-debug">
            <summary>Raw protocol payload</summary>
            <pre className="pcr-payload">{JSON.stringify(response.raw, null, 2)}</pre>
          </details>
        </div>
      </details>
    </div>
  );
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
  const structured = role === "assistant" && item !== undefined && !streaming
    ? parseStructuredResponse(item.text)
    : null;
  const body = item === undefined
    ? (children ?? text ?? "")
    : (renderItemBody?.(item) ?? (structured === null
      ? <MessageText text={item.text} streaming={streaming} />
      : <StructuredResponseBody response={structured} />));
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
  const progressive = useProgressiveText(text, streaming);
  return (
    <p className="pcr-message-text">
      {progressive.text}
      {progressive.active ? <span className="pcr-stream-cursor" aria-hidden="true" /> : null}
    </p>
  );
}
