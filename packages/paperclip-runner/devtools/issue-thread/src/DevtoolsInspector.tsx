import { useEffect, useMemo, useState } from "react";

import type { CapabilityDevtoolsSnapshot } from "../../../src/devtools";
import { Icon, type IconName } from "./Icons";
import { EvalAssertions, type EvalAssertion } from "./ThreadItems";

export type CapabilityDevtoolsTab =
  | "eval"
  | "evidence"
  | "timeline"
  | "state"
  | "diff"
  | "documents"
  | "protocol"
  | "trace"
  | "runtime"
  | "authority";
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface EvalInspectorReport {
  attemptId: string;
  caseId: string;
  disposition: string;
  passed: boolean;
  checks: EvalAssertion[];
  run: {
    model: string;
    provider: string;
    driver: string;
    providerVersion: string | null;
    runnerProvider: string;
    configuration: string;
    sessionId: string;
    providerSessionId: string | null;
    agentVersion: string | null;
    retainedSession: boolean | null;
    retainedSessionStatus: string | null;
    fixtureDigest: string;
    runnerPackageDigest: string;
    runnerdDigest: string;
    runnerBuild: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    initialRevision: number;
    finalRevision: number;
    usage: {
      agentTurns: number;
      providerRequests: number | null;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      reasoningTokens: number;
      providerReportedCostNanodollars?: number;
      estimatedCostNanodollars: number;
      pricingVersion: string;
    } | null;
  };
}

function JsonTree({ value, name = "root" }: { value: Json; name?: string }) {
  if (value === null || typeof value !== "object") {
    return <span className="pit-json-value">{JSON.stringify(value)}</span>;
  }
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry] as const)
    : Object.entries(value);
  return (
    <details className="pit-json-node" open={name === "root"}>
      <summary>
        {name}{" "}
        <span className="pit-muted">
          {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
        </span>
      </summary>
      <div className="pit-json-children">
        {entries.map(([key, entry]) => (
          <div className="pit-json-row" key={key}>
            <span className="pit-json-key">{key}</span>
            {entry !== null && typeof entry === "object" ? (
              <JsonTree value={entry as Json} name={key} />
            ) : (
              <JsonTree value={entry as Json} />
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

interface DiffRow {
  path: string;
  before: Json | undefined;
  after: Json | undefined;
}

function diff(
  before: Json | undefined,
  after: Json | undefined,
  path = "state",
): DiffRow[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) =>
      diff(before[key], after[key], `${path}.${key}`),
    );
  }
  return [{ path, before, after }];
}

function download(snapshot: CapabilityDevtoolsSnapshot) {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `paperclip-devtools-r${snapshot.currentRevision}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

const TABS: ReadonlyArray<{
  id: CapabilityDevtoolsTab;
  icon: IconName;
  label: string;
}> = [
  { id: "evidence", icon: "evidence", label: "Evidence" },
  { id: "timeline", icon: "timeline", label: "Timeline" },
  { id: "state", icon: "state", label: "State" },
  { id: "diff", icon: "diff", label: "Diff" },
  { id: "documents", icon: "documents", label: "Documents" },
  { id: "protocol", icon: "protocol", label: "Protocol" },
  { id: "trace", icon: "protocol", label: "Provider trace" },
  { id: "runtime", icon: "terminal", label: "Runtime" },
  { id: "authority", icon: "authority", label: "Authority" },
];

function documentsOf(state: Json): Array<{
  id: string;
  key: string;
  title: string;
  revisions: Array<{
    id: string;
    revision: number;
    body: string;
    changeSummary: string | null;
    createdAt: string;
  }>;
}> {
  if (state === null || typeof state !== "object" || Array.isArray(state))
    return [];
  const documents = state.documents;
  if (!Array.isArray(documents)) return [];
  return documents.flatMap((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return [];
    const revisions = Array.isArray(value.revisions)
      ? value.revisions.flatMap((candidate) => {
          if (
            candidate === null ||
            typeof candidate !== "object" ||
            Array.isArray(candidate)
          )
            return [];
          return [
            {
              id: String(candidate.id ?? ""),
              revision: Number(candidate.revision ?? 0),
              body: String(candidate.body ?? ""),
              changeSummary:
                candidate.changeSummary === null
                  ? null
                  : String(candidate.changeSummary ?? ""),
              createdAt: String(candidate.createdAt ?? ""),
            },
          ];
        })
      : [];
    return [
      {
        id: String(value.id ?? ""),
        key: String(value.key ?? ""),
        title: String(value.title ?? "Untitled"),
        revisions,
      },
    ];
  });
}

export function DevtoolsInspector({
  snapshot,
  onFork,
  tab,
  onTabChange,
  evalReport,
}: {
  snapshot: CapabilityDevtoolsSnapshot;
  onFork: (revision: number) => void;
  tab: CapabilityDevtoolsTab;
  onTabChange: (tab: CapabilityDevtoolsTab) => void;
  evalReport?: EvalInspectorReport | null;
}) {
  const [query, setQuery] = useState("");
  const latest = snapshot.revisions.at(-1)!;
  const [revision, setRevision] = useState(latest.revision);
  const [following, setFollowing] = useState(true);
  const [compareRevision, setCompareRevision] = useState(
    snapshot.revisions[0]!.revision,
  );
  const selected =
    snapshot.revisions.find((entry) => entry.revision === revision) ?? latest;
  const compared =
    snapshot.revisions.find((entry) => entry.revision === compareRevision) ??
    snapshot.revisions[0]!;
  const rows = useMemo(
    () => diff(compared.state as Json, selected.state as Json),
    [compared.state, selected.state],
  );
  const normalized = query.trim().toLowerCase();
  const revisions = snapshot.revisions.filter(
    (entry) =>
      normalized.length === 0 ||
      JSON.stringify(entry).toLowerCase().includes(normalized),
  );
  const protocol = snapshot.protocol.filter(
    (entry) =>
      normalized.length === 0 ||
      JSON.stringify(entry).toLowerCase().includes(normalized),
  );
  const documents = useMemo(
    () => documentsOf(selected.state as Json),
    [selected.state],
  );
  const [documentId, setDocumentId] = useState("");
  const document =
    documents.find((entry) => entry.id === documentId) ?? documents[0] ?? null;
  const [documentRevision, setDocumentRevision] = useState(0);
  const visibleDocumentRevision =
    document?.revisions.find((entry) => entry.revision === documentRevision) ??
    document?.revisions.at(-1) ??
    null;
  useEffect(() => {
    if (following) setRevision(latest.revision);
  }, [following, latest.revision]);

  return (
    <section className="pit-devtools" data-testid="devtools-inspector">
      <div className="pit-devtools-toolbar">
        <span className="pit-devtools-brand">
          <Icon name="activity" /> State monitor
        </span>
        <input
          id="devtools-search"
          className="pit-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="operation, entity, turn…"
        />
        <button
          className="pit-icon-button"
          type="button"
          aria-pressed={!following}
          onClick={() => setFollowing((value) => !value)}
          title={following ? "Pause live updates" : "Follow latest revision"}
          aria-label={
            following ? "Pause live updates" : "Follow latest revision"
          }
        >
          <Icon name={following ? "pause" : "play"} />
        </button>
        <button
          className="pit-icon-button"
          type="button"
          onClick={() => download(snapshot)}
          title="Export redacted snapshot"
          aria-label="Export redacted snapshot"
        >
          <Icon name="download" />
        </button>
        <button
          className="pit-button"
          type="button"
          onClick={() => onFork(revision)}
        >
          <Icon name="branch" /> Fork r{revision}
        </button>
      </div>
      <div
        className="pit-devtools-tabs"
        role="tablist"
        aria-label="Developer tools"
      >
        {[
          ...(evalReport
            ? [
                {
                  id: "eval" as const,
                  icon: "evidence" as const,
                  label: "Eval",
                },
              ]
            : []),
          ...TABS,
        ].map(({ id, icon, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className="pit-tab"
            onClick={() => onTabChange(id)}
          >
            <span className="pit-tab-glyph">
              <Icon name={icon} />
            </span>
            <span>{label}</span>
          </button>
        ))}
      </div>
      {tab === "eval" && evalReport ? (
        <div className="pit-devtools-pane pit-eval-inspector">
          <div className="pit-eval-summary-head">
            <a href="../../index.html">← Eval suite</a>
            <strong>
              {evalReport.passed
                ? "PASS"
                : evalReport.disposition.replaceAll("_", " ").toUpperCase()}
            </strong>
            <code>{evalReport.attemptId}</code>
          </div>
          <dl className="pit-eval-run-facts">
            <div>
              <dt>Model</dt>
              <dd>
                {evalReport.run.model.startsWith(`${evalReport.run.provider}/`)
                  ? evalReport.run.model
                  : `${evalReport.run.provider}/${evalReport.run.model}`}
              </dd>
            </div>
            <div>
              <dt>Configuration</dt>
              <dd>{evalReport.run.configuration}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>{evalReport.run.sessionId}</dd>
            </div>
            <div>
              <dt>Provider session</dt>
              <dd>{evalReport.run.providerSessionId ?? "unavailable"}</dd>
            </div>
            <div>
              <dt>Driver</dt>
              <dd>
                {evalReport.run.driver}
                {evalReport.run.providerVersion
                  ? ` · ${evalReport.run.providerVersion}`
                  : ""}
              </dd>
            </div>
            {evalReport.run.agentVersion ? (
              <div>
                <dt>Agent version</dt>
                <dd>{evalReport.run.agentVersion}</dd>
              </div>
            ) : null}
            <div>
              <dt>Retained session</dt>
              <dd>
                {evalReport.run.retainedSession === true
                  ? (evalReport.run.retainedSessionStatus ?? "retained")
                  : "not applicable"}
              </dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{evalReport.run.durationMs} ms</dd>
            </div>
            <div>
              <dt>Fixture</dt>
              <dd>{evalReport.run.fixtureDigest}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>
                r{evalReport.run.initialRevision} → r
                {evalReport.run.finalRevision}
              </dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd>
                {evalReport.run.usage === null
                  ? "unknown"
                  : `${evalReport.run.usage.inputTokens} in · ${evalReport.run.usage.outputTokens} out · ${evalReport.run.usage.cachedInputTokens} cached`}
              </dd>
            </div>
            <div>
              <dt>Agent turns</dt>
              <dd>{evalReport.run.usage?.agentTurns ?? "unknown"}</dd>
            </div>
            <div>
              <dt>Provider requests</dt>
              <dd>{evalReport.run.usage?.providerRequests ?? "unavailable"}</dd>
            </div>
            <div>
              <dt>Estimated cost</dt>
              <dd>
                {evalReport.run.usage === null
                  ? "unknown"
                  : `$${(evalReport.run.usage.estimatedCostNanodollars / 1_000_000_000).toFixed(6)} · ${evalReport.run.usage.pricingVersion}`}
              </dd>
            </div>
            <div>
              <dt>Provider list cost</dt>
              <dd>
                {typeof evalReport.run.usage
                  ?.providerReportedCostNanodollars !== "number"
                  ? "unknown"
                  : `$${(evalReport.run.usage.providerReportedCostNanodollars / 1_000_000_000).toFixed(6)}`}
              </dd>
            </div>
            <div>
              <dt>Runner</dt>
              <dd>{evalReport.run.runnerPackageDigest}</dd>
            </div>
            <div>
              <dt>Runner build</dt>
              <dd>{evalReport.run.runnerBuild}</dd>
            </div>
            <div>
              <dt>runnerd</dt>
              <dd>{evalReport.run.runnerdDigest}</dd>
            </div>
          </dl>
          <h3>Assertions</h3>
          <EvalAssertions assertions={evalReport.checks} />
        </div>
      ) : null}
      {tab === "timeline" ? (
        <div className="pit-devtools-list">
          {revisions.map((entry) => (
            <button
              type="button"
              className="pit-devtools-event"
              data-selected={entry.revision === revision}
              key={entry.revision}
              onClick={() => {
                setFollowing(false);
                setRevision(entry.revision);
              }}
            >
              <strong>r{entry.revision}</strong>
              <span>{entry.operationId}</span>
              <span className="pit-muted">{entry.turnId ?? "session"}</span>
            </button>
          ))}
        </div>
      ) : null}
      {tab === "state" ? (
        <div className="pit-devtools-pane">
          <label className="pit-card-meta" htmlFor="devtools-revision">
            Revision
          </label>
          <select
            id="devtools-revision"
            className="pit-select"
            value={revision}
            onChange={(event) => setRevision(Number(event.target.value))}
          >
            {snapshot.revisions.map((entry) => (
              <option key={entry.revision} value={entry.revision}>
                r{entry.revision} · {entry.operationId}
              </option>
            ))}
          </select>
          <JsonTree value={selected.state as Json} />
        </div>
      ) : null}
      {tab === "diff" ? (
        <div className="pit-devtools-pane">
          <div className="pit-button-row">
            <select
              className="pit-select"
              aria-label="Compare from revision"
              value={compareRevision}
              onChange={(event) =>
                setCompareRevision(Number(event.target.value))
              }
            >
              {snapshot.revisions.map((entry) => (
                <option key={entry.revision} value={entry.revision}>
                  from r{entry.revision}
                </option>
              ))}
            </select>
            <select
              className="pit-select"
              aria-label="Compare to revision"
              value={revision}
              onChange={(event) => setRevision(Number(event.target.value))}
            >
              {snapshot.revisions.map((entry) => (
                <option key={entry.revision} value={entry.revision}>
                  to r{entry.revision}
                </option>
              ))}
            </select>
          </div>
          {rows.map((row) => (
            <div className="pit-diff-row" key={row.path}>
              <strong>{row.path}</strong>
              <del>{JSON.stringify(row.before)}</del>
              <ins>{JSON.stringify(row.after)}</ins>
            </div>
          ))}
          {rows.length === 0 ? (
            <p className="pit-muted">No changes between these revisions.</p>
          ) : null}
        </div>
      ) : null}
      {tab === "documents" ? (
        documents.length === 0 ? (
          <div className="pit-devtools-empty">
            <span aria-hidden="true">▤</span>
            <p>No documents exist at r{selected.revision}.</p>
          </div>
        ) : (
          <div className="pit-document-browser">
            <div className="pit-document-sidebar">
              {documents.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  data-selected={entry.id === document?.id}
                  onClick={() => {
                    setDocumentId(entry.id);
                    setDocumentRevision(0);
                  }}
                >
                  <strong>{entry.key}</strong>
                  <span>{entry.title}</span>
                  <small>
                    {entry.revisions.length} revision
                    {entry.revisions.length === 1 ? "" : "s"}
                  </small>
                </button>
              ))}
            </div>
            {document !== null && visibleDocumentRevision !== null ? (
              <article className="pit-document-viewer">
                <header>
                  <div>
                    <span className="pit-card-meta">{document.key}</span>
                    <h4>{document.title}</h4>
                  </div>
                  <select
                    className="pit-select"
                    aria-label="Document revision"
                    value={visibleDocumentRevision.revision}
                    onChange={(event) =>
                      setDocumentRevision(Number(event.target.value))
                    }
                  >
                    {document.revisions.map((entry) => (
                      <option key={entry.id} value={entry.revision}>
                        r{entry.revision}
                      </option>
                    ))}
                  </select>
                </header>
                {visibleDocumentRevision.changeSummary ? (
                  <p className="pit-document-summary">
                    {visibleDocumentRevision.changeSummary}
                  </p>
                ) : null}
                <pre className="pit-document-body">
                  {visibleDocumentRevision.body}
                </pre>
              </article>
            ) : null}
          </div>
        )
      ) : null}
      {tab === "protocol" ? (
        <div className="pit-devtools-list">
          {protocol.map((entry) => (
            <details className="pit-runner-event" key={entry.id}>
              <summary>
                <strong>{entry.boundary}</strong> · {entry.event}
              </summary>
              <JsonTree value={entry.detail as Json} />
            </details>
          ))}
        </div>
      ) : null}
      {tab === "trace" ? (
        snapshot.providerTrace ? (
          <div className="pit-devtools-pane">
            <p>
              <strong>{snapshot.providerTrace.status}</strong> · expires{" "}
              {snapshot.providerTrace.expiresAt}
            </p>
            <h3>Raw frame → Interpretation → PRP events → Presentation</h3>
            <JsonTree
              value={
                {
                  frames: snapshot.providerTrace.frames,
                  interpretations: snapshot.providerTrace.interpretations,
                } as Json
              }
            />
          </div>
        ) : (
          <div className="pit-devtools-empty">
            <span aria-hidden="true">◇</span>
            <p>
              Raw provider capture was off for this run. Canonical protocol
              records remain available in Protocol.
            </p>
          </div>
        )
      ) : null}
      {tab === "runtime" ? (
        <div className="pit-devtools-pane">
          <JsonTree value={snapshot.runtime as Json} />
        </div>
      ) : null}
      {tab === "authority" ? (
        <div className="pit-devtools-pane">
          <JsonTree value={snapshot.authority as Json} />
        </div>
      ) : null}
    </section>
  );
}
