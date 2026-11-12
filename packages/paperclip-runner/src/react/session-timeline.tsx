import * as React from "react";

import type { SessionSnapshot } from "../reducer/session-reducer.js";
import { Badge } from "./components/badge.js";
import { Button } from "./components/button.js";
import { Dialog } from "./components/dialog.js";
import { Menu } from "./components/menu.js";
import type {
  GoalOperation,
  ConnectionStatus,
  RunnerLineageEntry,
  ManifestSummary,
  RunnerSessionState,
} from "../browser/protocol.js";
import { GOAL_OPERATION_LABELS } from "../browser/protocol.js";
import { goalAvailability } from "../browser/transcript-model.js";

const CONNECTION_TONE = {
  idle: "neutral",
  connecting: "accent",
  connected: "success",
  reconnecting: "warning",
  disconnected: "danger",
  terminal: "neutral",
} as const;

const THREAD_STATE_LABEL: Record<string, string> = {
  starting: "Starting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

/** Reducer-authoritative timeline, lineage, and goal summary. */
export function SessionTimeline({
  snapshot,
  state,
}: {
  snapshot: SessionSnapshot | null;
  state: RunnerSessionState | null;
}) {
  const headingId = React.useId();
  return (
    <section data-slot="session-timeline" className="pcr-panel" aria-labelledby={headingId}>
      <h2 id={headingId} className="pcr-panel-title">Session timeline</h2>
      <dl className="pcr-identity-grid">
        <div><dt>Goal</dt><dd>{state?.goal?.objective ?? "No goal set"}</dd></div>
        <div><dt>State</dt><dd>{snapshot?.sessionState ?? "not started"}</dd></div>
      </dl>
      <ol className="pcr-timeline" data-testid="session-timeline">
        {(snapshot?.timeline ?? []).map((entry) => (
          <li key={entry.sourceEventId}>
            <code>{entry.sourceSeq}</code><span>{entry.summary}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ManifestList({
  manifests,
  selectedId,
  onSelect,
  onRun,
  lastOutcome,
  disabled,
}: {
  manifests: readonly ManifestSummary[];
  selectedId: string;
  onSelect: (id: string) => void;
  onRun: (id: string) => void;
  lastOutcome: Record<string, string>;
  disabled: boolean;
}) {
  return (
    <section data-slot="manifest-list" className="pcr-panel" aria-labelledby="manifest-heading">
      <h2 id="manifest-heading" className="pcr-panel-title">
        Demo chats
      </h2>
      <ul className="pcr-manifest-list" data-testid="manifest-list">
        {manifests.map((manifest) => (
          <li key={manifest.id} data-selected={manifest.id === selectedId}>
            <button
              type="button"
              className="pcr-manifest-row"
              aria-pressed={manifest.id === selectedId}
              data-testid={`manifest-${manifest.id}`}
              onClick={() => onSelect(manifest.id)}
            >
              <span className="pcr-manifest-name">{manifest.name}</span>
              <span className="pcr-manifest-purpose">{manifest.purpose}</span>
              <span className="pcr-manifest-badges">
                {manifest.scenarios.map((scenario) => (
                  <Badge key={scenario}>{scenario}</Badge>
                ))}
                <Badge tone={lastOutcome[manifest.id] === undefined ? "neutral" : "success"}>
                  {lastOutcome[manifest.id] ?? "not run"}
                </Badge>
              </span>
            </button>
            {manifest.id === selectedId ? (
              <>
                <details className="pcr-disclosure" data-testid="expected-observations">
                  <summary className="pcr-disclosure-summary">Expected observations</summary>
                  <ol className="pcr-observation-list">
                    {manifest.expectedObservations.map((observation) => (
                      <li key={observation}>{observation}</li>
                    ))}
                  </ol>
                </details>
                <Button
                  type="button"
                  disabled={disabled}
                  data-testid="run-manifest"
                  onClick={() => onRun(manifest.id)}
                >
                  Run this demo chat
                </Button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ConnectionBlock({
  connection,
  reconnectAttempt,
  state,
  pendingRequestCount,
  onDrop,
  onRetry,
  onScrollToOldestRequest,
}: {
  connection: ConnectionStatus;
  reconnectAttempt: number;
  state: RunnerSessionState | null;
  pendingRequestCount: number;
  onDrop: () => void;
  onRetry: () => void;
  onScrollToOldestRequest: () => void;
}) {
  return (
    <section data-slot="connection-block" className="pcr-panel" aria-labelledby="connection-heading">
      <h2 id="connection-heading" className="pcr-panel-title">
        Session
      </h2>
      <div className="pcr-status-row">
        <span>Connection</span>
        <Badge tone={CONNECTION_TONE[connection]} data-testid="connection-status">
          {connection === "reconnecting" ? `reconnecting (attempt ${reconnectAttempt})` : connection}
        </Badge>
      </div>
      <div className="pcr-status-row">
        <span>Pending requests</span>
        <button
          type="button"
          className="pcr-chip"
          data-testid="pending-request-chip"
          disabled={pendingRequestCount === 0}
          onClick={onScrollToOldestRequest}
        >
          {pendingRequestCount}
        </button>
      </div>
      <div className="pcr-status-row">
        <span>Credentials in browser</span>
        <Badge tone={state?.credentialsExposed === true ? "danger" : "success"}>
          {state?.credentialsExposed === true ? "exposed" : "none"}
        </Badge>
      </div>
      <dl className="pcr-identity-grid">
        <div>
          <dt>Run</dt>
          <dd>{state?.runId ?? "—"}</dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>{state?.normalizedSessionId ?? "—"}</dd>
        </div>
      </dl>
      <div className="pcr-panel-actions">
        <Button
          type="button"
          className="pcr-button--quiet"
          data-testid="drop-connection"
          disabled={state === null || connection === "disconnected"}
          onClick={onDrop}
        >
          Simulate connection loss
        </Button>
        <Button
          type="button"
          className="pcr-button--quiet"
          data-testid="resume-session"
          disabled={state === null}
          onClick={onRetry}
        >
          Resume this session
        </Button>
      </div>
    </section>
  );
}

export function GoalBlock({
  state,
  onGoal,
}: {
  state: RunnerSessionState | null;
  onGoal: (operation: GoalOperation, body?: Record<string, unknown>) => void;
}) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [objective, setObjective] = React.useState("");
  const objectiveId = React.useId();
  const triggerId = React.useId();
  const capabilities = state?.capabilities ?? {
    resume: false,
    typedEvents: false,
    steering: false,
    interruption: false,
    structuredResult: false,
  };
  const availability = goalAvailability(capabilities, state?.goal?.status ?? null);
  const unsupported = capabilities.goals !== true;
  const unsupportedReason = availability[0]?.reason ?? null;

  return (
    <section data-slot="goal-block" className="pcr-panel" aria-labelledby="goal-heading">
      <div className="pcr-panel-header">
        <h2 id="goal-heading" className="pcr-panel-title">
          Goal
        </h2>
        <Menu
          triggerId={triggerId}
          label="Goal"
          disabled={unsupported || state === null}
          disabledReason={
            state === null ? "Start a session before changing the goal." : unsupportedReason
          }
          items={availability.map((entry) => ({
            id: entry.operation,
            label: GOAL_OPERATION_LABELS[entry.operation],
            enabled: entry.enabled,
            reason: entry.reason,
          }))}
          onSelect={(id) => {
            if (id === "set") setDialogOpen(true);
            else onGoal(id as GoalOperation);
          }}
        />
      </div>
      {state === null ? null : state.goal === null ? (
        <p className="pcr-goal-empty" data-testid="goal-banner">
          {unsupported ? "Goal operations are unsupported here." : "No goal set"}
        </p>
      ) : (
        <div className="pcr-goal-banner" data-testid="goal-banner">
          <p className="pcr-goal-objective">{state.goal.objective}</p>
          <div className="pcr-status-row">
            <Badge tone={state.goal.status === "active" ? "success" : "warning"}>
              {state.goal.status}
            </Badge>
            <time dateTime={new Date(state.goal.updatedAt).toISOString()}>
              {new Date(state.goal.updatedAt).toISOString().slice(11, 19)}
            </time>
          </div>
        </div>
      )}
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Set goal"
        description="The goal is durable on the thread and every change is also a transcript event."
        footer={
          <>
            <Button type="button" className="pcr-button--quiet" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              data-testid="goal-set-confirm"
              disabled={objective.trim().length === 0}
              onClick={() => {
                onGoal("set", { objective: objective.trim() });
                setObjective("");
                setDialogOpen(false);
              }}
            >
              Set goal
            </Button>
          </>
        }
      >
        <label htmlFor={objectiveId}>Objective</label>
        <textarea
          id={objectiveId}
          className="pcr-dialog-input"
          data-testid="goal-objective"
          rows={3}
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
        />
      </Dialog>
    </section>
  );
}

export function LineageTree({
  lineage,
  selectedThreadId,
  onSelect,
}: {
  lineage: readonly RunnerLineageEntry[];
  selectedThreadId: string | null;
  onSelect: (threadId: string | null) => void;
}) {
  const rootId = lineage.find((entry) => entry.depth === 0)?.threadId ?? null;
  const current = selectedThreadId ?? rootId;
  const treeRef = React.useRef<HTMLUListElement>(null);

  function onKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    const rows = [
      ...(treeRef.current?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') ?? []),
    ];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      rows[Math.min(index + 1, rows.length - 1)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      rows[Math.max(index - 1, 0)]?.focus();
    }
  }

  return (
    <section data-slot="lineage-tree" className="pcr-panel" aria-labelledby="lineage-heading">
      <h2 id="lineage-heading" className="pcr-panel-title">
        Threads
      </h2>
      <ul
        ref={treeRef}
        role="tree"
        aria-label="Session thread lineage"
        className="pcr-tree"
        data-testid="lineage-tree"
        onKeyDown={onKeyDown}
      >
        {lineage.length === 0 ? <li className="pcr-tree-empty">No threads yet.</li> : null}
        {lineage.map((entry) => (
          <li key={entry.threadId} role="none" data-depth={entry.depth}>
            <button
              type="button"
              role="treeitem"
              aria-current={entry.threadId === current}
              aria-selected={entry.threadId === current}
              className="pcr-tree-row"
              data-testid={`thread-${entry.threadId}`}
              onClick={() => onSelect(entry.depth === 0 ? null : entry.threadId)}
            >
              <span className="pcr-state-dot" data-state={entry.status} aria-hidden="true" />
              <code>{entry.nickname ?? entry.threadId}</code>
              <span className="pcr-tree-state">
                {THREAD_STATE_LABEL[entry.status] ?? entry.status}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
