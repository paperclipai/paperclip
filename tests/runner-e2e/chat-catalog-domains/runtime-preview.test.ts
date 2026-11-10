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
it("rejects a lead preview product that names another endpoint", () => { const o = valid(); o.state.previewProducts[0]!.url = "http://127.0.0.1:1/"; expect(gradePreview(o).passed).toBe(false); });
it("accepts a linked ready endpoint without an optional preview work product", () => { const o = valid(); o.state.previewProducts = []; expect(gradePreview(o).passed).toBe(true); });
it("rejects a reply that never links the ready endpoint", () => { const o = valid(); o.state.queryLinks = []; expect(gradePreview(o).passed).toBe(false); });
it("accepts an API-started failed restart attributed by the restart turn's window", () => { const o = valid(); (o.state.failureOperation as { heartbeatRunId: string | null }).heartbeatRunId = null; (o.state as Record<string, unknown>).failureOperationRunId = "restart"; expect(gradePreview(o).passed).toBe(true); });
it("rejects an unattributed failed operation", () => { const o = valid(); (o.state.failureOperation as { heartbeatRunId: string | null }).heartbeatRunId = null; expect(gradePreview(o).passed).toBe(false); });
it("rejects a restart turn that left no chat answer", () => { const o = valid(); o.state.failureReply = ""; expect(gradePreview(o).passed).toBe(false); });
it("rejects an endpoint that still answers after the supposed startup failure", () => { const o = valid(); o.state.failedHttpReachable = true; expect(gradePreview(o).passed).toBe(false); });
it("rejects a restart that never recorded a failed operation", () => { const o = valid(); o.state.failureOperation.status = "succeeded"; expect(gradePreview(o).passed).toBe(false); });
it("rejects failure attributed to the initial healthy turn", () => { const o = valid(); o.state.failureOperation.heartbeatRunId = "canonical"; expect(gradePreview(o).passed).toBe(false); });
it("accepts the ready origin linked with or without a trailing slash", () => { const o = valid(); o.state.healthyService.url = "http://127.0.0.1:43210"; expect(gradePreview(o).passed).toBe(true); o.state.queryLinks = ["http://127.0.0.1:43210"]; expect(gradePreview(o).passed).toBe(true); o.state.queryLinks = ["http://127.0.0.1:43211/"]; expect(gradePreview(o).passed).toBe(false); });
