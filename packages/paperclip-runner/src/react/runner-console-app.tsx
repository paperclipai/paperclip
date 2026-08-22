import * as React from "react";

import type { RunnerClientOptions } from "../browser/client.js";
import type { SessionItemSnapshot } from "../reducer/session-reducer.js";
import type { TranscriptRequestEntry } from "../browser/transcript-model.js";
import { Badge } from "./components/badge.js";
import { Banner, BannerActions, BannerText } from "./components/banner.js";
import { Button } from "./components/button.js";
import { Composer } from "./components/composer.js";
import { Conversation } from "./components/conversation.js";
import { Dialog } from "./components/dialog.js";
import { Tabs } from "./components/tabs.js";
import { ConnectionBanner } from "./connection-banner.js";
import { Inspector } from "./inspector.js";
import { ReplayControls } from "./replay-controls.js";
import { ConnectionBlock, GoalBlock, LineageTree, ManifestList } from "./session-timeline.js";
import { useRunnerConsole } from "./use-runner-console.js";

const MOBILE_SEGMENTS = [
  { id: "chat", label: "Chat" },
  { id: "session", label: "Session" },
  { id: "inspector", label: "Inspector" },
];
const COMPACT_QUERY = "(max-width: 56.25rem)";

function useCompactLayout(): boolean {
  const [compact, setCompact] = React.useState(
    () => typeof window !== "undefined" && window.matchMedia?.(COMPACT_QUERY).matches === true,
  );
  React.useEffect(() => {
    const query = window.matchMedia?.(COMPACT_QUERY);
    if (query === undefined) return undefined;
    const onChange = () => setCompact(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return compact;
}

export interface RunnerConsoleAppProps extends RunnerClientOptions {
  renderItemBody?: (item: SessionItemSnapshot) => React.ReactNode;
  renderRequestDetail?: (request: TranscriptRequestEntry) => React.ReactNode;
}

export function RunnerConsoleApp({
  baseUrl,
  fetchImpl,
  eventSourceFactory,
  renderItemBody,
  renderRequestDetail,
}: RunnerConsoleAppProps = {}) {
  const console_ = useRunnerConsole({ baseUrl, fetchImpl, eventSourceFactory });
  const [draft, setDraft] = React.useState("");
  const [inspectorOpen, setInspectorOpen] = React.useState(false);
  const [segment, setSegment] = React.useState("chat");
  const [resetOpen, setResetOpen] = React.useState(false);
  const [highlightItemId, setHighlightItemId] = React.useState<string | null>(null);
  const [outcomes, setOutcomes] = React.useState<Record<string, string>>({});
  const compact = useCompactLayout();
  const manifestId = console_.state?.manifest ?? console_.selectedManifestId;
  const activeManifest = console_.manifests.find((entry) => entry.id === manifestId);
  const pendingRequests = console_.transcript.filter(
    (entry): entry is TranscriptRequestEntry => entry.kind === "request" && entry.status === "pending",
  );
  const viewingChild = console_.selectedThreadId !== null;

  React.useEffect(() => {
    const stored = window.localStorage.getItem("paperclip-runner.sdk.v1.inspector");
    if (stored === "open") setInspectorOpen(true);
  }, []);

  React.useEffect(() => {
    window.localStorage.setItem(
      "paperclip-runner.sdk.v1.inspector",
      inspectorOpen ? "open" : "closed",
    );
  }, [inspectorOpen]);

  React.useEffect(() => {
    const snapshot = console_.snapshot;
    if (snapshot === null || console_.state === null) return;
    if (!["completed", "failed", "interrupted", "cancelled"].includes(snapshot.turnState)) return;
    setOutcomes((current) => ({
      ...current,
      [console_.state!.manifest ?? "unknown"]: snapshot.turnState === "completed" ? "passed observations" : snapshot.turnState,
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

  const transcript = (
    <>
      <Conversation
        entries={console_.transcript}
        highlightItemId={highlightItemId}
        onResolveRequest={(request, resolution) => void console_.resolve(request.requestId, request.turnId ?? "", resolution)}
        {...(renderItemBody === undefined ? {} : { renderItemBody })}
        {...(renderRequestDetail === undefined ? {} : { renderRequestDetail })}
      />
      <ul className="pcr-steering-list" aria-label="Steering messages">
        {console_.steeringChips.map((chip) => (
          <li key={chip.id} className="pcr-steering-chip" data-status={chip.status} data-testid="steering-chip">
            <Badge tone={chip.status === "acknowledged" ? "success" : chip.status === "pending" ? "accent" : "danger"}>{chip.status}</Badge>
            <span>{chip.text}</span>
            {chip.status === "rejected" || chip.status === "failed" ? (
              <Button
                type="button"
                variant="ghost"
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
      </ul>
    </>
  );
  const composer = (
    <div className="pcr-composer-region">
      <ConnectionBanner connection={console_.connection} reconnectAttempt={console_.reconnectAttempt} onRetry={console_.retryNow} />
      {pendingRequests.length > 0 ? (
        <Banner tone="accent" assertive data-testid="pending-request-banner">
          <BannerText>{pendingRequests.length} request waiting — Review</BannerText>
          <BannerActions><Button type="button" onClick={() => document.querySelector<HTMLElement>('[data-slot="request-card"]')?.focus()}>Review</Button></BannerActions>
        </Banner>
      ) : null}
      <Composer
        state={console_.composer}
        value={draft}
        onValueChange={setDraft}
        onSubmit={submit}
        onStop={() => void console_.interrupt()}
        disabledReason={viewingChild
          ? "Direct steering of child threads is not supported by this app-server."
          : null}
      />
    </div>
  );
  const sessionRail = (
    <>
      <ManifestList manifests={console_.manifests} selectedId={console_.selectedManifestId} onSelect={console_.selectManifest} onRun={runManifest} lastOutcome={outcomes} disabled={console_.busy} />
      <ConnectionBlock connection={console_.connection} reconnectAttempt={console_.reconnectAttempt} state={console_.state} pendingRequestCount={pendingRequests.length} onDrop={console_.dropConnection} onRetry={console_.retryNow} onScrollToOldestRequest={() => document.querySelector<HTMLElement>('[data-slot="request-card"]')?.focus()} />
      <GoalBlock state={console_.state} onGoal={(operation, body) => void console_.goal(operation, body)} />
      <LineageTree lineage={console_.state?.lineage ?? []} selectedThreadId={console_.selectedThreadId} onSelect={console_.selectThread} />
      <section data-slot="observation-checklist" className="pcr-panel">
        <h2 className="pcr-panel-title">Demo state</h2>
        <Button type="button" variant="ghost" onClick={() => setResetOpen(true)}>Reset demo state</Button>
        {activeManifest === undefined ? null : (
          <ol className="pcr-observation-list" data-testid="observation-checklist">
            {activeManifest.expectedObservations.map((observation) => (
              <li key={observation}>
                <label><input type="checkbox" /> {observation}</label>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
  const inspector = (
    <Inspector events={console_.events} snapshot={console_.snapshot} state={console_.state} connection={console_.connection} reconnectAttempt={console_.reconnectAttempt} replayParity={console_.replayParity} highlightItemId={highlightItemId} onHighlightItem={setHighlightItemId} />
  );

  return (
    <div className="pcr-root pcr-console" data-slot="runner-console-app" data-inspector={inspectorOpen}>
      <header className="pcr-console-header">
        <div className="pcr-console-title">
          {console_.replay.active ? <Badge tone="warning" data-testid="replay-badge">REPLAY</Badge> : null}
          <h1>{activeManifest?.name ?? "Runner reference console"}</h1>
          {viewingChild ? (
            <p className="pcr-breadcrumb" data-testid="breadcrumb">
              root ▸ {console_.selectedThreadId}
            </p>
          ) : null}
        </div>
        <div className="pcr-console-header-actions">
          <Button type="button" variant="ghost" data-testid="toggle-inspector" aria-pressed={inspectorOpen} onClick={() => setInspectorOpen((current) => !current)}>Protocol inspector</Button>
          <Button type="button" variant="ghost" data-testid="toggle-replay" aria-pressed={console_.replay.active} disabled={console_.events.length === 0} onClick={() => console_.replay.active ? console_.replay.exit() : console_.replay.enter()}>{console_.replay.active ? "Exit replay" : "Replay"}</Button>
        </div>
      </header>
      <p className="pcr-visually-hidden" aria-live="polite" data-testid="runner-announcement">{console_.announcement}</p>
      {console_.error === null ? null : <Banner tone="danger" assertive><BannerText>{console_.error}</BannerText></Banner>}
      {console_.replay.active ? <ReplayControls replay={console_.replay} /> : null}
      {compact ? (
        <div className="pcr-console-mobile">
          <Tabs items={MOBILE_SEGMENTS} selected={segment} onSelect={setSegment} label="Console sections">
            {segment === "chat" ? <>{transcript}{composer}</> : null}
            {segment === "session" ? sessionRail : null}
            {segment === "inspector" ? inspector : null}
          </Tabs>
        </div>
      ) : (
        <div className="pcr-console-desktop">
          <aside className="pcr-console-rail">{sessionRail}</aside>
          <main className="pcr-console-center">{transcript}{composer}</main>
          {inspectorOpen ? <aside className="pcr-console-inspector" aria-label="Protocol inspector">{inspector}</aside> : null}
        </div>
      )}
      <Dialog open={resetOpen} onClose={() => setResetOpen(false)} title="Reset demo state" description="Discards the current live session transcript. Recorded evidence files are not touched." footer={<><Button type="button" variant="ghost" onClick={() => setResetOpen(false)}>Keep the session</Button><Button type="button" variant="danger" data-testid="reset-confirm" onClick={() => { setResetOpen(false); setDraft(""); void console_.reset(); }}>Reset demo state</Button></>} />
    </div>
  );
}
