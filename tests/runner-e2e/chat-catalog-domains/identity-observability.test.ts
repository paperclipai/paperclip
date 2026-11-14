import { describe, expect, it, vi } from "vitest";
import { gradeObservability, readSavedObservabilityStatus } from "./identity-observability.js";
import { savedCall } from "./api-read-receipts.test-fixtures.js";
vi.mock("../chat-flow.js", () => ({ sendChatMessage: vi.fn() }));
import type { IdentityObservation } from "./identity-support.js";
function valid(): IdentityObservation { return { scenarioId: "companies.agent-observability", origin: "http://fixture.invalid", companyId: "acorn", leadId: "ceo", company: { id: "acorn" }, companies: [], agents: [], tasks: [], projects: [], goals: [], comments: [], interactions: [], documents: [], revisions: [], activity: [], links: ["/ACO/company/settings"], humanQueries: [],
  reply: "Configure optional trace export in company settings. First-party Telemetry and the local run log are separate data paths.",
  runs: [1, 2, 3].map(n => ({ id: `run-${n}`, companyId: "acorn", agentId: "ceo", status: "succeeded", runtimeMode: "native" })),
  state: { beforeSettings: null, afterReplySettings: null, beforeConfiguredCalls: 0, agentWriteStatus: 403, collectorUrl: "http://127.0.0.1:1234", publicSettingsContainsKey: false,
    saved: { settings: { companyId: "acorn", enabled: true, revision: "revision", destination: { provider: "otlp", endpointBaseUrl: "http://127.0.0.1:1234" }, headerNames: ["authorization"], credentialsConfigured: true } },
    testReceipt: { status: "accepted", source: "control_plane", revision: "revision", signals: { logs: { status: "accepted" }, traces: { status: "accepted" } } }, collectorMatchedTestSignals: 2,
    nativeExportMatched: true, enabledNativeRunCount: 2, disabledSaved: true, disabledNativeRunCount: 3, callsAtDisable: 7, callsAfterDisabledRun: 7, disabledCallsDidNotIncrease: true,
    companyPrefix: "ACO", enabledTurnReadSavedStatus: true, disabledTurnReadSavedStatus: true } }; }
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

  // Calibration from cohort 3: the board saved and tested the collector, yet the agent checked only its
  // own config and secrets and replied that nothing was configured. Graded by saved-state reads and the
  // rendered settings link, never by the reply's wording.
  it("passes truthful acknowledgements grounded in reads of the saved status, however they are worded", () => {
    for (const links of [["/ACO/company/settings"], ["/ACO/company/settings/"], ["http://fixture.invalid/ACO/company/settings#agent-observability"]]) {
      const o = valid(); o.links = links; o.reply = "Saved: export is on with credentials, and the last test was accepted."; expect(gradeObservability(o).passed, links[0]).toBe(true);
    }
  });
  it("fails an acknowledgement turn that never read the saved settings", () => {
    for (const key of ["enabledTurnReadSavedStatus", "disabledTurnReadSavedStatus"]) {
      const o = valid(); o.state[key] = false;
      o.reply = "I checked the CEO's configuration and the company secrets: no collector endpoint or credentials are present.";
      const grade = gradeObservability(o);
      expect(grade.passed, key).toBe(false);
      expect(grade.checks.find(check => check.id === "acknowledgements-read-saved-settings")?.passed).toBe(false);
    }
  });
  it("fails a reply that never points to the company settings page, or links an unresolved or foreign one", () => {
    for (const links of [[], ["/%3Cprefix%3E/company/settings"], ["/BIR/company/settings"], ["/ACO/company/settings/secrets"], ["https://elsewhere.invalid/ACO/company/settings"]]) {
      const o = valid(); o.links = links; expect(gradeObservability(o).passed, String(links[0])).toBe(false);
    }
  });
  it("binds the saved-status read to this company by its redaction-safe receipt", () => {
    const status = (pathParams: Record<string, string>) => ({ operationId: "GET /api/companies/{companyId}/observability/status", pathParams });
    expect(readSavedObservabilityStatus(savedCall(status({ companyId: "acorn" }), 200), "acorn")).toBe(true);
    expect(readSavedObservabilityStatus(savedCall({ operationId: "GET /api/companies/{companyId}/observability/status" }, 200), "acorn")).toBe(true);
    expect(readSavedObservabilityStatus(savedCall(status({ companyId: "acorn" }), 403), "acorn")).toBe(false);
    expect(readSavedObservabilityStatus(savedCall(status({ companyId: "birch" }), 200), "acorn")).toBe(false);
    expect(readSavedObservabilityStatus(savedCall({ operationId: "GET /api/agents/{id}", pathParams: { id: "ceo" } }, 200), "acorn")).toBe(false);
  });
});
