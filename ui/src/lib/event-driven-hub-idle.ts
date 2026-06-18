import type { Issue } from "@paperclipai/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasEventDrivenParkMarker(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.eventDrivenHubIdle === true || value.eventDrivenPark === true) return true;
  if (value.kind === "event_driven_hub_idle" || value.kind === "event_driven_park") return true;
  if (value.type === "event_driven_hub_idle" || value.type === "event_driven_park") return true;
  return hasEventDrivenParkMarker(value.idlePath) || hasEventDrivenParkMarker(value.waitingPath);
}

export function hasEventDrivenHubIdlePath(issue: Pick<Issue, "status" | "executionPolicy" | "executionState">) {
  if (issue.status !== "in_progress") return false;
  return hasEventDrivenParkMarker(issue.executionPolicy) || hasEventDrivenParkMarker(issue.executionState);
}

export function hasEventDrivenHubIdleDetail(details: Record<string, unknown> | null | undefined) {
  if (!details) return false;
  if (details.skipReason === "issue has event-driven hub idle path") return true;
  if (details.reason === "issue has event-driven hub idle path") return true;
  if (typeof details.resolutionNote === "string" && details.resolutionNote.includes("event-driven hub idle path")) return true;
  return hasEventDrivenParkMarker(details) || hasEventDrivenParkMarker(details.executionPolicy) || hasEventDrivenParkMarker(details.executionState);
}
