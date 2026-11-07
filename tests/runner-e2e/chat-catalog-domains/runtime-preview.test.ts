import { it, expect } from "vitest";
import { gradePreview } from "./runtime-preview.js";
function valid() { const url = "http://127.0.0.1:43210/";
  return { scenarioId: "workspaces.preview-service", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { workspace: { id: "actual" }, task: { id: "website" }, marker: "Acorn marker", websiteBytes: "<html><h1>Acorn marker</h1></html>",
      initialHttpBody: "<html><h1>Acorn marker</h1></html>", initialHttpStatus: 200, browserPreviewVisible: true,
      healthyService: { id: "service", executionWorkspaceId: "actual", companyId: "company", status: "running", healthStatus: "healthy", serviceName: "Website preview", url },
      queryLinks: [url], previewProducts: [{ id: "preview", executionWorkspaceId: "actual", runtimeServiceId: "service", url, type: "preview_url", createdByRunId: "canonical" }],
      failureOperation: { id: "startup-failure", status: "failed", executionWorkspaceId: "actual", heartbeatRunId: "restart" },
      failureRunIds: ["restart"], failedHttpReachable: false, failureReply: "The preview restart failed because its server process exited. Inspect the startup error and repair it before starting again." },
    agents: [], tasks: [{ id: "website" }], links: [], activity: [], humanQueries: [], reply: "",
    runs: [{ id: "website-setup", agentId: "morgan", status: "succeeded" }, { id: "canonical", agentId: "ceo", status: "succeeded" }, { id: "restart", agentId: "ceo", status: "succeeded" }] }; }
it("accepts actual ready HTTP preview then a separately observed failed restart", () => expect(gradePreview(valid()).passed).toBe(true));
it("accepts natural actionable startup-failure reporting", () => { const o = valid(); o.state.failureReply = "The server process exited during startup, so I could not bring the preview back. Check its startup output and repair that error before another start."; expect(gradePreview(o).passed).toBe(true); });
it("rejects missing real preview evidence", () => expect(gradePreview(undefined).passed).toBe(false));
it("rejects a service record without HTTP content readiness", () => { const o = valid(); o.state.initialHttpStatus = 503; expect(gradePreview(o).passed).toBe(false); });
it("rejects serving another website's bytes", () => { const o = valid(); o.state.initialHttpBody = "Other website"; expect(gradePreview(o).passed).toBe(false); });
it("rejects a similarly named service from another workspace", () => { const o = valid(); o.state.healthyService.executionWorkspaceId = "other"; expect(gradePreview(o).passed).toBe(false); });
it("rejects a preview product from an unrelated run", () => { const o = valid(); o.state.previewProducts[0]!.createdByRunId = "foreign"; expect(gradePreview(o).passed).toBe(false); });
it("rejects claiming readiness after the actual startup failure", () => { const o = valid(); o.state.failureReply = "The preview is now ready."; expect(gradePreview(o).passed).toBe(false); });
it("rejects failure attributed to the initial healthy turn", () => { const o = valid(); o.state.failureOperation.heartbeatRunId = "canonical"; expect(gradePreview(o).passed).toBe(false); });
