import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  CapabilityEvidenceModel,
  CapabilityEvidenceRunnerRecord,
  CapabilityEvidenceSectionId,
  CapabilityEvidenceToolRow,
  CapabilityIssueThreadSnapshot,
  CapabilityJsonValue,
  CapabilityToolDisposition,
} from "../../../src/issue-thread/types";
import type { CapabilityDevtoolsSnapshot } from "../../../src/devtools";
import { DevtoolsInspector, type CapabilityDevtoolsTab, type EvalInspectorReport } from "./DevtoolsInspector";
import { Icon } from "./Icons";
import { capabilitySemanticToolDescriptor } from "../../../src/semantic-tools/catalog";
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
  devtools?: CapabilityDevtoolsSnapshot | null;
  evalReport?: EvalInspectorReport | null;
  onForkRevision?: (revision: number) => void;
  layout: "side" | "overlay" | "segment";
  width: number;
  selectedTurnId: string | "all";
  openSections: CapabilityEvidenceSectionId[];
  highlightedRecordId: string | null;
  onSelectTurn: (turnId: string | "all") => void;
  onToggleSection: (section: CapabilityEvidenceSectionId) => void;
  onClose: () => void;
  onJumpToThread: (anchorId: string) => void;
  onInvokeTool?: (operationId: string, input: CapabilityJsonValue) => Promise<CapabilityJsonValue>;
}

function sectionCount(
  evidence: CapabilityEvidenceModel,
  section: CapabilityEvidenceSectionId,
  turnId: string | "all",
): string {
  if (section === "tools") {
    const records = filterByTurn(evidence.tools, turnId);
    return String(new Set(records.flatMap((record) => record.rows.map((row) => row.operationId))).size);
  }
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

function starterInput(schema: { properties?: Readonly<Record<string, { type?: string | readonly string[]; enum?: readonly CapabilityJsonValue[]; default?: CapabilityJsonValue }>>; required?: readonly string[] } | undefined): Record<string, CapabilityJsonValue> {
  const result: Record<string, CapabilityJsonValue> = {};
  for (const name of schema?.required ?? []) {
    const property = schema?.properties?.[name];
    if (property?.default !== undefined) result[name] = property.default;
    else if (property?.enum?.[0] !== undefined) result[name] = property.enum[0];
    else if (name === "idempotencyKey") result[name] = `devtools-${Date.now()}`;
    else if (property?.type === "integer" || property?.type === "number") result[name] = 0;
    else if (property?.type === "boolean") result[name] = false;
    else if (property?.type === "array") result[name] = [];
    else if (property?.type === "object") result[name] = {};
    else result[name] = "";
  }
  return result;
}

function ToolsBrowser({ records, onInvoke }: { records: CapabilityEvidenceModel["tools"]; onInvoke?: (operationId: string, input: CapabilityJsonValue) => Promise<CapabilityJsonValue> }) {
  const [collapsed, setCollapsed] = useState<CapabilityToolDisposition[]>([]);
  const [selected, setSelected] = useState<CapabilityEvidenceToolRow | null>(null);
  const [inputText, setInputText] = useState("{}");
  const [invocationResult, setInvocationResult] = useState<CapabilityJsonValue | null>(null);
  const [invocationError, setInvocationError] = useState<string | null>(null);
  const [invoking, setInvoking] = useState(false);
  const rows = useMemo(() => {
    const unique = new Map<string, CapabilityEvidenceToolRow>();
    for (const record of records) {
      for (const row of record.rows) unique.set(row.operationId, row);
    }
    return [...unique.values()];
  }, [records]);
  const descriptor = selected === null ? undefined : capabilitySemanticToolDescriptor(selected.operationId);

  useEffect(() => {
    if (selected === null) return;
    setInputText(JSON.stringify(starterInput(descriptor?.inputSchema), null, 2));
    setInvocationResult(null);
    setInvocationError(null);
  }, [descriptor, selected]);

  useEffect(() => {
    if (selected === null) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setSelected(null); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [selected]);

  return (
    <>
      <div className="pit-tool-groups">
        {DISPOSITION_ORDER.map((disposition) => {
          const group = rows.filter((row) => row.disposition === disposition);
          if (group.length === 0) return null;
          const folded = collapsed.includes(disposition);
          const title = disposition === "control_plane_owned"
            ? "Control plane (not exposed to the agent)"
            : capabilityDispositionLabel(disposition);
          return (
            <section className="pit-tool-group" data-group={disposition} key={disposition}>
              <h4>
                <button type="button" className="pit-tool-group-toggle" aria-expanded={!folded} onClick={() => setCollapsed((current) => current.includes(disposition) ? current.filter((entry) => entry !== disposition) : [...current, disposition])}>
                  <span aria-hidden="true">{folded ? "›" : "⌄"}</span>
                  <span>{title}</span>
                  <span className="pit-section-count">{group.length}</span>
                </button>
              </h4>
              {!folded ? (
                <div className="pit-tool-group-rows">
                  {group.map((row) => (
                    <button type="button" className="pit-tool-row" key={row.operationId} data-disposition={disposition} onClick={() => setSelected(row)}>
                      <span className="pit-record-title">{row.operationId}</span>
                      <span className="pit-tool-row-description">{row.description}</span>
                      {row.grant !== null && disposition === "optional_agent_tool" ? <span className="pit-grant">{row.grant}</span> : null}
                      <span className="pit-activity-caret" aria-hidden="true">›</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>

      {selected !== null ? (
        <div className="pit-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
          <div className="pit-dialog pit-tool-dialog" data-invokable={onInvoke !== undefined} role="dialog" aria-modal="true" aria-labelledby="tool-dialog-title">
            <header className="pit-tool-dialog-head">
              <div><span className="pit-card-meta">Semantic tool · v{descriptor?.version ?? 1}</span><h2 id="tool-dialog-title">{descriptor?.title ?? selected.operationId}</h2></div>
              <button type="button" className="pit-icon-button" aria-label="Close tool details" title="Close tool details" onClick={() => setSelected(null)}><Icon name="close" /></button>
            </header>
            <div className="pit-tool-dialog-grid" data-invokable={onInvoke !== undefined}>
              <div className="pit-tool-reference">
                <code className="pit-tool-operation">{selected.operationId}</code>
                <p>{descriptor?.description ?? selected.description}</p>
                <dl className="pit-tool-facts">
                  <div><dt>Placement</dt><dd>{capabilityDispositionLabel(selected.disposition)}</dd></div>
                  <div><dt>Required claims</dt><dd>{descriptor?.requiredClaims.join(", ") || selected.grant || "None"}</dd></div>
                  <div><dt>Task modes</dt><dd>{descriptor?.allowedModes.join(", ") || "—"}</dd></div>
                  <div><dt>Actor roles</dt><dd>{descriptor?.allowedRoles?.join(", ") || "Any allowed role"}</dd></div>
                </dl>
                <div>
                  <h3 className="pit-tool-schema-title">Input schema</h3>
                  <pre className="pit-code">{JSON.stringify(descriptor?.inputSchema ?? {}, null, 2)}</pre>
                </div>
              </div>
            {onInvoke !== undefined ? (
              <div className="pit-tool-tester">
                <h3 className="pit-tool-schema-title">Invoke in conversation</h3>
                <p className="pit-muted">Runs through the real semantic dispatcher and records a turn, evidence, and company-state changes.</p>
                <label className="pit-card-meta" htmlFor="tool-test-input">Parameters (JSON)</label>
                <textarea id="tool-test-input" className="pit-tool-test-input" value={inputText} onChange={(event) => setInputText(event.target.value)} spellCheck={false} />
                <button type="button" className="pit-button" disabled={invoking} onClick={() => {
                  let parsed: CapabilityJsonValue;
                  try {
                    parsed = JSON.parse(inputText) as CapabilityJsonValue;
                  } catch (error) {
                    setInvocationError(error instanceof Error ? error.message : String(error));
                    return;
                  }
                  setInvoking(true);
                  setInvocationError(null);
                  setInvocationResult(null);
                  void onInvoke(selected.operationId, parsed)
                    .then(setInvocationResult)
                    .catch((error) => setInvocationError(error instanceof Error ? error.message : String(error)))
                    .finally(() => setInvoking(false));
                }}>{invoking ? "Invoking…" : "Invoke as tool call"}</button>
                {invocationError !== null ? <p className="pit-error" role="alert">{invocationError}</p> : null}
                {invocationResult !== null ? <pre className="pit-code" data-testid="tool-test-result">{JSON.stringify(invocationResult, null, 2)}</pre> : null}
              </div>
            ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
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
  const [devtoolsTab, setDevtoolsTab] = useState<CapabilityDevtoolsTab>(props.evalReport ? "eval" : "evidence");
  const {
    snapshot,
    devtools,
    evalReport,
    onForkRevision = () => undefined,
    layout,
    width,
    selectedTurnId,
    openSections,
    highlightedRecordId,
    onSelectTurn,
    onToggleSection,
    onClose,
    onJumpToThread,
    onInvokeTool,
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
      <div className="pit-panel-chrome">
        <h2 className="pit-visually-hidden" tabIndex={-1} ref={headingRef}>Developer tools</h2>
        <span className="pit-panel-kicker"><Icon name="activity" /> Paperclip DevTools</span>
        <button type="button" className="pit-icon-button" onClick={onClose} aria-label="Close DevTools" title="Close DevTools">
          <Icon name="close" />
        </button>
      </div>

      {devtools !== undefined ? (
        <>
          {devtools === null ? (
            <p className="pit-muted pit-devtools-loading">Loading company state…</p>
          ) : (
            <DevtoolsInspector snapshot={devtools} onFork={onForkRevision} tab={devtoolsTab} onTabChange={setDevtoolsTab} evalReport={evalReport} />
          )}
        </>
      ) : null}

      {devtoolsTab === "evidence" ? <div className="pit-evidence-browser">
      <div className="pit-evidence-filter">
        <label className="pit-card-meta" htmlFor="evidence-turn-selector">Evidence scope</label>
        <select className="pit-select" id="evidence-turn-selector" value={selectedTurnId} onChange={(event) => onSelectTurn(event.target.value as string | "all")}>
          {snapshot.turns.map((turn) => <option key={turn.id} value={turn.id}>Turn {turn.ordinal}</option>)}
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
        <ToolsBrowser records={filterByTurn(evidence.tools, selectedTurnId)} onInvoke={onInvokeTool} />
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
      </div> : null}
    </aside>
  );
}

export const CAPABILITY_EVIDENCE_SECTION_IDS = CAPABILITY_EVIDENCE_SECTIONS.map(
  (section) => section.id,
);
