import * as React from "react";

import { Badge } from "@paperclipai/paperclip-runner/react";
import type {
  CapabilityChatSessionArtifact,
  CapabilityChatTurn,
  CapabilityTimelineEntry,
} from "@paperclip-runner-local/capability";

import { CHANGE_ICON, CHANGE_LABEL } from "../labels.js";
import {
  AuthorizationPanel,
  ExposureList,
  ParityPanel,
} from "./inspector-panels.js";
import { EmptyState, Mono } from "./primitives.js";
import { TimelineEntryBody } from "./scenario-transcript.js";
import { summaryText } from "./chat-turn-strip.js";
import {
  CAPABILITY_ACTIVITY_FILTERS,
  type CapabilityActivityFilter,
} from "../route.js";

/**
 * Activity stream (scenario-chat map §4).
 *
 * The per-turn evidence, grouped by turn and ordered exactly as the map
 * specifies: exposure, calls, authorization, control plane, state diff, parity.
 * Mobile gets all of it — a summary-only small screen would drop the evidence
 * this activity surface exists to show.
 *
 * A filter collapses non-matching sections rather than deleting groups, so the
 * turn skeleton stays scannable and the route stays honest about what is on
 * screen.
 */

const FILTER_LABEL: Record<CapabilityActivityFilter, string> = {
  all: "All",
  tools: "Tools",
  authorization: "Authorization",
  control: "Control plane",
  diff: "Diffs",
  parity: "Parity",
};

type SectionName = "exposure" | "calls" | "authorization" | "control" | "diff" | "parity";

const SECTION_FILTER: Record<SectionName, CapabilityActivityFilter> = {
  exposure: "tools",
  calls: "tools",
  authorization: "authorization",
  control: "control",
  diff: "diff",
  parity: "parity",
};

export function ActivityStream({
  artifact,
  revealedSequence = Number.MAX_SAFE_INTEGER,
  filter,
  onFilterChange,
  openTurn,
  onOpenTurn,
  onBackToChat,
  showBackToChat,
}: {
  artifact: CapabilityChatSessionArtifact;
  /** The same inclusive timeline ceiling used by the conversation. */
  revealedSequence?: number;
  filter: CapabilityActivityFilter;
  onFilterChange: (filter: CapabilityActivityFilter) => void;
  openTurn: number | null;
  onOpenTurn: (turn: number) => void;
  onBackToChat: (turn: number) => void;
  showBackToChat: boolean;
}) {
  const newest = artifact.turns[artifact.turns.length - 1]?.turn ?? 0;
  return (
    <div className="pcr7-activity" data-testid="activity-stream">
      <div className="pcr7-activity-filters" role="group" aria-label="Activity filter">
        {CAPABILITY_ACTIVITY_FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            className="pcr7-chip"
            aria-pressed={filter === value}
            data-testid={`activity-filter-${value}`}
            onClick={() => onFilterChange(value)}
          >
            {FILTER_LABEL[value]}
          </button>
        ))}
      </div>

      {artifact.turns.map((turn) => {
        const running = turn.lastSequence > revealedSequence;
        return (
          <ActivityTurnGroup
            key={turn.turn}
            turn={turn}
            entries={artifact.timeline.filter(
              (entry) => entry.turn === turn.turn && entry.sequence <= revealedSequence,
            )}
            running={running}
            filter={filter}
            open={openTurn === null ? turn.turn === newest : openTurn === turn.turn}
            onToggle={() => onOpenTurn(turn.turn)}
            onBackToChat={onBackToChat}
            showBackToChat={showBackToChat}
          />
        );
      })}

      {artifact.turns.some((turn) => turn.lastSequence > revealedSequence) ? null : (
        <SessionGroup artifact={artifact} filter={filter} />
      )}
    </div>
  );
}

export function ActivityTurnGroup({
  turn,
  entries,
  running,
  filter,
  open,
  onToggle,
  onBackToChat,
  showBackToChat,
}: {
  turn: CapabilityChatTurn;
  entries: readonly CapabilityTimelineEntry[];
  running: boolean;
  filter: CapabilityActivityFilter;
  open: boolean;
  onToggle: () => void;
  onBackToChat: (turn: number) => void;
  showBackToChat: boolean;
}) {
  const calls = entries.filter(
    (entry) => entry.kind === "semantic_call" || entry.kind === "semantic_result",
  );
  const controlPlane = entries.filter((entry) => entry.kind === "control_plane_action");
  const authorizationSequences = new Set(
    entries.flatMap((entry) =>
      entry.kind === "semantic_call" || entry.kind === "semantic_result"
        ? [entry.authorizationSequence]
        : [],
    ),
  );
  const authorizationRecords = running
    ? turn.authorizationRecords.filter((record) => authorizationSequences.has(record.sequence))
    : turn.authorizationRecords;
  const visibleCounts = running
    ? {
        calls: entries.filter((entry) => entry.kind === "semantic_call").length,
        denied: entries.filter(
          (entry) =>
            entry.kind === "semantic_result" &&
            (entry.outcome === "denied" || entry.outcome === "absent"),
        ).length,
        controlPlane: controlPlane.length,
        changedDomains: 0,
      }
    : turn.counts;
  const visibleTurn = running ? { ...turn, counts: visibleCounts } : turn;
  const visible = (section: SectionName): boolean =>
    filter === "all" || SECTION_FILTER[section] === filter;

  return (
    <section
      className="pcr7-activity-group"
      data-testid={`activity-turn-${turn.turn}`}
      data-open={open}
      id={`activity-turn-${turn.turn}`}
    >
      <h3>
        <button
          type="button"
          className="pcr7-activity-group-header"
          aria-expanded={open}
          aria-controls={`activity-turn-body-${turn.turn}`}
          data-testid={`activity-turn-header-${turn.turn}`}
          onClick={onToggle}
        >
          <span>
            {turn.turn === 0 ? "Session seed" : `Turn ${turn.turn}${running ? " · running" : ""}`}
          </span>
          <span className="pcr7-muted">
            {running ? runningSummary(visibleCounts) : summaryText(visibleTurn)}
          </span>
        </button>
      </h3>
      {open ? (
        <div className="pcr7-activity-group-body" id={`activity-turn-body-${turn.turn}`}>
          {turn.prompt === null ? null : (
            <p className="pcr7-activity-prompt">
              <span className="pcr7-label pcr7-block">Prompt</span>
              {turn.prompt}
            </p>
          )}

          {visible("exposure") ? (
            <Section name="exposure" turn={turn.turn} title="Exposed tools">
              <p className="pcr7-muted">
                Always {turn.exposure.always.length} · Optional {turn.exposure.optional.length} ·
                Control plane — no tool {turn.exposure.controlPlane.length}
              </p>
              <details className="pcr7-facet">
                <summary className="pcr7-facet-summary">Full exposure decision</summary>
                <ExposureList exposure={turn.exposure} />
              </details>
            </Section>
          ) : null}

          {visible("calls") && calls.length > 0 ? (
            <Section name="calls" turn={turn.turn} title={`Calls and results (${calls.length})`}>
              <ol className="pcr7-activity-calls">
                {calls.map((entry) => (
                  <li key={entry.sequence} data-testid={`activity-call-${entry.sequence}`}>
                    <TimelineEntryBody entry={entry} />
                  </li>
                ))}
              </ol>
            </Section>
          ) : null}

          {visible("authorization") && authorizationRecords.length > 0 ? (
            <Section
              name="authorization"
              turn={turn.turn}
              title={`Authorization (${authorizationRecords.length})`}
            >
              <AuthorizationPanel records={authorizationRecords} />
            </Section>
          ) : null}

          {visible("control") && controlPlane.length > 0 ? (
            <Section
              name="control"
              turn={turn.turn}
              title={`Control plane (${controlPlane.length})`}
            >
              <ol className="pcr7-activity-calls">
                {controlPlane.map((entry) => (
                  <li key={entry.sequence} data-testid={`activity-control-${entry.sequence}`}>
                    <TimelineEntryBody entry={entry} />
                  </li>
                ))}
              </ol>
            </Section>
          ) : null}

          {visible("diff") && !running ? (
            <Section name="diff" turn={turn.turn} title="State diff">
              <TurnDiff turn={turn} />
            </Section>
          ) : null}

          {visible("parity") && !running ? (
            <Section name="parity" turn={turn.turn} title="Parity">
              <span className="pcr7-visually-hidden" data-testid={`activity-parity-${turn.turn}`}>
                Turn {turn.turn} parity {turn.parity.verdict.replace("_", " ")}
              </span>
              <ParityPanel parity={turn.parity} />
            </Section>
          ) : null}

          {showBackToChat ? (
            <button
              type="button"
              className="pcr7-linkish"
              data-testid={`activity-back-to-chat-${turn.turn}`}
              onClick={() => onBackToChat(turn.turn)}
            >
              Back to chat
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function runningSummary(counts: CapabilityChatTurn["counts"]): string {
  const tools = counts.calls === 1 ? "tool" : "tools";
  return `${counts.calls} ${tools}, ${counts.denied} denied, ${counts.controlPlane} control plane`;
}

function Section({
  name,
  turn,
  title,
  children,
}: {
  name: SectionName;
  turn: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="pcr7-activity-section"
      data-testid={`activity-section-${turn}-${name}`}
      aria-label={`${title} — turn ${turn}`}
    >
      <h4 className="pcr7-label">{title}</h4>
      {children}
    </section>
  );
}

/**
 * The per-turn diff. Unchanged domains collapse to one muted row on purpose:
 * "nothing else moved" is evidence, and printing ten empty domains would bury
 * the one that did.
 */
function TurnDiff({ turn }: { turn: CapabilityChatTurn }) {
  const changed = turn.diff.domains.filter((domain) => domain.changed);
  const unchanged = turn.diff.domains.filter((domain) => !domain.changed);
  return (
    <div data-testid={`activity-diff-${turn.turn}`}>
      <p className="pcr7-muted">
        Revision {turn.diff.beforeRevision} → {turn.diff.afterRevision}
      </p>
      {changed.length === 0 ? (
        <p className="pcr7-muted" data-testid={`activity-diff-unchanged-${turn.turn}`}>
          No control-plane state changed in this turn.
        </p>
      ) : (
        changed.map((domain) => (
          <section key={domain.domain} className="pcr7-diff-domain">
            <h5 className="pcr7-label">
              {domain.domain} — {domain.summary}
            </h5>
            <ul className="pcr7-exposure">
              {domain.rows.map((row) => (
                <li key={`${domain.domain}-${row.entityId}`}>
                  <span aria-hidden="true">{CHANGE_ICON[row.change]}</span>{" "}
                  {CHANGE_LABEL[row.change]} <Mono>{row.entityId}</Mono>
                  <ul className="pcr7-exposure">
                    {row.fields.map((field) => (
                      <li key={field.field}>
                        <Mono>{field.field}</Mono>: <Mono>{field.before ?? "—"}</Mono> →{" "}
                        <Mono>{field.after ?? "—"}</Mono>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {unchanged.length === 0 ? null : (
        <p className="pcr7-muted" data-testid={`activity-diff-unchanged-list-${turn.turn}`}>
          Unchanged: {unchanged.map((domain) => domain.domain).join(", ")}
        </p>
      )}
      {turn.reconciliationEvents.length === 0 ? null : (
        <ul className="pcr7-exposure" data-testid={`activity-reconciliation-${turn.turn}`}>
          {turn.reconciliationEvents.map((event) => (
            <li key={event.sequence}>
              <Badge tone="neutral">Control plane</Badge> <Mono>{event.action}</Mono> —{" "}
              {event.summary}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The session footer group: what the whole conversation changed, the session
 * verdict, and — when the correct behaviour was absence — the restraint note,
 * so "nothing happened" still reads as a deliberate result.
 */
function SessionGroup({
  artifact,
  filter,
}: {
  artifact: CapabilityChatSessionArtifact;
  filter: CapabilityActivityFilter;
}) {
  const restraint = artifact.timeline.find((entry) => entry.kind === "system_note");
  const changed = artifact.diff.domains.filter((domain) => domain.changed);
  return (
    <section className="pcr7-activity-group" data-testid="activity-session" data-open="true">
      <h3 className="pcr7-activity-group-title">Session</h3>
      <div className="pcr7-activity-group-body">
        {filter === "all" || filter === "diff" ? (
          <section className="pcr7-activity-section" data-testid="activity-session-diff">
            <h4 className="pcr7-label">Cumulative diff against the seed</h4>
            {changed.length === 0 ? (
              <p className="pcr7-muted">No control-plane state changed in this session.</p>
            ) : (
              <ul className="pcr7-exposure">
                {changed.map((domain) => (
                  <li key={domain.domain}>
                    <Mono>{domain.domain}</Mono> — {domain.summary}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {filter === "all" || filter === "parity" ? (
          <section className="pcr7-activity-section" data-testid="activity-session-parity">
            <h4 className="pcr7-label">Session parity</h4>
            <span className="pcr7-visually-hidden" data-testid="activity-session-verdict">
              Session parity {artifact.parity.verdict.replace("_", " ")}
            </span>
            <ParityPanel parity={artifact.parity} />
          </section>
        ) : null}

        {restraint?.kind === "system_note" ? (
          <p className="pcr7-system-note" data-testid="activity-restraint-note">
            {restraint.note}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** Denials the board has not opened yet, surfaced on the mobile segment chip. */
export function activityDenialCount(artifact: CapabilityChatSessionArtifact): number {
  return artifact.turns.reduce((total, turn) => total + turn.counts.denied, 0);
}

export function ActivityEmptyState() {
  return (
    <EmptyState title="Pick a scenario to start a session.">
      <p className="pcr7-muted">
        Every turn's exposure, calls, authorization decisions, control-plane actions, state diff, and
        parity verdict appear here as the conversation happens.
      </p>
    </EmptyState>
  );
}
