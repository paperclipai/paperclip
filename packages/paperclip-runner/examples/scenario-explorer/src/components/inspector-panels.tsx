import * as React from "react";

import { Badge } from "@paperclipai/paperclip-runner/react";
import type {
  CapabilityAuthorizationRecord,
  CapabilityExposure,
  CapabilityParityReport,
  CapabilityRunArtifact,
  CapabilityScenarioIndexEntry,
  CapabilityStateDiff,
} from "@paperclip-runner-local/capability";

import {
  ASSERTION_CLASS_LABEL,
  CHANGE_ICON,
  CHANGE_LABEL,
  groupLabel,
  outcomeLabel,
  outcomeTone,
  ROLE_LABEL,
  TASK_MODE_LABEL,
} from "../labels.js";
import {
  ClaimChips,
  DispositionBadge,
  EmptyState,
  JsonBlock,
  Mono,
  ParityStatusBadge,
} from "./primitives.js";

/* --------------------------------------------------------------- *
 * Context — who ran, under what authority, with which tools (§4.1).
 * --------------------------------------------------------------- */

export function ContextPanel({
  entry,
  artifact,
}: {
  entry: CapabilityScenarioIndexEntry;
  artifact: CapabilityRunArtifact | null;
}) {
  return (
    <div className="pcr7-panel" data-testid="panel-context">
      <section className="pcr7-panel-section">
        <h3>Actor</h3>
        <dl className="pcr7-detail-list">
          <dt>Actor role</dt>
          <dd>{ROLE_LABEL[entry.actorRole] ?? entry.actorRole}</dd>
          <dt>Task mode</dt>
          <dd>{TASK_MODE_LABEL[entry.taskMode] ?? entry.taskMode}</dd>
          <dt>Fixture</dt>
          <dd>
            <Mono>{entry.fixture}</Mono>
          </dd>
          <dt>Wake</dt>
          <dd>
            <Mono>{entry.wakeReason}</Mono>
            {artifact === null ? null : <> — scenario {artifact.scenarioId}</>}
          </dd>
          <dt>Budget</dt>
          <dd>
            {artifact === null ? (
              <span className="pcr7-muted">no run yet</span>
            ) : (
              `${artifact.budget.remainingCents} of ${artifact.budget.limitCents} cents remaining`
            )}
          </dd>
        </dl>
      </section>

      <section className="pcr7-panel-section">
        <h3>Capability grants</h3>
        <p className="pcr7-muted">
          Two vocabularies, both verbatim: the eval case records the capability it needs, the
          fixture issues the catalog claims that unlock the matching operations.
        </p>
        <p className="pcr7-label">Required by the eval case</p>
        <ClaimChips claims={entry.requiredGrants} testId="required-grants" />
        <p className="pcr7-label">Issued by the fixture as catalog claims</p>
        <ClaimChips claims={entry.scenarioClaims} testId="scenario-claims" />
      </section>

      <section className="pcr7-panel-section">
        <h3>Tool exposure</h3>
        {artifact === null ? (
          <EmptyState title="No run yet." >
            <p className="pcr7-muted">Run the scenario to record the exposure decision.</p>
          </EmptyState>
        ) : (
          <ExposureList exposure={artifact.exposure} />
        )}
      </section>

      <section className="pcr7-panel-section">
        <h3>Traceability</h3>
        <dl className="pcr7-detail-list">
          <dt>Source anchor</dt>
          <dd>
            <Mono>{entry.sourceAnchor}</Mono>
          </dd>
          <dt>Group</dt>
          <dd>
            {groupLabel(entry.group)} <Mono>{entry.group}</Mono>
          </dd>
          <dt>Disposition</dt>
          <dd>
            <DispositionBadge disposition={entry.primaryDisposition} />
          </dd>
          <dt>Skill elements</dt>
          <dd>
            {entry.skillElements.length === 0 ? (
              <span className="pcr7-muted">none recorded</span>
            ) : (
              entry.skillElements.map((element) => (
                <span key={`${element.file}:${element.lines}`} className="pcr7-block">
                  <Mono>{element.file}</Mono> · {element.section} · <Mono>{element.lines}</Mono>
                </span>
              ))
            )}
          </dd>
          <dt>Evidence IDs</dt>
          <dd>
            <ClaimChips claims={entry.evidenceIds} />
          </dd>
          <dt>Legacy MCP mapping</dt>
          <dd>
            <ClaimChips claims={entry.legacyMcpAliases} />
          </dd>
        </dl>
      </section>
    </div>
  );
}

export function ExposureList({ exposure }: { exposure: CapabilityExposure }) {
  return (
    <>
      <h4 className="pcr7-label">Always tools ({exposure.always.length})</h4>
      <ul className="pcr7-exposure" data-testid="exposure-always">
        {exposure.always.map((tool) => (
          <li key={tool.operationId}>
            <Mono>{tool.operationId}</Mono> — {tool.title}
          </li>
        ))}
      </ul>

      <h4 className="pcr7-label">Optional tools ({exposure.optional.length})</h4>
      <ul className="pcr7-exposure" data-testid="exposure-optional">
        {exposure.optional.length === 0 ? (
          <li className="pcr7-muted">No optional operation is unlocked for this run.</li>
        ) : (
          exposure.optional.map((tool) => (
            <li key={tool.operationId}>
              <Mono>{tool.operationId}</Mono>
              {tool.unlockedBy === null ? null : (
                <>
                  {" "}
                  — via <Mono>{tool.unlockedBy}</Mono>
                </>
              )}
            </li>
          ))
        )}
      </ul>

      <h4 className="pcr7-label">Control plane — no tool ({exposure.controlPlane.length})</h4>
      <ul className="pcr7-exposure" data-testid="exposure-control-plane">
        {exposure.controlPlane.map((capability) => (
          <li key={capability.operationId}>
            <Mono>{capability.operationId}</Mono> — {capability.reason}
          </li>
        ))}
      </ul>

      <details className="pcr7-facet" data-testid="exposure-withheld">
        <summary className="pcr7-facet-summary">
          Catalogued but not exposed ({exposure.withheld.length})
        </summary>
        <ul className="pcr7-exposure">
          {exposure.withheld.map((tool) => (
            <li key={tool.operationId}>
              <Mono>{tool.operationId}</Mono> — <Mono>{tool.reason}</Mono>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

/* --------------------------------------------------------------- *
 * Authorization (§4.2).
 * --------------------------------------------------------------- */

export function AuthorizationPanel({
  records,
  onSelectRecord,
}: {
  records: readonly CapabilityAuthorizationRecord[];
  onSelectRecord?: (sequence: number) => void;
}) {
  if (records.length === 0) {
    return (
      <div className="pcr7-panel" data-testid="panel-authorization">
        <EmptyState title="No run yet.">
          <p className="pcr7-muted">Run the scenario to record authorization decisions.</p>
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="pcr7-panel" data-testid="panel-authorization">
      <table className="pcr7-table">
        <caption className="pcr7-visually-hidden">
          Authorization decisions recorded by the mock control plane
        </caption>
        <thead>
          <tr>
            <th scope="col">Operation</th>
            <th scope="col">Claims considered</th>
            <th scope="col">Decision</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr
              key={record.sequence}
              data-testid={`authorization-row-${record.sequence}`}
              data-outcome={record.outcome}
              onClick={onSelectRecord === undefined ? undefined : () => onSelectRecord(record.sequence)}
            >
              <th scope="row">
                <Mono>{record.operationId}</Mono>
              </th>
              <td>
                <ClaimChips claims={record.consideredClaims} />
                {record.missingClaims.length === 0 ? null : (
                  <span className="pcr7-block pcr7-missing">
                    missing: <ClaimChips claims={record.missingClaims} />
                  </span>
                )}
              </td>
              <td>
                <Badge tone={outcomeTone(record.outcome)}>
                  <span aria-hidden="true">{record.outcome === "allowed" ? "✓" : "✕"}</span>{" "}
                  {outcomeLabel(record.outcome)}
                </Badge>
              </td>
              <td>
                <Mono>{record.reason}</Mono>
                {record.redactions.length === 0 ? null : (
                  <span className="pcr7-block pcr7-muted">
                    {record.redactions.length} redaction rule
                    {record.redactions.length === 1 ? "" : "s"} applied
                  </span>
                )}
                {record.resultingStateChange === null ? null : (
                  <span className="pcr7-block pcr7-muted">
                    revision {record.resultingStateChange.beforeRevision} →{" "}
                    {record.resultingStateChange.afterRevision}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <details className="pcr7-facet">
        <summary className="pcr7-facet-summary">Full authorization records</summary>
        <JsonBlock label="Records" value={records} />
      </details>
    </div>
  );
}

export function denialCount(records: readonly CapabilityAuthorizationRecord[]): number {
  return records.filter((record) => record.outcome !== "allowed").length;
}

/* --------------------------------------------------------------- *
 * State diff (§4.3).
 * --------------------------------------------------------------- */

export function StateDiffPanel({ diff }: { diff: CapabilityStateDiff | null }) {
  if (diff === null) {
    return (
      <div className="pcr7-panel" data-testid="panel-diff">
        <EmptyState title="No run yet.">
          <p className="pcr7-muted">Run the scenario to produce a before/after snapshot diff.</p>
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="pcr7-panel" data-testid="panel-diff">
      <p className="pcr7-muted">
        Revision {diff.beforeRevision} → {diff.afterRevision}
      </p>
      {diff.domains.map((domain) => (
        <details
          key={domain.domain}
          className="pcr7-facet"
          data-testid={`diff-domain-${domain.domain}`}
          data-changed={domain.changed}
          open={domain.changed}
        >
          <summary className="pcr7-facet-summary">
            {domain.domain} · {domain.summary}
          </summary>
          {domain.changed ? (
            <ul className="pcr7-diff-rows">
              {domain.rows.map((row) => (
                <li key={row.entityId} data-change={row.change}>
                  <span className="pcr7-diff-marker">
                    <span aria-hidden="true">{CHANGE_ICON[row.change]}</span> {CHANGE_LABEL[row.change]}
                  </span>
                  <Mono>{row.entityId}</Mono>
                  <ul className="pcr7-diff-fields">
                    {row.fields.map((field) => (
                      <li key={field.field}>
                        <Mono>{field.field}</Mono>: {field.before ?? "—"} → {field.after ?? "—"}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pcr7-muted">unchanged</p>
          )}
          <details className="pcr7-facet">
            <summary className="pcr7-facet-summary">Final state</summary>
            <JsonBlock label={`${domain.domain} after`} value={domain.afterSnapshot} />
          </details>
        </details>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- *
 * Parity (§4.4).
 * --------------------------------------------------------------- */

export function ParityPanel({ parity }: { parity: CapabilityParityReport | null }) {
  if (parity === null) {
    return (
      <div className="pcr7-panel" data-testid="panel-parity">
        <EmptyState title="No run yet.">
          <p className="pcr7-muted">Run the scenario to produce a parity verdict.</p>
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="pcr7-panel" data-testid="panel-parity">
      <p className="pcr7-parity-verdict" data-testid="parity-verdict">
        <ParityStatusBadge status={parity.verdict} testId="parity-verdict-badge" /> {parity.assertions.length}{" "}
        assertions · {parity.assertions.filter((assertion) => assertion.status === "pass").length} pass
      </p>

      <h4 className="pcr7-label">Assertions</h4>
      <ul className="pcr7-assertions">
        {parity.assertions.map((assertion) => (
          <li key={assertion.index} data-testid={`parity-assertion-${assertion.index}`}>
            <span className="pcr7-assertion-head">
              <Badge tone="neutral">{ASSERTION_CLASS_LABEL[assertion.assertionClass]}</Badge>
              <ParityStatusBadge status={assertion.status} testId={`parity-assertion-status-${assertion.index}`} />
            </span>
            <p>{assertion.expectation}</p>
            {assertion.status === "fail" ? (
              <div className="pcr7-expected-observed">
                <div>
                  <p className="pcr7-label">Expected</p>
                  <pre className="pcr-payload">{assertion.expected}</pre>
                </div>
                <div>
                  <p className="pcr7-label">Observed</p>
                  <pre className="pcr-payload pcr-payload--danger">{assertion.observed}</pre>
                </div>
              </div>
            ) : (
              <p className="pcr7-muted">
                <Mono>{assertion.observed}</Mono>
              </p>
            )}
          </li>
        ))}
      </ul>

      <h4 className="pcr7-label">Forbidden operations</h4>
      <ul className="pcr7-exposure" data-testid="parity-forbidden">
        {parity.forbidden.length === 0 ? (
          <li className="pcr7-muted">
            This case records no forbidden operations; restraint is proven by the absence of state
            writes in the diff.
          </li>
        ) : (
          parity.forbidden.map((check) => (
            <li key={check.semantic}>
              <Mono>{check.semantic}</Mono> —{" "}
              {check.invoked ? (
                <span className="pcr7-missing">
                  invoked at transcript entry {check.transcriptSequence}
                </span>
              ) : (
                <>
                  never invoked <span aria-hidden="true">✓</span>
                </>
              )}
            </li>
          ))
        )}
      </ul>

      {parity.intentionalGaps.length === 0 ? null : (
        <>
          <h4 className="pcr7-label">Intentional gaps</h4>
          <ul className="pcr7-exposure" data-testid="parity-gaps">
            {parity.intentionalGaps.map((gap) => (
              <li key={gap.subject}>
                <Mono>{gap.subject}</Mono> — {gap.rationale}
              </li>
            ))}
          </ul>
        </>
      )}

      <h4 className="pcr7-label">Capability conformance suite</h4>
      <p data-testid="parity-eval-suite">
        <ParityStatusBadge status={parity.evalSuite.status} testId="parity-eval-status" />{" "}
        {parity.evalSuite.available ? (
          <>
            operation <Mono>{parity.evalSuite.semanticOperation ?? "—"}</Mono>, decision{" "}
            <Mono>{parity.evalSuite.authorizationDecision ?? "—"}</Mono>
          </>
        ) : (
          <span className="pcr7-muted">
            no Capability report is loaded; this explorer renders 7E output and never recomputes it.
          </span>
        )}
      </p>

      <p className="pcr7-muted" data-testid="parity-baseline">
        Reference baseline, not the pass condition: {parity.legacyBaselineNote}
      </p>
    </div>
  );
}
