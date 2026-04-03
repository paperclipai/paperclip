import type { TelemetryClient } from "./client.js";

export function trackInstallStarted(client: TelemetryClient): void {
  client.track("install.started");
}

export function trackInstallCompleted(
  client: TelemetryClient,
  dims: { adapterType: string },
): void {
  client.track("install.completed", { adapter_type: dims.adapterType });
}

export function trackCompanyImported(
  client: TelemetryClient,
  dims: { sourceType: string; sourceRef: string; isPrivate: boolean },
): void {
  const ref = dims.isPrivate ? client.hashPrivateRef(dims.sourceRef) : dims.sourceRef;
  client.track("company.imported", {
    source_type: dims.sourceType,
    source_ref: ref,
    source_ref_hashed: dims.isPrivate,
  });
}

export function trackAgentFirstHeartbeat(
  client: TelemetryClient,
  dims: { agentRole: string },
): void {
  client.track("agent.first_heartbeat", { agent_role: dims.agentRole });
}

export function trackAgentTaskCompleted(
  client: TelemetryClient,
  dims: { agentRole: string },
): void {
  client.track("agent.task_completed", { agent_role: dims.agentRole });
}

export function trackErrorHandlerCrash(
  client: TelemetryClient,
  dims: { errorCode: string },
): void {
  client.track("error.handler_crash", { error_code: dims.errorCode });
}
