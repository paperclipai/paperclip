import * as React from "react";

import type { PrpEvent } from "../../../../src/protocol/replay-contract";
import type { SessionSnapshot } from "../../../../src/reducer/session-reducer";
import { Badge } from "../components/ui/badge";
import { Tabs } from "../components/ui/tabs";
import type { LiveConnectionStatus, LiveSessionState } from "./protocol";
import { capabilityRows } from "./transcript-model";

const TABS = [
  { id: "events", label: "Events" },
  { id: "requests", label: "Requests" },
  { id: "capabilities", label: "Capabilities" },
  { id: "session", label: "Session" },
];

function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      className="ui-copy"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * The debugging surface. Redaction is the server's job: the inspector renders
 * redaction markers verbatim and never tries to reconstruct a redacted value.
 */
export function Inspector({
  events,
  snapshot,
  state,
  connection,
  reconnectAttempt,
  replayParity,
  highlightItemId,
  onHighlightItem,
}: {
  events: readonly PrpEvent[];
  snapshot: SessionSnapshot | null;
  state: LiveSessionState | null;
  connection: LiveConnectionStatus;
  reconnectAttempt: number;
  replayParity: boolean | null;
  highlightItemId: string | null;
  onHighlightItem: (itemId: string | null) => void;
}) {
  const [tab, setTab] = React.useState("events");
  const [filter, setFilter] = React.useState("");
  const [facet, setFacet] = React.useState<string | null>(null);

  const facets = React.useMemo(
    () => [...new Set(events.map((event) => event.eventType))].sort(),
    [events],
  );

  const visible = React.useMemo(
    () =>
      events.filter((event) => {
        if (facet !== null && event.eventType !== facet) return false;
        if (filter.length === 0) return true;
        return JSON.stringify(event).toLowerCase().includes(filter.toLowerCase());
      }),
    [events, facet, filter],
  );

  return (
    <Tabs tabs={TABS} value={tab} onValueChange={setTab} label="Protocol inspector">
      {tab === "events" ? (
        <div className="ui-inspector-events">
          <label className="ui-visually-hidden" htmlFor="inspector-filter">
            Filter events
          </label>
          <input
            id="inspector-filter"
            className="ui-inspector-filter"
            data-testid="inspector-filter"
            placeholder="Filter events"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <div className="ui-facets">
            <button
              type="button"
              className="ui-facet"
              aria-pressed={facet === null}
              onClick={() => setFacet(null)}
            >
              All
            </button>
            {facets.map((candidate) => (
              <button
                key={candidate}
                type="button"
                className="ui-facet"
                aria-pressed={facet === candidate}
                onClick={() => setFacet(candidate)}
              >
                {candidate}
              </button>
            ))}
          </div>
          <ol className="ui-inspector-list" data-testid="inspector-events">
            {visible.map((event) => (
              <li
                key={event.sourceEventId}
                data-highlighted={
                  highlightItemId !== null && event.itemId === highlightItemId
                }
              >
                <details
                  onToggle={(toggle) =>
                    onHighlightItem(
                      (toggle.currentTarget as HTMLDetailsElement).open
                        ? (event.itemId ?? null)
                        : null,
                    )
                  }
                >
                  <summary className="ui-inspector-row">
                    <code className="ui-seq">{event.sourceSeq}</code>
                    <code>{event.eventType}</code>
                    <code className="ui-inspector-id">{event.itemId ?? event.turnId ?? "—"}</code>
                  </summary>
                  <pre className="ui-payload">{JSON.stringify(event, null, 2)}</pre>
                  <CopyButton
                    label={`Copy event ${event.sourceSeq} payload`}
                    value={JSON.stringify(event, null, 2)}
                  />
                </details>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {tab === "requests" ? (
        <dl className="ui-inspector-grid" data-testid="inspector-requests">
          {(snapshot?.requests ?? []).map((request) => (
            <div key={request.requestId}>
              <dt>
                <code>{request.requestId}</code>
              </dt>
              <dd>
                {request.type} — {request.status}
              </dd>
            </div>
          ))}
          {(snapshot?.requests.length ?? 0) === 0 ? <p>No runtime requests yet.</p> : null}
        </dl>
      ) : null}

      {tab === "capabilities" ? (
        <ul className="ui-capability-list" data-testid="inspector-capabilities">
          {capabilityRows(state?.capabilities ?? { resume: false, typedEvents: false, steering: false, interruption: false, structuredResult: false }).map(
            (row) => (
              <li key={row.name}>
                <span>{row.name}</span>
                <Badge tone={row.supported ? "success" : "warning"}>
                  {row.supported ? "supported" : "unsupported"}
                </Badge>
                {row.diagnostic === null ? null : (
                  <p className="ui-capability-diagnostic">{row.diagnostic}</p>
                )}
              </li>
            ),
          )}
        </ul>
      ) : null}

      {tab === "session" ? (
        <dl className="ui-inspector-grid" data-testid="inspector-session">
          <div>
            <dt>Run</dt>
            <dd>{state?.runId ?? "—"}</dd>
          </div>
          <div>
            <dt>Normalized session</dt>
            <dd>{state?.normalizedSessionId ?? "—"}</dd>
          </div>
          <div>
            <dt>Driver session</dt>
            <dd>{state?.driverSession.driverSessionId ?? "—"}</dd>
          </div>
          <div>
            <dt>Source cursors</dt>
            <dd>{JSON.stringify(snapshot?.sourceCursors ?? {})}</dd>
          </div>
          <div>
            <dt>Integrity</dt>
            <dd>{snapshot?.integrity ?? "—"}</dd>
          </div>
          <div>
            <dt>Gaps</dt>
            <dd>{snapshot?.gaps.length ?? 0}</dd>
          </div>
          <div>
            <dt>Connection</dt>
            <dd>
              {connection}
              {connection === "reconnecting" ? ` (attempt ${reconnectAttempt})` : ""}
            </dd>
          </div>
          <div>
            <dt>Credentials in browser</dt>
            <dd>{state?.credentialsExposed === true ? "yes" : "no"}</dd>
          </div>
          <div>
            <dt>Live and replay reducer</dt>
            <dd data-testid="replay-parity">
              {replayParity === null ? "not compared yet" : replayParity ? "match" : "mismatch"}
            </dd>
          </div>
        </dl>
      ) : null}
    </Tabs>
  );
}
