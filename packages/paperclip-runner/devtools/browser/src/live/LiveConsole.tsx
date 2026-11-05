import * as React from "react";

import { Badge } from "../components/ui/badge";
import { Banner, BannerActions, BannerText } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { Composer } from "../components/ui/composer";
import { Conversation } from "../components/ui/conversation";
import { Dialog } from "../components/ui/dialog";
import { Message, MessageText } from "../components/ui/message";
import { ReasoningItem } from "../components/ui/reasoning-item";
import { Tabs } from "../components/ui/tabs";
import { ToolItem, type ToolStatus } from "../components/ui/tool-item";
import { Inspector } from "./Inspector";
import { RequestCard } from "./RequestCard";
import { ConnectionBlock, GoalBlock, LineageTree, ManifestList } from "./SessionPanel";
import { useLiveConsole } from "./use-live-console";
import type { TranscriptEntry } from "./transcript-model";

const MOBILE_SEGMENTS = [
  { id: "chat", label: "Chat" },
  { id: "session", label: "Session" },
  { id: "inspector", label: "Inspector" },
];

const TURN_TONE = {
  completed: "success",
  failed: "danger",
  interrupted: "warning",
  cancelled: "warning",
} as const;

const TURN_LABEL = {
  completed: "Turn completed",
  failed: "Turn failed",
  interrupted: "Turn interrupted",
  cancelled: "Cancelled before start",
} as const;

/**
 * Renders exactly one layout. Hiding a second copy with CSS would duplicate
 * the transcript log landmark and every control in the DOM.
 */
function useCompactLayout(): boolean {
  const [compact, setCompact] = React.useState(
    () => window.matchMedia?.("(max-width: 64rem)").matches === true,
  );
  React.useEffect(() => {
    const query = window.matchMedia?.("(max-width: 64rem)");
    if (query === undefined) return undefined;
    const onChange = () => setCompact(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return compact;
}

function toolStatus(entry: Extract<TranscriptEntry, { kind: "item" }>): ToolStatus {
  if (entry.interrupted) return "interrupted";
  if (entry.item.status === "failed") return "failed";
  if (entry.item.status === "running") return "running";
  return "completed";
}

export function LiveConsole() {
  const console_ = useLiveConsole();
  const [draft, setDraft] = React.useState("");
  const [inspectorOpen, setInspectorOpen] = React.useState(false);
  const [segment, setSegment] = React.useState("chat");
  const [resetOpen, setResetOpen] = React.useState(false);
  const [highlightItemId, setHighlightItemId] = React.useState<string | null>(null);
  const [outcomes, setOutcomes] = React.useState<Record<string, string>>({});
  const oldestPendingRef = React.useRef<HTMLLIElement>(null);
  const compact = useCompactLayout();

  React.useEffect(() => {
    const stored = window.localStorage.getItem("paperclip-runner.live-console.inspector");
    if (stored === "open") setInspectorOpen(true);
  }, []);

  React.useEffect(() => {
    window.localStorage.setItem(
      "paperclip-runner.live-console.inspector",
      inspectorOpen ? "open" : "closed",
    );
  }, [inspectorOpen]);

  const manifestId = console_.state?.manifest ?? console_.selectedManifestId;
  const activeManifest = console_.manifests.find((entry) => entry.id === manifestId);
  const pendingRequests = console_.transcript.filter(
    (entry) => entry.kind === "request" && entry.status === "pending",
  );
  const viewingChild = console_.selectedThreadId !== null;
  const childSteeringSupported = false;

  React.useEffect(() => {
    const snapshot = console_.snapshot;
    if (snapshot === null || console_.state === null) return;
    if (!["completed", "failed", "interrupted", "cancelled"].includes(snapshot.turnState)) return;
    setOutcomes((current) => ({
      ...current,
      [console_.state!.manifest ?? "unknown"]:
        snapshot.turnState === "completed" ? "passed observations" : snapshot.turnState,
    }));
  }, [console_.snapshot, console_.state]);

  function submit() {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft("");
    if (console_.composer === "active-turn") void console_.steer(text);
    else void console_.send(text);
  }

  function runManifest(id: string) {
    const manifest = console_.manifests.find((entry) => entry.id === id);
    void console_.start({ manifestId: id, message: manifest?.prompt ?? "Run the demo." });
  }

  const composerReason = viewingChild && !childSteeringSupported
    ? "Direct steering of child threads is not supported by this app-server."
    : null;

  const transcriptBody = (
    <Conversation itemCount={console_.transcript.length} label="Session transcript">
      {console_.transcript.length === 0 ? (
        <div className="ui-empty-transcript" data-testid="empty-transcript">
          <p className="eyebrow">No session yet</p>
          <h3>Pick a demo chat or start a blank session</h3>
          <p>
            The browser never holds a provider credential. Only the demo server starts a driver
            and owns the working directory.
          </p>
        </div>
      ) : null}
      <ol className="ui-transcript" role="list">
        {console_.transcript.map((entry) => {
          if (entry.kind === "user") {
            return (
              <li key={entry.key}>
                <Message role="user">
                  <MessageText text={entry.text} streaming={false} />
                </Message>
              </li>
            );
          }
          if (entry.kind === "turn") {
            return (
              <li key={entry.key} className="ui-turn-marker" data-testid={`turn-${entry.state}`}>
                <Badge tone={TURN_TONE[entry.state]}>{TURN_LABEL[entry.state]}</Badge>
                <span>{entry.detail}</span>
              </li>
            );
          }
          if (entry.kind === "diagnostic") {
            return (
              <li key={entry.key}>
                <Message role="system" failed>
                  <MessageText text={entry.message} streaming={false} />
                </Message>
              </li>
            );
          }
          if (entry.kind === "request") {
            const isOldestPending =
              entry.status === "pending" && pendingRequests[0]?.key === entry.key;
            return (
              <RequestCard
                key={entry.key}
                entry={entry}
                {...(isOldestPending ? { focusRef: oldestPendingRef } : {})}
                onResolve={(resolution) =>
                  void console_.resolve(entry.requestId, entry.turnId ?? "", resolution)
                }
              />
            );
          }
          if (entry.role === "reasoning") {
            return (
              <li key={entry.key} data-highlighted={entry.item.itemId === highlightItemId}>
                <ReasoningItem
                  text={entry.item.text}
                  streaming={entry.streaming}
                  interrupted={entry.interrupted}
                />
              </li>
            );
          }
          if (entry.role === "tool") {
            return (
              <li key={entry.key} data-highlighted={entry.item.itemId === highlightItemId}>
                <ToolItem
                  name={entry.toolName ?? entry.item.kind}
                  status={toolStatus(entry)}
                  input={entry.input}
                  output={entry.output}
                  failure={entry.failure}
                />
              </li>
            );
          }
          return (
            <li key={entry.key} data-highlighted={entry.item.itemId === highlightItemId}>
              <Message
                role={entry.role}
                streaming={entry.streaming}
                interrupted={entry.interrupted}
                failed={entry.item.status === "failed"}
              >
                <MessageText text={entry.item.text} streaming={entry.streaming} />
                {entry.failure === null ? null : (
                  <pre className="ui-payload ui-payload--danger">{entry.failure}</pre>
                )}
              </Message>
            </li>
          );
        })}
        {console_.steeringChips.map((chip) => (
          <li key={chip.id} className="ui-steering-chip" data-status={chip.status} data-testid="steering-chip">
            <Badge
              tone={
                chip.status === "acknowledged"
                  ? "success"
                  : chip.status === "pending"
                    ? "accent"
                    : "danger"
              }
            >
              {chip.status === "rejected"
                ? `rejected — ${chip.detail ?? "turn already ended"}`
                : chip.status}
            </Badge>
            <span>{chip.text}</span>
            {chip.status === "rejected" || chip.status === "failed" ? (
              <Button
                type="button"
                className="ui-button--quiet"
                data-testid="steer-as-new-message"
                onClick={() => {
                  console_.dismissSteeringChip(chip.id);
                  void console_.send(chip.text);
                }}
              >
                Send as new message
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
    </Conversation>
  );

  const composerBlock = (
    <div className="ui-composer-region">
      {console_.connection === "disconnected" || console_.connection === "reconnecting" ? (
        <Banner tone="warning" data-testid="reconnect-banner">
          <BannerText>
            {console_.connection === "reconnecting"
              ? `Connection lost — reconnecting (attempt ${console_.reconnectAttempt})…`
              : "Connection lost — the session is still on the server."}
          </BannerText>
          <BannerActions>
            <Button type="button" data-testid="retry-now" onClick={console_.retryNow}>
              Retry now
            </Button>
          </BannerActions>
        </Banner>
      ) : null}
      {pendingRequests.length > 0 ? (
        <Banner tone="accent" assertive data-testid="pending-request-banner">
          <BannerText>{pendingRequests.length} request waiting — Review</BannerText>
          <BannerActions>
            <Button
              type="button"
              onClick={() => oldestPendingRef.current?.focus()}
              data-testid="review-request"
            >
              Review
            </Button>
          </BannerActions>
        </Banner>
      ) : null}
      <Composer
        state={console_.composer}
        value={draft}
        onValueChange={setDraft}
        onSubmit={submit}
        onStop={() => void console_.interrupt()}
        disabledReason={composerReason}
      />
    </div>
  );

  const sessionRail = (
    <>
      <ManifestList
        manifests={console_.manifests}
        selectedId={console_.selectedManifestId}
        onSelect={console_.selectManifest}
        onRun={runManifest}
        lastOutcome={outcomes}
        disabled={console_.busy}
      />
      <ConnectionBlock
        connection={console_.connection}
        reconnectAttempt={console_.reconnectAttempt}
        state={console_.state}
        pendingRequestCount={pendingRequests.length}
        onDrop={console_.dropConnection}
        onRetry={console_.retryNow}
        onScrollToOldestRequest={() => oldestPendingRef.current?.focus()}
      />
      <GoalBlock state={console_.state} onGoal={(operation, body) => void console_.goal(operation, body)} />
      <LineageTree
        lineage={console_.state?.lineage ?? []}
        selectedThreadId={console_.selectedThreadId}
        onSelect={console_.selectThread}
      />
      <section className="ui-panel">
        <h2 className="ui-panel-title">Demo state</h2>
        <Button type="button" className="ui-button--quiet" onClick={() => setResetOpen(true)}>
          Reset demo state
        </Button>
        {activeManifest === undefined ? null : (
          <ol className="ui-observation-list" data-testid="observation-checklist">
            {activeManifest.expectedObservations.map((observation) => (
              <li key={observation}>
                <label>
                  <input type="checkbox" /> {observation}
                </label>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );

  const inspectorPanel = (
    <Inspector
      events={console_.events}
      snapshot={console_.snapshot}
      state={console_.state}
      connection={console_.connection}
      reconnectAttempt={console_.reconnectAttempt}
      replayParity={console_.replayParity}
      highlightItemId={highlightItemId}
      onHighlightItem={setHighlightItemId}
    />
  );

  return (
    <div className="live-console" data-inspector={inspectorOpen}>
      <div className="live-console-header">
        <div className="live-console-title">
          {console_.replay.active ? (
            <Badge tone="warning" data-testid="replay-badge">
              REPLAY
            </Badge>
          ) : null}
          <h2>{activeManifest?.name ?? "Live console"}</h2>
          {viewingChild ? (
            <p className="ui-breadcrumb" data-testid="breadcrumb">
              root ▸ {console_.selectedThreadId}
            </p>
          ) : null}
        </div>
        <div className="live-console-header-actions">
          <Button
            type="button"
            className="ui-button--quiet"
            data-testid="toggle-inspector"
            aria-pressed={inspectorOpen}
            onClick={() => setInspectorOpen((current) => !current)}
          >
            Protocol inspector
          </Button>
          <Button
            type="button"
            className="ui-button--quiet"
            data-testid="toggle-replay"
            aria-pressed={console_.replay.active}
            disabled={console_.events.length === 0}
            onClick={() => (console_.replay.active ? console_.replay.exit() : console_.replay.enter())}
          >
            {console_.replay.active ? "Exit replay" : "Replay"}
          </Button>
        </div>
      </div>

      <p className="ui-visually-hidden" aria-live="polite" data-testid="live-announcement">
        {console_.announcement}
      </p>
      {console_.error === null ? null : (
        <Banner tone="danger" assertive data-testid="console-error">
          <BannerText>{console_.error}</BannerText>
        </Banner>
      )}

      {console_.replay.active ? (
        <div className="ui-replay-stepper" data-testid="replay-stepper">
          <Button type="button" onClick={console_.replay.togglePlay}>
            {console_.replay.playing ? "Pause" : "Play"}
          </Button>
          <Button type="button" className="ui-button--quiet" onClick={() => console_.replay.step(-1)}>
            Step back
          </Button>
          <Button type="button" className="ui-button--quiet" onClick={() => console_.replay.step(1)}>
            Step forward
          </Button>
          <label htmlFor="replay-position">Position</label>
          <input
            id="replay-position"
            type="range"
            min={0}
            max={console_.replay.length}
            value={console_.replay.position}
            data-testid="replay-position"
            onChange={(event) => console_.replay.setPosition(Number(event.target.value))}
          />
          <span>
            {console_.replay.position} / {console_.replay.length}
          </span>
        </div>
      ) : null}

      {compact ? (
        <div className="live-console-mobile">
          <Tabs
            tabs={MOBILE_SEGMENTS}
            value={segment}
            onValueChange={setSegment}
            label="Console sections"
          >
            {segment === "chat" ? (
              <>
                {transcriptBody}
                {composerBlock}
              </>
            ) : null}
            {segment === "session" ? sessionRail : null}
            {segment === "inspector" ? inspectorPanel : null}
          </Tabs>
        </div>
      ) : (
        <div className="live-console-desktop">
          <aside className="live-console-rail">{sessionRail}</aside>
          <main className="live-console-center">
            {transcriptBody}
            {composerBlock}
          </main>
          {inspectorOpen ? (
            <aside className="live-console-inspector" aria-label="Protocol inspector">
              {inspectorPanel}
            </aside>
          ) : null}
        </div>
      )}

      <Dialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset demo state"
        description="Discards the current live session transcript. Recorded evidence files are not touched."
        footer={
          <>
            <Button type="button" className="ui-button--quiet" onClick={() => setResetOpen(false)}>
              Keep the session
            </Button>
            <Button
              type="button"
              className="ui-button--danger"
              data-testid="reset-confirm"
              onClick={() => {
                setResetOpen(false);
                setDraft("");
                void console_.reset();
              }}
            >
              Reset demo state
            </Button>
          </>
        }
      />
    </div>
  );
}
