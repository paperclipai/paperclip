export interface NativeRunIdentity {
  runId: string;
  sessionId: string;
  companyId: string;
  issueId: string;
  agentId: string;
}

export type NativeRunEventType = "run.started" | "run.completed";

export interface NativeRunEvent {
  eventId: string;
  runId: string;
  sequence: number;
  type: NativeRunEventType;
}

export type NativeRunStatus = "succeeded" | "failed" | "cancelled";

export interface NativeRunResult {
  runId: string;
  status: NativeRunStatus;
  summary: string;
}

export interface NativeSessionCapabilities {
  resume: boolean;
  typedEvents: boolean;
  typedEventFamilies?: TypedEventFamilyCapability[];
  steering: boolean;
  interruption: boolean;
  structuredResult: boolean;
  read?: boolean;
  reconciliation?: boolean;
  usage?: boolean;
  dynamicTools?: boolean;
  runtimeRequestResolution?: boolean;
  runtimeRequestHandoff?: boolean;
  goals?: boolean;
  threadLineage?: boolean;
  collaborationModes?: Array<"default" | "plan">;
  unsupported?: string[];
}

export interface NativeUserMessage {
  role: "user";
  text: string;
}
import type { TypedEventFamilyCapability } from "../provider-events.js";
