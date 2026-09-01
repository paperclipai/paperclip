import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type {
  CapabilityEvidenceSectionId,
  CapabilityThreadItem,
  CapabilityThreadTurn,
} from "../../../src/issue-thread/types";
import { InteractionCard, type CapabilityInteractionResponse } from "./InteractionCard";
import { Chip, StatusBadge, Timestamp, formatBytes } from "./primitives";

export interface EvalAssertion {
  id: string;
  title: string;
  description: string;
  passed: boolean;
  detail: string;
  definition: Record<string, unknown>;
}

export function EvalAssertions({ assertions }: { assertions: EvalAssertion[] }) {
  const [selected, setSelected] = useState<EvalAssertion | null>(null);
  if (assertions.length === 0) return null;
  return (
    <>
      <div className="pit-inline-assertions" aria-label="Eval assertions">
        {assertions.map((assertion) => (
          <button type="button" key={assertion.id} data-passed={assertion.passed} onClick={() => setSelected(assertion)}>
            <strong>{assertion.passed ? "✓ PASS" : "✕ FAIL"} · {assertion.title}</strong>
            <span>{assertion.detail}</span>
          </button>
        ))}
      </div>
      {selected !== null ? (
        <div className="pit-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
          <div className="pit-dialog pit-eval-check-dialog" role="dialog" aria-modal="true" aria-labelledby="eval-check-title">
            <header className="pit-tool-dialog-head"><div><span className="pit-card-meta">Eval assertion · {selected.id}</span><h2 id="eval-check-title">{selected.title}</h2></div><button type="button" className="pit-icon-button" aria-label="Close assertion" onClick={() => setSelected(null)}>×</button></header>
            <p>{selected.description}</p>
            <p className="pit-card-meta">Observed result</p><p>{selected.detail}</p>
            <p className="pit-card-meta">Original case definition</p><pre className="pit-code">{JSON.stringify(selected.definition, null, 2)}</pre>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Progressive disclosure budget from contract §3 (T4). */
const VISIBLE_STRIPS = 3;

const STATUS_GLYPH = { ok: "✓", denied: "✕", running: "⏳" } as const;

function MarkdownBody({ children }: { children: string }) {
  return (
    <div className="pit-card-body pit-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

export interface ThreadCallbacks {
  onOpenEvidence: (section: CapabilityEvidenceSectionId, recordId: string) => void;
  onRespond: (response: CapabilityInteractionResponse) => void;
  focusInteractionId: string | null;
}

function ToolStrip({
  item,
  callbacks,
}: {
  item: Extract<CapabilityThreadItem, { kind: "tool_activity" }>;
  callbacks: ThreadCallbacks;
}) {
  return (
    <details
      id={item.id}
      className="pit-activity-item"
      data-thread-item="tool_activity"
      data-status={item.status}
      data-tool-strip={item.operationId}
    >
      <summary className="pit-activity-summary">
        <span className="pit-activity-glyph" aria-hidden="true">
          {STATUS_GLYPH[item.status]}
        </span>
        <span className="pit-visually-hidden">{item.status}</span>
        <span className="pit-activity-operation">{item.operationId}</span>
        <span className="pit-activity-description">{item.summary}</span>
        <span className="pit-activity-caret" aria-hidden="true">›</span>
      </summary>
      <div className="pit-activity-detail">
        <p className="pit-card-meta">Sanitized tool input and result</p>
        <div className="pit-activity-payloads">
          <pre className="pit-code">{JSON.stringify(item.input, null, 2)}</pre>
          <pre className="pit-code">{JSON.stringify(item.result, null, 2)}</pre>
        </div>
        <button
          type="button"
          className="pit-link-button"
          onClick={() =>
            callbacks.onOpenEvidence(item.evidenceRef.section, item.evidenceRef.recordId)
          }
        >
          View in Evidence
        </button>
      </div>
    </details>
  );
}

function ProgressItem({
  item,
}: {
  item: Extract<CapabilityThreadItem, { kind: "progress_activity" }>;
}) {
  return (
    <details
      id={item.id}
      className="pit-activity-item pit-progress-activity"
      data-thread-item="progress_activity"
      data-activity={item.activity}
      data-status={item.status}
      open={item.status === "running"}
    >
      <summary className="pit-activity-summary">
        <span className="pit-activity-glyph" aria-hidden="true">
          {item.status === "running" ? "⏳" : "✓"}
        </span>
        <span className="pit-activity-operation">{item.label}</span>
        <span className="pit-activity-description">{item.summary}</span>
        <span className="pit-activity-caret" aria-hidden="true">›</span>
      </summary>
      <div className="pit-activity-detail">
        {Object.entries(item.details).map(([name, value]) =>
          name === "withheld" ? null : (
            <div className="pit-activity-field" key={name}>
              <span>{name}</span>
              <pre className="pit-code">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>
            </div>
          ),
        )}
        {Array.isArray(item.details.withheld) ? (
          <p className="pit-withheld-note">
            Not available here: {item.details.withheld.join(", ")}.
          </p>
        ) : null}
      </div>
    </details>
  );
}

function valueRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function ProviderActivity({ item, callbacks }: {
  item: Extract<CapabilityThreadItem, { kind: "provider_activity" }>;
  callbacks: ThreadCallbacks;
}) {
  const payload = valueRecord(item.payload);
  const steps = Array.isArray(payload.steps) ? payload.steps.map(valueRecord) : [];
  const children = Array.isArray(payload.children) ? payload.children.map(valueRecord) : [];
  const sources = Array.isArray(payload.sources) ? payload.sources.map(valueRecord) : [];
  const output = typeof payload.output === "string" ? payload.output : "";
  const glyph = item.status === "running" ? "⏳" : item.status === "failed" ? "✕" : item.status === "interrupted" ? "■" : "✓";
  return (
    <details id={item.id} className="pit-activity-item pit-provider-activity" data-thread-item="provider_activity" data-family={item.family} data-status={item.status} open={item.status === "running"}>
      <summary className="pit-activity-summary"><span className="pit-activity-glyph" aria-hidden="true">{glyph}</span><span className="pit-activity-operation">{item.title}</span><span className="pit-activity-description">{item.summary}</span><span className="pit-activity-caret" aria-hidden="true">›</span></summary>
      <div className="pit-activity-detail">
        {steps.length > 0 ? <ol className="pit-provider-plan">{steps.map((step, index) => <li key={String(step.stepId ?? index)} data-plan-status={String(step.status ?? "pending")}><span aria-hidden="true">{step.status === "completed" ? "✓" : step.status === "blocked" ? "!" : step.status === "in_progress" ? "◐" : "○"}</span>{String(step.body ?? "")}</li>)}</ol> : null}
        {children.length > 0 ? <ul className="pit-provider-tree">{children.map((child, index) => <li key={String(child.childId ?? index)}><strong>{String(child.role ?? "Child agent")}</strong><span>{String(child.status ?? "unknown")}</span><small>{String(child.summary ?? "")}</small></li>)}</ul> : null}
        {sources.length > 0 ? <ul className="pit-provider-sources">{sources.map((source, index) => { const url = typeof source.url === "string" && /^https?:\/\//.test(source.url) ? source.url : null; return <li key={String(source.sourceId ?? index)}>{url === null ? <span>{String(source.title ?? "Unavailable source")}</span> : <a href={url} target="_blank" rel="noreferrer">{String(source.title ?? url)}</a>}<small>Provider-reported</small></li>; })}</ul> : null}
        {output.length > 0 ? <pre className="pit-provider-output" aria-label="Command output">{output}</pre> : null}
        {item.family === "model_identity" ? <dl className="pit-provider-fields"><dt>Requested</dt><dd>{String(payload.requestedModel ?? "—")}</dd><dt>Effective</dt><dd>{String(payload.effectiveModel ?? "—")}</dd></dl> : null}
        {item.family === "artifact" && typeof payload.reference === "string" ? <button type="button" className="pit-link-button">Open {payload.reference}</button> : null}
        <button type="button" className="pit-link-button" onClick={() => callbacks.onOpenEvidence(item.evidenceRef.section, item.evidenceRef.recordId)}>View in Evidence</button>
      </div>
    </details>
  );
}

function FileDiff({ diff }: { diff: string | null }) {
  if (diff === null) return <p className="pit-workspace-binary">Binary or oversized file; textual diff unavailable.</p>;
  return (
    <pre className="pit-workspace-diff" aria-label="Unified file diff">
      {diff.split("\n").map((line, index) => (
        <span
          key={`${index}:${line}`}
          data-diff-line={line.startsWith("+") && !line.startsWith("+++")
            ? "addition"
            : line.startsWith("-") && !line.startsWith("---")
              ? "deletion"
              : line.startsWith("@@")
                ? "hunk"
                : "context"}
        >{line || " "}{"\n"}</span>
      ))}
    </pre>
  );
}

function WorkspaceChanges({
  item,
}: {
  item: Extract<CapabilityThreadItem, { kind: "workspace_changes" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const files = item.changeSet.files;
  const visible = expanded ? files : files.slice(0, 3);
  const selected = files.find((file) => file.path === selectedPath) ?? null;
  const stats = (file: (typeof files)[number]) => (
    <span className="pit-workspace-stats">
      {file.additions === null ? null : <span data-stat="add">+{file.additions}</span>}
      {file.deletions === null ? null : <span data-stat="delete">-{file.deletions}</span>}
    </span>
  );

  return (
    <>
      <article id={item.id} className="pit-workspace-card" data-thread-item="workspace_changes">
        <header className="pit-workspace-head">
          <span className="pit-workspace-icon" aria-hidden="true">▣</span>
          <span>
            <strong>{item.changeSet.complete ? "Edited" : "Editing"} {files.length} file{files.length === 1 ? "" : "s"}</strong>
            <small>{item.changeSet.source === "runner_verified" ? "Verified from workspace" : "Reported by harness"}</small>
          </span>
          <span className="pit-workspace-total">
            {item.changeSet.totals.additions === null ? null : <span data-stat="add">+{item.changeSet.totals.additions}</span>}
            {item.changeSet.totals.deletions === null ? null : <span data-stat="delete">-{item.changeSet.totals.deletions}</span>}
          </span>
          <button type="button" className="pit-workspace-review" onClick={() => setSelectedPath(files[0]?.path ?? null)}>Review</button>
        </header>
        <div className="pit-workspace-files">
          {visible.map((file) => (
            <button type="button" key={`${file.operation}:${file.path}`} onClick={() => setSelectedPath(file.path)}>
              <span className="pit-workspace-path">
                {file.previousPath === null ? file.path : `${file.previousPath} → ${file.path}`}
                <small>{file.operation.replace("_", " ")}</small>
              </span>
              {stats(file)}
            </button>
          ))}
        </div>
        {files.length > 3 ? (
          <button type="button" className="pit-workspace-more" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Show fewer files" : `Show ${files.length - 3} more files`} <span aria-hidden="true">⌄</span>
          </button>
        ) : null}
      </article>
      {selected !== null ? (
        <div className="pit-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedPath(null); }}>
          <div className="pit-dialog pit-workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-diff-title">
            <header className="pit-tool-dialog-head">
              <div>
                <span className="pit-card-meta">{selected.operation.replace("_", " ")} · workspace diff</span>
                <h2 id="workspace-diff-title">{selected.path}</h2>
              </div>
              {stats(selected)}
              <button type="button" className="pit-icon-button" aria-label="Close diff" onClick={() => setSelectedPath(null)}>×</button>
            </header>
            {files.length > 1 ? (
              <nav className="pit-workspace-file-nav" aria-label="Changed files">
                {files.map((file) => <button type="button" key={file.path} data-selected={file.path === selected.path} onClick={() => setSelectedPath(file.path)}>{file.path}</button>)}
              </nav>
            ) : null}
            <FileDiff diff={selected.diff} />
          </div>
        </div>
      ) : null}
    </>
  );
}

function WorkspaceFileReference({
  item,
}: {
  item: Extract<CapabilityThreadItem, { kind: "workspace_file_reference" }>;
}) {
  const [open, setOpen] = useState(false);
  const extension = item.reference.path.includes(".")
    ? item.reference.path.split(".").at(-1)?.toUpperCase()
    : "FILE";
  const presentation = item.reference.presentation === "document"
    ? "Document"
    : item.reference.presentation === "code"
      ? "Code"
      : item.reference.presentation === "image"
        ? "Image"
        : "File";
  return (
    <>
      <article id={item.id} className="pit-file-reference-card" data-thread-item="workspace_file_reference">
        <span className="pit-file-reference-icon" aria-hidden="true">▤</span>
        <span className="pit-file-reference-copy">
          <strong>{item.reference.displayName}</strong>
          <small>{presentation} · {extension}{item.reference.line === null ? "" : ` · line ${item.reference.line}`}</small>
        </span>
        <button type="button" className="pit-workspace-review" onClick={() => setOpen(true)}>Open</button>
      </article>
      {open ? (
        <div className="pit-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <div className="pit-dialog pit-file-reference-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-file-title">
            <header className="pit-tool-dialog-head">
              <div><span className="pit-card-meta">{item.reference.path}</span><h2 id="workspace-file-title">{item.reference.displayName}</h2></div>
              <button type="button" className="pit-icon-button" aria-label="Close file" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="pit-file-reference-preview">
              {item.reference.preview === null
                ? <p className="pit-workspace-binary">Preview unavailable. The reference remains recorded with its normalized workspace path.</p>
                : item.reference.presentation === "document"
                  ? <MarkdownBody>{item.reference.preview}</MarkdownBody>
                  : <pre className="pit-code">{item.reference.preview}</pre>}
              {item.reference.previewTruncated ? <p className="pit-withheld-note">Preview truncated by the runner.</p> : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ThreadItemView({
  item,
  callbacks,
}: {
  item: CapabilityThreadItem;
  callbacks: ThreadCallbacks;
}) {
  switch (item.kind) {
    case "user_message":
      return (
        <article
          id={item.id}
          className="pit-message"
          data-role="user"
          data-thread-item="user_message"
        >
          <div className="pit-card-head">
            <span className="pit-card-author">{item.author}</span>
            <Timestamp value={item.at} />
          </div>
          <MarkdownBody>{item.body}</MarkdownBody>
        </article>
      );

    case "agent_message":
      return (
        <article
          id={item.id}
          className="pit-message"
          data-role="assistant"
          data-thread-item="agent_message"
          data-streaming={item.streaming}
        >
          <div className="pit-card-head">
            <span className="pit-card-author">{item.author}</span>
            <Timestamp value={item.at} />
            {item.streaming ? (
              <Chip tone="accent" testId="streaming-indicator">
                <span aria-hidden="true">⏳</span>
                Streaming
              </Chip>
            ) : null}
          </div>
          <MarkdownBody>{item.body}</MarkdownBody>
        </article>
      );

    case "durable_comment":
      return (
        <article id={item.id} className="pit-card" data-thread-item="durable_comment">
          <div className="pit-card-head">
            <span className="pit-card-author">{item.author}</span>
            <Timestamp value={item.at} />
            <span
              className="pit-durable-tag"
              title={`Recorded by the ${item.operationId} semantic operation.`}
            >
              <span aria-hidden="true">◆</span>
              Recorded to mock thread
            </span>
          </div>
          <div className="pit-card-body">{item.body}</div>
          <button
            type="button"
            className="pit-link-button"
            onClick={() =>
              callbacks.onOpenEvidence(item.evidenceRef.section, item.evidenceRef.recordId)
            }
          >
            View in Evidence
          </button>
        </article>
      );

    case "tool_activity":
      return <ToolStrip item={item} callbacks={callbacks} />;

    case "progress_activity":
      return <ProgressItem item={item} />;

    case "workspace_changes":
      return <WorkspaceChanges item={item} />;

    case "workspace_file_reference":
      return <WorkspaceFileReference item={item} />;

    case "provider_activity":
      return <ProviderActivity item={item} callbacks={callbacks} />;

    case "denial":
      return (
        <div id={item.id} className="pit-strip pit-denial" data-status="denied" data-thread-item="denial">
          <div className="pit-strip-button">
            <span className="pit-strip-glyph" aria-hidden="true">
              ✕
            </span>
            <span className="pit-strip-operation">{item.operationId}</span>
            <span className="pit-strip-summary" data-testid="denial-reason">
              {item.reason}
            </span>
          </div>
          <div className="pit-strip-detail">
            <button
              type="button"
              className="pit-link-button"
              onClick={() =>
                callbacks.onOpenEvidence(item.evidenceRef.section, item.evidenceRef.recordId)
              }
            >
              View in Evidence
            </button>
          </div>
        </div>
      );

    case "interaction":
      return (
        <InteractionCard
          card={item}
          autoFocus={callbacks.focusInteractionId === item.interactionId}
          onRespond={callbacks.onRespond}
          onOpenEvidence={(section, recordId) =>
            callbacks.onOpenEvidence(section as CapabilityEvidenceSectionId, recordId)
          }
        />
      );

    case "document":
      return (
        <article id={item.id} className="pit-card" data-thread-item="document">
          <div className="pit-card-head">
            <span className="pit-card-author">{item.title}</span>
            <span className="pit-card-meta">{item.documentKey}</span>
            <Timestamp value={item.at} />
          </div>
          <div className="pit-card-body">
            <span className="pit-card-meta" data-testid="revision-chain">
              {item.revisionFrom === null ? `r${item.revisionTo}` : `r${item.revisionFrom} → r${item.revisionTo}`}
            </span>
            {" · "}
            {item.author}
            {item.staleBehind !== null ? (
              <>
                {" "}
                <Chip>
                  <span aria-hidden="true">⌛</span>
                  Stale — {item.staleBehind} newer revision(s)
                </Chip>
              </>
            ) : null}
          </div>
          <button
            type="button"
            className="pit-link-button"
            onClick={() =>
              callbacks.onOpenEvidence(item.evidenceRef.section, item.evidenceRef.recordId)
            }
          >
            View diff
          </button>
        </article>
      );

    case "deliverable":
      return (
        <article id={item.id} className="pit-card" data-thread-item="deliverable">
          <div className="pit-card-head">
            <span className="pit-card-author">{item.filename}</span>
            <Timestamp value={item.at} />
          </div>
          <div className="pit-card-body">
            <span className="pit-card-meta">
              {item.deliverableKind} · {formatBytes(item.byteSize)} · registered by {item.registeredBy}
            </span>
          </div>
          <button
            type="button"
            className="pit-link-button"
            onClick={() =>
              callbacks.onOpenEvidence(item.evidenceRef.section, item.evidenceRef.recordId)
            }
          >
            Download {item.filename}
          </button>
        </article>
      );

    case "dependency":
      return (
        <article id={item.id} className="pit-card" data-thread-item="dependency">
          <div className="pit-card-head">
            <span className="pit-card-author">Delegation</span>
            <Timestamp value={item.at} />
          </div>
          <ul className="pit-summary-list">
            {item.createdTasks.map((task) => (
              <li key={task.identifier}>
                <span className="pit-record-title">{task.identifier}</span> {task.title}
              </li>
            ))}
            {item.blockerEdges.map((edge) => (
              <li key={edge}>{edge}</li>
            ))}
          </ul>
        </article>
      );

    case "disposition":
      return (
        <article id={item.id} className="pit-card pit-terminal-card" data-thread-item="disposition">
          <div className="pit-card-head">
            <StatusBadge status={item.status} />
            <span className="pit-card-meta">{item.operationId}</span>
            <Timestamp value={item.at} />
          </div>
          <div className="pit-card-body">{item.body}</div>
          {item.blockerOwner !== null ? (
            <p className="pit-card-meta">Blocker owner: {item.blockerOwner}</p>
          ) : null}
        </article>
      );

    case "system_notice":
      return (
        <p id={item.id} className="pit-notice" data-thread-item="system_notice">
          <span aria-hidden="true">{item.glyph}</span>
          <span className="pit-notice-text">{item.text}</span>
          <button
            type="button"
            className="pit-link-button"
            onClick={() =>
              callbacks.onOpenEvidence(item.evidenceRef.section, item.evidenceRef.recordId)
            }
          >
            Details
          </button>
        </p>
      );
  }
}

export function TurnGroup({
  turn,
  callbacks,
  assertions = {},
  terminalAssertions = [],
}: {
  turn: CapabilityThreadTurn;
  callbacks: ThreadCallbacks;
  assertions?: Record<string, EvalAssertion[]>;
  terminalAssertions?: EvalAssertion[];
}) {
  const [showAllStrips, setShowAllStrips] = useState(false);
  const stripIndexes = turn.items
    .map((item, index) => (item.kind === "tool_activity" ? index : -1))
    .filter((index) => index >= 0);
  const hiddenStripIndexes = new Set(
    showAllStrips ? [] : stripIndexes.slice(VISIBLE_STRIPS),
  );

  return (
    <section className="pit-turn" data-turn-id={turn.id} aria-label={`Turn ${turn.ordinal}`}>
      <h2 className="pit-turn-header">
        <span className="pit-turn-label">
          Turn {turn.ordinal} · {turn.mode} · {turn.toolCallCount} tool call
          {turn.toolCallCount === 1 ? "" : "s"} ·{" "}
          {new Date(turn.at).toISOString().slice(11, 19)}
        </span>
        {turn.stoppedByUser ? (
          <span className="pit-stopped-marker" data-testid="stopped-marker">
            Stopped by user
          </span>
        ) : null}
      </h2>
      {turn.items.map((item, index) => hiddenStripIndexes.has(index) ? null : (
        <div className="pit-eval-item" key={item.id}>
          <ThreadItemView item={item} callbacks={callbacks} />
          <EvalAssertions assertions={assertions[item.id] ?? []} />
        </div>
      ))}
      {hiddenStripIndexes.size > 0 ? (
        <button
          type="button"
          className="pit-more-button"
          onClick={() => setShowAllStrips(true)}
        >
          {hiddenStripIndexes.size} more…
        </button>
      ) : null}
      <EvalAssertions assertions={terminalAssertions} />
    </section>
  );
}
