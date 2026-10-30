import { DEFAULT_AGENT_OBSERVABILITY_CAPTURE, type AgentObservabilitySettings, type AgentObservabilityTestReceipt } from "@paperclipai/shared";
export const companyId = "company-storybook";
export const configured: AgentObservabilitySettings = {
  companyId, revision: "10000000-0000-4000-8000-000000000001", enabled: true,
  destination: { provider: "braintrust", projectId: "20000000-0000-4000-8000-000000000001" },
  capture: { ...DEFAULT_AGENT_OBSERVABILITY_CAPTURE }, credentialsConfigured: true, headerNames: ["authorization"],
  updatedAt: "2026-10-19T12:00:00Z", lastTest: null,
};
export const custom: AgentObservabilitySettings = { ...configured, destination: { provider: "otlp", endpointBaseUrl: "https://collector.example.com/otel" }, headerNames: ["authorization", "x-team"] };
export const receipt: AgentObservabilityTestReceipt = {
  revision: configured.revision, marker: "paperclip-observability-test-storybook", source: "control_plane",
  startedAt: "2026-10-19T12:01:00Z", finishedAt: "2026-10-19T12:01:01Z", status: "accepted",
  signals: { logs: { status: "accepted", httpStatus: 200, rejectedRecords: 0, errorCode: null, message: null, durationMs: 125 },
    traces: { status: "accepted", httpStatus: 200, rejectedRecords: 0, errorCode: null, message: null, durationMs: 140 } },
};
export const failedReceipt: AgentObservabilityTestReceipt = { ...receipt, status: "failed", signals: {
  logs: { ...receipt.signals.logs, status: "failed", httpStatus: 403, errorCode: "receiver_rejected", message: "The receiver rejected the test records. Check credentials and destination routing." },
  traces: { ...receipt.signals.traces, status: "failed", httpStatus: 403, errorCode: "receiver_rejected", message: "The receiver rejected the test records. Check credentials and destination routing." },
} };
