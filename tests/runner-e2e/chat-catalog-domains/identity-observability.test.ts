import { describe, expect, it, vi } from "vitest";
import { gradeObservability } from "./identity-observability.js";
vi.mock("../chat-flow.js", () => ({ sendChatMessage: vi.fn() }));
import type { IdentityObservation } from "./identity-support.js";
function valid(): IdentityObservation { return { scenarioId: "companies.agent-observability", origin: "http://fixture.invalid", companyId: "acorn", leadId: "ceo", company: { id: "acorn" }, companies: [], agents: [], tasks: [], projects: [], goals: [], comments: [], interactions: [], documents: [], revisions: [], activity: [], links: [], humanQueries: [],
  reply: "Configure optional trace export in company settings. First-party Telemetry and the local run log are separate data paths.",
  runs: [1, 2, 3].map(n => ({ id: `run-${n}`, companyId: "acorn", agentId: "ceo", status: "succeeded", runtimeMode: "native" })),
  state: { beforeSettings: null, afterReplySettings: null, beforeConfiguredCalls: 0, agentWriteStatus: 403, collectorUrl: "http://127.0.0.1:1234", publicSettingsContainsKey: false,
    saved: { settings: { companyId: "acorn", enabled: true, revision: "revision", destination: { provider: "otlp", endpointBaseUrl: "http://127.0.0.1:1234" }, headerNames: ["authorization"], credentialsConfigured: true } },
    testReceipt: { status: "accepted", source: "control_plane", revision: "revision", signals: { logs: { status: "accepted" }, traces: { status: "accepted" } } }, collectorMatchedTestSignals: 2,
    nativeExportMatched: true, enabledNativeRunCount: 2, disabledSaved: true, disabledNativeRunCount: 3, callsAtDisable: 7, callsAfterDisabledRun: 7, disabledCallsDidNotIncrease: true } }; }
describe("actual optional agent trace delivery", () => {
  it("requires enabled human configuration, actual native export and disabled subsequent execution", () => { expect(gradeObservability(valid()).passed).toBe(true); expect(gradeObservability(undefined).passed).toBe(false); });
  it("rejects a successful settings save without collector marker matches", () => { const o = valid(); o.state.collectorMatchedTestSignals = 0; expect(gradeObservability(o).passed).toBe(false); });
  it("rejects control-plane sample delivery alone as proof of coding-agent export", () => { const o = valid(); o.state.nativeExportMatched = false; expect(gradeObservability(o).passed).toBe(false); });
  it("rejects export continuing on the next actual run after disable", () => { const o = valid(); o.state.callsAfterDisabledRun = 8; expect(gradeObservability(o).passed).toBe(false); });
  it("rejects sending credentials through public settings or conflating Telemetry with run logs", () => { const o = valid(); o.state.publicSettingsContainsKey = true; expect(gradeObservability(o).passed).toBe(false); const silent = valid(); silent.reply = ""; expect(gradeObservability(silent).passed).toBe(false); });
  it("does not grade Telemetry or run-log wording; the collector receipts prove the export path", () => {
    for (const reply of ["The local run log is not what gets exported; only traces go to your collector.", "Telemetry and the run log aren't exported; only traces are."]) {
      const o = valid(); o.reply = reply; expect(gradeObservability(o).passed, reply).toBe(true);
    }
    const leaked = valid(); leaked.state.publicSettingsContainsKey = true; expect(gradeObservability(leaked).passed).toBe(false);
  });

  it("does not require the reply to name Telemetry or the run log when the query did not ask", () => { const o = valid(); o.reply = "Trace export is a board-only setting: a board user sets the collector URL in company settings, enables export and sends a test trace."; expect(gradeObservability(o).passed).toBe(true); const runLog = valid(); runLog.reply = "The local run log is not what gets exported; only traces go to your collector."; expect(gradeObservability(runLog).passed).toBe(true); });
});
