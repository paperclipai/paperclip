import { useEffect, useRef, type ReactNode } from "react";

import type {
  CapabilityEvidenceModel,
  CapabilityEvidenceRunnerRecord,
  CapabilityEvidenceSectionId,
  CapabilityIssueThreadSnapshot,
  CapabilityToolDisposition,
} from "../../../src/issue-thread/types";
import {
  CAPABILITY_EVIDENCE_SECTIONS,
  capabilityDispositionLabel,
} from "../../../src/issue-thread/types";

/**
 * Evidence panel (contract §7): eight accordion sections in fixed order with a
 * turn selector. Every record is rendered from the snapshot; the panel derives
 * no verdicts of its own.
 */

const DISPOSITION_ORDER: CapabilityToolDisposition[] = [
  "always_agent_tool",
  "optional_agent_tool",
  "control_plane_owned",
];

export interface CapabilityRunnerEventGroup {
  id: string;
  event: string | null;
  records: CapabilityEvidenceRunnerRecord[];
}

/**
 * Stream deltas are useful evidence but terrible default reading material.
 * Aggregate each sanitized delta category within a turn at its first position;
 * expanding the group still exposes every individual event in ordinal order.
 */
export function groupCapabilityRunnerEvents(
  records: readonly CapabilityEvidenceRunnerRecord[],
): CapabilityRunnerEventGroup[] {
  const groups: CapabilityRunnerEventGroup[] = [];
  const deltaGroups = new Map<string, CapabilityRunnerEventGroup>();
  for (const record of records) {
    const event = record.details.find((entry) => entry.label === "Event")?.value ?? null;
    if (event === null || !event.endsWith("_delta")) {
      groups.push({ id: record.id, event: null, records: [record] });
      continue;
    }
    const key = `${record.turnId}:${event}`;
    const existing = deltaGroups.get(key);
    if (existing !== undefined) {
      existing.records.push(record);
      continue;
    }
    const group = { id: `delta:${key}`, event, records: [record] };
    deltaGroups.set(key, group);
    groups.push(group);
  }
  return groups;
}

function RunnerEvent({ record }: { record: CapabilityEvidenceRunnerRecord }) {
  return (
    <details className="pit-runner-event" data-record-id={record.id}>
      <summary className="pit-runner-event-summary">
        <span className="pit-record-title">#{record.ordinal} {record.kind}</span>
        <span className="pit-record-detail">{record.detail}</span>
        <span className="pit-activity-caret" aria-hidden="true">›</span>
      </summary>
      <dl className="pit-runner-event-details">
        {record.details.length === 0 ? (
          <>
            <dt>Detail</dt>
            <dd>No additional sanitized fields were retained.</dd>
          </>
        ) : (
          record.details.map((entry, index) => (
            <div key={`${entry.label}:${index}`}>
              <dt>{entry.label}</dt>
              <dd>{entry.value}</dd>
            </div>
          ))
        )}
      </dl>
    </details>
  );
}

function RunnerEventGroup({ group }: { group: CapabilityRunnerEventGroup }) {
  if (group.event === null) return <RunnerEvent record={group.records[0]!} />;
  return (
    <details className="pit-runner-group" data-runner-delta-group={group.event}>
      <summary className="pit-runner-group-summary">
        <span className="pit-activity-caret" aria-hidden="true">›</span>
        <span className="pit-record-title">{group.event}</span>
        <span className="pit-record-detail">
          {group.records.length} streamed update{group.records.length === 1 ? "" : "s"}
        </span>
      </summary>
      <div className="pit-runner-group-events">
        {group.records.map((record) => <RunnerEvent key={record.id} record={record} />)}
      </div>
    </details>
  );
}

export interface EvidencePanelProps {
  snapshot: CapabilityIssueThreadSnapshot;
  layout: "side" | "overlay" | "segment";
  width: number;
  selectedTurnId: string | "all";
  openSections: CapabilityEvidenceSectionId[];
  highlightedRecordId: string | null;
  onSelectTurn: (turnId: string | "all") => void;
  onToggleSection: (section: CapabilityEvidenceSectionId) => void;
  onClose: () => void;
  onJumpToThread: (anchorId: string) => void;
}

function sectionCount(
  evidence: CapabilityEvidenceModel,
  section: CapabilityEvidenceSectionId,
  turnId: string | "all",
): string {
  if (section === "parity") {
    const rows = filterByTurn(evidence.parity, turnId);
    const passing = rows.filter((row) => row.verdict === "pass").length;
    return `${passing}/${rows.length}`;
  }
  const rows = filterByTurn(
    evidence[section] as ReadonlyArray<{ turnId: string }>,
    turnId,
  );
  return String(rows.length);
}

function filterByTurn<T extends { turnId: string }>(
  rows: ReadonlyArray<T>,
  turnId: string | "all",
): T[] {
  return turnId === "all" ? [...rows] : rows.filter((row) => row.turnId === turnId);
}

function Section({
  id,
  title,
  count,
  open,
  onToggle,
  children,
}: {
  id: CapabilityEvidenceSectionId;
  title: string;
  count: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="pit-section" data-evidence-section={id}>
      <h3>
        <button
          type="button"
          className="pit-section-button"
          aria-expanded={open}
          aria-controls={`evidence-section-${id}`}
          onClick={onToggle}
        >
          <span aria-hidden="true">{open ? "⌄" : "›"}</span>
          {title}
          <span className="pit-section-count">{count}</span>
        </button>
      </h3>
      <div className="pit-section-body" id={`evidence-section-${id}`} hidden={!open}>
        {children}
      </div>
    </section>
  );
}

export function EvidencePanel(props: EvidencePanelProps) {
  const {
    snapshot,
    layout,
    width,
    selectedTurnId,
    openSections,
    highlightedRecordId,
    onSelectTurn,
    onToggleSection,
    onClose,
    onJumpToThread,
  } = props;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const evidence = snapshot.evidence;

  useEffect(() => {
    // Contract §9.2: opening Evidence moves focus to its heading.
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    // Contract §9.1: Escape closes the desktop overlay sheet. The side panel is
    // a persistent region rather than a sheet, and the mobile segment is a tab
    // view, so neither of those is dismissible this way.
    if (layout !== "overlay") return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // A modal dialog owns Escape while it is open (§6 reset confirm).
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return;
      onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [layout, onClose]);

  const isOpen = (section: CapabilityEvidenceSectionId) => openSections.includes(section);

  return (
    <aside
      className="pit-panel"
      data-layout={layout}
      data-testid="evidence-panel"
      style={layout === "side" ? { width: `${width}px` } : undefined}
      aria-label="Evidence"
    >
      <div className="pit-panel-head">
        <div className="pit-header-controls">
          <h2 className="pit-panel-title" tabIndex={-1} ref={headingRef}>
            Evidence
          </h2>
          <button type="button" className="pit-button" onClick={onClose}>
            Close
          </button>
        </div>
        <label className="pit-card-meta" htmlFor="evidence-turn-selector">
          Turn
        </label>
        <select
          className="pit-select"
          id="evidence-turn-selector"
          value={selectedTurnId}
          onChange={(event) => onSelectTurn(event.target.value as string | "all")}
        >
          {snapshot.turns.map((turn) => (
            <option key={turn.id} value={turn.id}>
              Turn {turn.ordinal}
            </option>
          ))}
          <option value="all">All turns</option>
        </select>
      </div>

      <Section
        id="tools"
        title="Tools exposed"
        count={sectionCount(evidence, "tools", selectedTurnId)}
        open={isOpen("tools")}
        onToggle={() => onToggleSection("tools")}
      >
        {filterByTurn(evidence.tools, selectedTurnId).map((record) => (
          <div key={record.id}>
            {DISPOSITION_ORDER.map((disposition) => {
              const rows = record.rows.filter((row) => row.disposition === disposition);
              if (rows.length === 0) return null;
              return (
                <div key={disposition}>
                  <p className="pit-tool-group-label" data-group={disposition}>
                    {disposition === "control_plane_owned"
                      ? "Control plane (not exposed to the agent)"
                      : capabilityDispositionLabel(disposition)}
                  </p>
                  {rows.map((row) => (
                    <p
                      className="pit-tool-row"
                      key={row.operationId}
                      data-disposition={disposition}
                    >
                      <span className="pit-record-title">{row.operationId}</span>
                      {row.grant !== null && disposition === "optional_agent_tool" ? (
                        <span className="pit-grant">{row.grant}</span>
                      ) : null}
                    </p>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </Section>

      <Section
        id="calls"
        title="Calls & results"
        count={sectionCount(evidence, "calls", selectedTurnId)}
        open={isOpen("calls")}
        onToggle={() => onToggleSection("calls")}
      >
        {filterByTurn(evidence.calls, selectedTurnId).map((record) => (
          <div
            className="pit-record"
            key={record.id}
            data-record-id={record.id}
            data-highlighted={highlightedRecordId === record.id}
          >
            <span className="pit-record-title">
              {record.operationId} · v{record.version} · {record.outcome}
            </span>
            <span className="pit-record-detail">{record.providerRequest}</span>
            <span className="pit-record-detail">{record.dispatchedCommand}</span>
            <span className="pit-record-detail">{JSON.stringify(record.result)}</span>
            {record.redactions.length > 0 ? (
              <span className="pit-record-detail">
                ••• redacted by {record.redactions.join(", ")}
              </span>
            ) : null}
            <button
              type="button"
              className="pit-link-button"
              onClick={() => onJumpToThread(record.threadAnchorId)}
            >
              Show in thread
            </button>
          </div>
        ))}
      </Section>

      <Section
        id="authorization"
        title="Authorization"
        count={sectionCount(evidence, "authorization", selectedTurnId)}
        open={isOpen("authorization")}
        onToggle={() => onToggleSection("authorization")}
      >
        {filterByTurn(evidence.authorization, selectedTurnId).map((record) => (
          <div
            className="pit-record"
            key={record.id}
            data-record-id={record.id}
            data-allowed={record.allowed}
            data-highlighted={highlightedRecordId === record.id}
          >
            <span className="pit-record-title">
              <span aria-hidden="true">{record.allowed ? "✓" : "✕"}</span>{" "}
              {record.operationId} · {record.phase} · {record.allowed ? "allowed" : "denied"}
            </span>
            <span className="pit-record-detail">{record.reason}</span>
            <span className="pit-record-detail">
              claims: {record.claimsConsidered.join(", ") || "none"}
            </span>
            {record.redactions.length > 0 ? (
              <span className="pit-record-detail">
                ••• redacted by {record.redactions.join(", ")}
              </span>
            ) : null}
            {record.stateChangeRef !== null ? (
              <span className="pit-record-detail">state: {record.stateChangeRef}</span>
            ) : null}
            {record.threadAnchorId.length > 0 ? (
              <button
                type="button"
                className="pit-link-button"
                onClick={() => onJumpToThread(record.threadAnchorId)}
              >
                Show in thread
              </button>
            ) : null}
          </div>
        ))}
      </Section>

      <Section
        id="control_plane"
        title="Control plane"
        count={sectionCount(evidence, "control_plane", selectedTurnId)}
        open={isOpen("control_plane")}
        onToggle={() => onToggleSection("control_plane")}
      >
        {filterByTurn(evidence.control_plane, selectedTurnId).map((record) => (
          <div
            className="pit-record"
            key={record.id}
            data-record-id={record.id}
            data-highlighted={highlightedRecordId === record.id}
          >
            <span className="pit-record-title">
              {record.category} · {record.outcome} · rev {record.stateRevision}
            </span>
            <span className="pit-record-detail">{record.reason}</span>
          </div>
        ))}
      </Section>

      <Section
        id="runner"
        title="Runner & events"
        count={sectionCount(evidence, "runner", selectedTurnId)}
        open={isOpen("runner")}
        onToggle={() => onToggleSection("runner")}
      >
        {groupCapabilityRunnerEvents(filterByTurn(evidence.runner, selectedTurnId)).map((group) => (
          <RunnerEventGroup key={group.id} group={group} />
        ))}
      </Section>

      <Section
        id="state"
        title="State diff"
        count={sectionCount(evidence, "state", selectedTurnId)}
        open={isOpen("state")}
        onToggle={() => onToggleSection("state")}
      >
        {filterByTurn(evidence.state, selectedTurnId).map((record) => (
          <div
            className="pit-record"
            key={record.id}
            data-record-id={record.id}
            data-highlighted={highlightedRecordId === record.id}
          >
            <span className="pit-record-title">
              revision {record.fromRevision} → {record.toRevision}
            </span>
            {record.rows.map((row) => (
              <div className="pit-diff-row" key={`${row.entityClass}-${row.entityRef}`}>
                <span className="pit-record-detail">
                  {row.entityClass} · {row.entityRef}
                </span>
                <span className="pit-record-detail">
                  {row.before} → {row.after}
                </span>
              </div>
            ))}
          </div>
        ))}
      </Section>

      <Section
        id="traceability"
        title="Traceability"
        count={sectionCount(evidence, "traceability", selectedTurnId)}
        open={isOpen("traceability")}
        onToggle={() => onToggleSection("traceability")}
      >
        {filterByTurn(evidence.traceability, selectedTurnId).map((record) => (
          <div className="pit-record" key={record.id} data-record-id={record.id}>
            <span className="pit-record-title">
              {record.caseId} · {record.group}
            </span>
            <span className="pit-record-detail">{record.sourceAnchor}</span>
            <span className="pit-record-detail">{record.browserEvidenceRecipe}</span>
            <span className="pit-record-detail">
              expects: {record.expectedSemanticOperations.join(", ")}
            </span>
            <span className="pit-record-detail">
              forbids: {record.forbiddenOperations.join(", ") || "none"}
            </span>
            <span className="pit-record-detail">
              grants: {record.requiredCapabilityGrants.join(", ") || "none"}
            </span>
          </div>
        ))}
      </Section>

      <Section
        id="parity"
        title="Parity"
        count={sectionCount(evidence, "parity", selectedTurnId)}
        open={isOpen("parity")}
        onToggle={() => onToggleSection("parity")}
      >
        {filterByTurn(evidence.parity, selectedTurnId).map((record) => (
          <div className="pit-record" key={record.id} data-record-id={record.id}>
            <span className="pit-verdict" data-verdict={record.verdict}>
              <span aria-hidden="true">
                {record.verdict === "pass" ? "✓" : record.verdict === "fail" ? "✕" : "—"}
              </span>
              {record.verdict === "intentional_gap" ? "intentional gap" : record.verdict}
            </span>
            <span className="pit-record-detail">{record.assertion}</span>
            {record.note !== null ? (
              <span className="pit-record-detail">{record.note}</span>
            ) : null}
          </div>
        ))}
      </Section>
    </aside>
  );
}

export const CAPABILITY_EVIDENCE_SECTION_IDS = CAPABILITY_EVIDENCE_SECTIONS.map(
  (section) => section.id,
);
