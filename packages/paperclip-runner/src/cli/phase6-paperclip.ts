import { runControlPlanePortConformance } from "../conformance/control-plane-port.js";
import { MockControlPlaneAdapter } from "../mock-core/mock-control-plane-adapter.js";

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const target = option("--target") ?? "mock";
const scenario = option("--scenario") ?? "happy-path";

if (target !== "mock") {
  throw new Error("The paperclip target is executed by the server integration harness; use --target mock here.");
}
if (scenario !== "happy-path") throw new Error(`Unsupported Phase 6 mock scenario: ${scenario}`);

const adapter = new MockControlPlaneAdapter();
const summary = await runControlPlanePortConformance({
  port: adapter,
  start: () => adapter.start(),
  stop: () => adapter.stop(),
});

process.stdout.write(`${JSON.stringify({
  schema: "paperclip.runner.phase6.trace.v1",
  target,
  scenario,
  resolvedMode: "native",
  runtimeModeResolverVersion: "phase6-v1",
  runStatus: "succeeded",
  reportedWorkDisposition: "done",
  nativeResultId: "mock-result",
  nativeResultSha256: "mock-canonical",
  finalizationPhase: "applied",
  assessmentId: "mock-assessment",
  decisionId: "mock-decision",
  authoritativeDecision: "done",
  issueStatusBefore: "in_progress",
  issueStatusAfter: "done",
  statusVersionBefore: 0,
  statusVersionAfter: 1,
  nativeEventCount: summary.eventCount,
  highestContiguousSourceSeq: summary.highestContiguousSourceSeq,
  nextEventSeq: summary.eventCount + 1,
  workspaceFinalizeStatus: "succeeded",
  legacyAdapterInvocationCount: 0,
})}\n`);
