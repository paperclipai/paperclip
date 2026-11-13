type EvidenceSink = (name: string, value: unknown) => Promise<void>;
type CaptureSink = (id: string, label: string, file: string) => Promise<void>;

export async function emitContextIntegrityFinalEvidence(input: {
  evidence: EvidenceSink;
  capture: CaptureSink;
  issue: unknown;
  runs: unknown;
  checkpoints: unknown;
  checks: unknown;
  runEvents?: unknown;
  runLogs?: unknown;
}) {
  await input.evidence("api-state.json", {
    capturePhase: "final",
    issue: input.issue,
    runs: input.runs,
    checkpoints: input.checkpoints,
    checks: input.checks,
    runEvents: input.runEvents,
    runLogs: input.runLogs,
  });
  await input.capture("final-state", "Context integrity final state", "final-state.png");
}
