import * as React from "react";
import { createRoot } from "react-dom/client";

import {
  runStandaloneStandaloneDemo,
  type StandaloneStandaloneDemoResult,
} from "@paperclipai/paperclip-runner/standalone";

import "./styles.css";

function App() {
  const [featureFlagEnabled, setFeatureFlagEnabled] = React.useState(false);
  const [killSwitchEnabled, setKillSwitchEnabled] = React.useState(false);
  const [result, setResult] = React.useState<StandaloneStandaloneDemoResult | null>(null);
  const [running, setRunning] = React.useState(false);

  const run = React.useCallback(async () => {
    setRunning(true);
    try {
      setResult(await runStandaloneStandaloneDemo({ featureFlagEnabled, killSwitchEnabled }));
    } finally {
      setRunning(false);
    }
  }, [featureFlagEnabled, killSwitchEnabled]);

  React.useEffect(() => { void run(); }, [run]);

  return (
    <main>
      <header>
        <p className="eyebrow">Package-local tracer</p>
        <h1>Standalone standalone adapter demo</h1>
        <p>No Paperclip instance, database, agent profile, or experimental setting is contacted or changed.</p>
      </header>

      <section className="controls" aria-label="Adapter controls">
        <label><input type="checkbox" checked={featureFlagEnabled} onChange={(event) => setFeatureFlagEnabled(event.target.checked)} /> Enable native demo flag</label>
        <label><input type="checkbox" checked={killSwitchEnabled} onChange={(event) => setKillSwitchEnabled(event.target.checked)} /> Enable kill switch</label>
        <button type="button" onClick={() => void run()} disabled={running}>{running ? "Running…" : "Run tracer"}</button>
      </section>

      {result === null ? null : (
        <>
          <section className={`mode mode-${result.resolvedMode}`}>
            <div><span>Resolved path</span><strong>{result.resolvedMode}</strong></div>
            <div><span>Reason</span><strong>{result.resolutionReason.replaceAll("_", " ")}</strong></div>
            <div><span>Adapter</span><strong>{result.adapter.replaceAll("_", " ")}</strong></div>
          </section>

          <section className="grid">
            <article><h2>Contract</h2><p>{result.conformance.eventCount} events; duplicate replay {result.conformance.duplicateDisposition}.</p><p>Mutated event and result replays are rejected.</p></article>
            <article><h2>Reducer</h2><p>{result.reducer.timelineCount} timeline entries; integrity {result.reducer.integrity}.</p><p>Terminal state: {result.reducer.runTerminalState}.</p></article>
            <article><h2>Finalization</h2><p>Result and terminal fact persisted idempotently.</p><p>Disposition: {result.finalization.reportedWorkDisposition}.</p></article>
            <article><h2>Rollback</h2><p>Native calls: {result.nativeAdapterInvocationCount}.</p><p>Legacy calls: {result.legacyAdapterInvocationCount}.</p></article>
          </section>

          <details><summary>Inspectable trace JSON</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>
        </>
      )}
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Standalone standalone demo root is missing.");
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
