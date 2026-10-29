import * as React from "react";
import { createRoot } from "react-dom/client";

import type {
  EventSourceLike,
  SessionItemSnapshot,
} from "@paperclipai/paperclip-runner/browser";
import {
  Composer,
  ConnectionBanner,
  Conversation,
  ReplayControls,
  RequestCard,
  useRunnerConsole,
} from "@paperclipai/paperclip-runner/react";
import "@paperclipai/paperclip-runner/styles.css";
import "./mini.css";

const injectedFetch: typeof fetch = (input, init) => window.fetch(input, init);
const injectedEventSource = (url: string): EventSourceLike => new window.EventSource(url);

function MiniConsumer() {
  // This pass-through wrapper is deliberate: the second consumer proves the
  // fifth extension point without adding provider credentials to component
  // props or browser state.
  const console_ = useRunnerConsole({
    baseUrl: "/api/liveConsole",
    fetchImpl: injectedFetch,
    eventSourceFactory: injectedEventSource,
  });
  const [draft, setDraft] = React.useState("");
  const requests = console_.transcript.filter((entry) => entry.kind === "request");
  const conversation = console_.transcript.filter((entry) => entry.kind !== "request");
  const customItemBody = (item: SessionItemSnapshot) => (
    <p className="pcr-mini-custom-body"><strong>Mini renderer:</strong> {item.text}</p>
  );

  function submit() {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft("");
    if (console_.composer === "active-turn") void console_.steer(text);
    else void console_.send(text);
  }

  return (
    <main className="pcr-root pcr-mini-theme" data-slot="mini-consumer" data-testid="mini-consumer">
      <header className="pcr-mini-header">
        <p className="pcr-eyebrow">Second public-API consumer</p>
        <h1>Runner mini consumer</h1>
        <span className="pcr-mini-theme-proof" data-testid="mini-token-override">Mini blue token theme</span>
        <select data-testid="mini-manifest" aria-label="Demo manifest" value={console_.selectedManifestId} onChange={(event) => console_.selectManifest(event.target.value)}>
          {console_.manifests.map((manifest) => <option key={manifest.id} value={manifest.id}>{manifest.name}</option>)}
        </select>
        <button data-testid="mini-start" type="button" onClick={() => { const manifest = console_.manifests.find((entry) => entry.id === console_.selectedManifestId); void console_.start({ manifestId: console_.selectedManifestId, message: manifest?.prompt ?? "Run the SDK flow." }); }}>Start selected flow</button>
      </header>
      <ConnectionBanner connection={console_.connection} reconnectAttempt={console_.reconnectAttempt} onRetry={console_.retryNow} />
      <Conversation entries={conversation} renderItemBody={customItemBody} />
      <ul className="pcr-mini-steering" aria-label="Steering acknowledgements">
        {console_.steeringChips.map((chip) => (
          <li key={chip.id} data-testid="mini-steering-chip" data-status={chip.status}>
            <strong>{chip.status}</strong> {chip.text}
          </li>
        ))}
      </ul>
      <ol className="pcr-mini-requests" aria-label="Runtime requests">
        {requests.map((request) => (
          <RequestCard key={request.key} request={request} onResolve={(resolution) => void console_.resolve(request.requestId, request.turnId ?? "", resolution)} renderRequestDetail={(current) => <pre className="pcr-payload">Mini detail: {JSON.stringify(current.details, null, 2)}</pre>} />
        ))}
      </ol>
      <Composer
        state={console_.composer}
        value={draft}
        onValueChange={setDraft}
        onSubmit={submit}
        onStop={() => void console_.interrupt()}
        leadingActions={<button data-testid="mini-goal-set" type="button" disabled={console_.state?.capabilities.goals !== true} onClick={() => void console_.goal("set", { objective: "Exercise the public SDK." })}>Set goal</button>}
        trailingActions={<button data-testid="mini-goal-clear" type="button" disabled={console_.state?.capabilities.goals !== true || console_.state.goal === null} onClick={() => void console_.goal("clear")}>Clear goal</button>}
      />
      <nav className="pcr-mini-actions" aria-label="SDK lifecycle controls">
        <button data-testid="mini-drop-connection" type="button" onClick={console_.dropConnection}>Drop connection</button>
        <button data-testid="mini-recover-gap" type="button" onClick={console_.retryNow}>Recover gap</button>
        <button data-testid="mini-toggle-replay" type="button" disabled={console_.events.length === 0} onClick={console_.replay.active ? console_.replay.exit : console_.replay.enter}>{console_.replay.active ? "Exit replay" : "Enter replay"}</button>
      </nav>
      <p data-testid="mini-goal-state">
        Goal: {console_.state?.goal?.objective ?? "none"}
      </p>
      {console_.replay.active ? <ReplayControls replay={console_.replay} /> : null}
      <p className="pcr-mini-parity" data-testid="mini-replay-parity">Replay parity: {console_.replayParity === null ? "waiting" : console_.replayParity ? "match" : "mismatch"}</p>
      <p className="pcr-visually-hidden" aria-live="polite" data-testid="mini-announcement">{console_.announcement}</p>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Mini consumer root is missing.");
createRoot(root).render(<React.StrictMode><MiniConsumer /></React.StrictMode>);
